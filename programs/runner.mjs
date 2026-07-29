// Fermentation programs RUNNER — ties the (tested) state machine to Home Assistant.
// Ticks every TICK_MINUTES: for each tank running a program, read program-state
// helpers + live sensors from HA, run tick(), and (if changed) write the setpoint
// + advance the phase. Config via env (NEVER git): HA_URL, HA_TOKEN,
// [TICK_MINUTES=5], [DRY_RUN=true to log-only, never write setpoints].
//
// HA state entities per tank (created by ha/glasshaus_programs.yaml):
//   input_select.tank_N_program        which preset (or 'None'/'Custom')
//   input_number.tank_N_program_phase  current phase index
//   input_datetime.tank_N_program_phase_started   phase start (for elapsed)
//   input_button.tank_N_confirm_crash  the crash-confirm gate
//   sensor.tank_N_program_status       (written by us: human status string + attrs)
import { PRESETS } from './presets.mjs';
import { tick, resolveStartPhase } from './statemachine.mjs';
import { computeDerived, updateStableClock } from './derived.mjs';
import { writeAllTankMetrics, vmGravitySlopePts, vmLastGravity } from './metrics.mjs';
import { smoothOffset, slewLimit, beerInBand } from './tiltcomp.mjs';
import { computeHealth } from './monitor.mjs';

const HA_URL = req('HA_URL');
const HA_TOKEN = req('HA_TOKEN');
// 5-min default: fermentation logic is slow (hours/days) so tighter buys nothing
// for the beer, but it keeps interactive moments (crash-confirm, program start)
// responsive — those act within one tick. Override via TICK_MINUTES env.
const TICK_MINUTES = Number(process.env.TICK_MINUTES || 5);
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const TANKS = (process.env.TANKS || 'tank_1,tank_2,tank_3').split(',').map((t) => t.trim());
// DEMO ONLY: multiply how fast each phase's clock runs. TIME_SCALE=3600 makes one
// phase-*hour* elapse in one real *second*, so a program with elapsed-based advances
// (and ramp everyHours steps) flows through its phases in seconds instead of days —
// for watching the machine drive setpoints live. 1 = real time (production default).
const TIME_SCALE = Math.max(1, Number(process.env.TIME_SCALE || 1));

function req(k) { const v = process.env[k]; if (!v) { console.error(`missing env ${k}`); process.exit(1); } return v; }
const H = { Authorization: `Bearer ${HA_TOKEN}`, 'content-type': 'application/json' };
const get = (p) => fetch(`${HA_URL}${p}`, { headers: H }).then((r) => r.json());

// Brewfather sidecar container. The HA Brewfather integration's batch object is
// thin (recipe = {name, fermentation} only — NO hop schedule, NO style), so for
// the truths that depend on the RECIPE — is this beer dry-hopped? what's the
// authoritative BF status? — we ask the brewfather container, which reads the
// full recipe. Optional: if BF_URL is unset we degrade gracefully (dryHop=false,
// no auto-flip). The container already caches 60s, so a per-tick call is cheap.
const BF_URL = (process.env.BF_URL || '').replace(/\/$/, '');
const _bfFactsCache = new Map();  // batchKey → { at, facts }  (short in-runner cache)
async function bfFacts(batchKey) {
  if (!BF_URL || !batchKey) return null;
  const hit = _bfFactsCache.get(batchKey);
  if (hit && Date.now() - hit.at < 55_000) return hit.facts;
  try {
    const r = await fetch(`${BF_URL}/batch/${encodeURIComponent(batchKey)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`brewfather HTTP ${r.status}`);
    const j = await r.json();
    const facts = {
      status: j.status ?? null,
      dryHop: !!j.dryHop,
      conditionDays: Number.isFinite(Number(j.conditionDays)) ? Number(j.conditionDays) : null,
      conditionSource: j.conditionSource ?? null,
      // display fields so the runner keeps computing once the batch leaves the
      // HA (Fermenting-only) feed — see the og fallback in deriveTank.
      og: Number.isFinite(Number(j.og)) ? Number(j.og) : null,
      fermentingStart: Number.isFinite(Number(j.fermentingStart)) ? Number(j.fermentingStart) : null,
    };
    _bfFactsCache.set(batchKey, { at: Date.now(), facts });
    return facts;
  } catch (e) {
    console.error(`[bf] facts fetch failed for ${batchKey}:`, e.message);
    return hit?.facts ?? null;   // fall back to a stale value if we have one
  }
}
const numOr = (v, d = null) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const usable = (s) => s != null && s !== 'unknown' && s !== 'unavailable' && s !== '';

async function callService(domain, service, data) {
  const r = await fetch(`${HA_URL}/api/services/${domain}/${service}`, {
    method: 'POST', headers: H, body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`${domain}.${service} HTTP ${r.status}`);
}

// Idle status object — published whenever a tank has no running program, so the
// program_status sensor can NEVER go stale and show a phantom phase (which made the
// card's phase label disagree with the live setpoint). The card reads this to decide
// whether to show a phase; program:'None' + phase:'none' means "no program running".
function idleStatus() {
  return { status: 'idle', program: 'None', phase: 'none', phaseIndex: 0,
    setpointF: null, awaitingConfirm: false, paused: false, done: false,
    note: 'no program running' };
}

async function tickTank(tankId, by) {
  const s = (id) => by[`${id}`]?.state;
  const programKey = s(`input_select.${tankId}_program`);
  if (!usable(programKey) || programKey === 'None') {
    adopted.delete(tankId);                 // no program → reset adopt guard
    // clear any phase-start anchors so a stale one can't leak into the NEXT program
    for (const k of phaseStartSetpoints.keys()) if (k.startsWith(`${tankId}:`)) phaseStartSetpoints.delete(k);
    // Publish idle so the status sensor reflects reality. Only write if it isn't
    // ALREADY idle, to avoid bumping last_updated every tick for an idle tank.
    if (s(`sensor.${tankId}_program_status`) !== 'idle') await writeStatus(tankId, idleStatus());
    return;
  }

  const program = resolveProgram(programKey, by, tankId);
  if (!program) { console.log(`[${tankId}] unknown program '${programKey}'`); return; }

  const phaseIndex = numOr(s(`input_number.${tankId}_program_phase`), 0);
  const phaseStartedIso = s(`input_datetime.${tankId}_program_phase_started`);
  // TIME_SCALE accelerates the phase clock for the live demo (see env def). At 1 it's
  // real elapsed hours; at 3600 one real second counts as one phase-hour.
  const phaseElapsedHours = phaseStartedIso
    ? ((Date.now() - Date.parse(phaseStartedIso)) / 3.6e6) * TIME_SCALE : 0;
  const currentSetpointF = numOr(by[`number.${tankId}_setpoint_raw`]?.state) != null
    ? numOr(by[`number.${tankId}_setpoint_raw`].state) / 10 : null;

  const confirmPressed = pendingConfirm.has(tankId);
  // PER-TANK control inputs published by deriveTank (which ran first this tick),
  // NOT the global Black sensors. deriveTank resolves each tank's OWN Tilt/batch, so
  // control keys off the right gravity/og/attenuation. If deriveTank hasn't published
  // (shouldn't happen — it runs first — but be safe), fall back to a stale/hold state.
  const ci = controlInputs.get(tankId) || { gravityStale: true };

  // phaseStartSetpointF = the setpoint when THIS phase (tank+index) began — the anchor
  // a ramp/coldCrash steps FROM. It MUST be captured fresh at phase entry and default
  // to the current setpoint, or a leftover value from a PREVIOUS program leaks in and a
  // cold crash steps the wrong direction (bug: a stale 75 made a 65→34 crash compute 70
  // going UP). Keyed by phase so re-entering phase 0 with a new program re-anchors.
  const psKey = `${tankId}:${phaseIndex}`;
  if (!phaseStartSetpoints.has(psKey)) {
    // first tick of this phase → anchor on the current setpoint (or the phase's own
    // start temp if the controller has no value yet)
    const program0 = resolveProgram(programKey, by, tankId);
    const anchor = currentSetpointF ?? program0?.phases?.[phaseIndex]?.tempF ?? null;
    phaseStartSetpoints.set(psKey, anchor);
    // drop any OLD phase keys for this tank so the Map can't accumulate stale anchors
    for (const k of phaseStartSetpoints.keys()) {
      if (k.startsWith(`${tankId}:`) && k !== psKey) phaseStartSetpoints.delete(k);
    }
  }

  const state = {
    phaseIndex, phaseElapsedHours, currentSetpointF,
    phaseStartSetpointF: numOr(phaseStartSetpoints.get(psKey), currentSetpointF),
    gravityStale: ci.gravityStale, confirmPressed,
    gravity: ci.gravity ?? null,
    expectedFg: ci.expectedFg ?? null,
    og: ci.og ?? null,
    apparentAttenuationPct: ci.attenuationPct ?? null,
    progressToFgPct: ci.progressToFgPct ?? null,
    gravity24hDeltaPts: ci.delta ?? null,
    // the assigned batch's strain expected attenuation (Brewfather yeast spec) —
    // drives the attenuationOfExpected advance type in Claude-generated plans.
    expectedAttenuationPct: expectedAttenuationFor(tankId, by),
  };

  // ADOPT an in-progress ferment: on a FRESH start (phase 0, just set) jump to the
  // phase the beer is actually in, so starting a program mid-fermentation doesn't
  // wrongly begin at pitch. Runs once per start (guarded by adopted set).
  if (phaseIndex === 0 && phaseElapsedHours < (TICK_MINUTES / 60) * 1.5 && !adopted.has(tankId)) {
    adopted.add(tankId);
    const startPhase = resolveStartPhase(program, state);
    if (startPhase > 0) {
      console.log(`[${tankId}] adopting in-progress ferment → start at phase ${startPhase} (${program.phases[startPhase].name})`);
      if (!DRY_RUN) {
        await callService('input_number', 'set_value',
          { entity_id: `input_number.${tankId}_program_phase`, value: startPhase });
        await callService('input_datetime', 'set_datetime',
          { entity_id: `input_datetime.${tankId}_program_phase_started`, datetime: nowIso() });
      }
      state.phaseIndex = startPhase;
      state.phaseElapsedHours = 0;
    }
  }

  const r = tick(program, state);
  const phase = program.phases[phaseIndex];
  const statusStr = r.done ? 'complete'
    : r.awaitingConfirm ? `awaiting crash confirm`
    : r.paused ? `paused (${r.note})`
    : `${phase?.name}: ${r.setpointF}°F`;

  // write program status entity (for app + notifications)
  await writeStatus(tankId, {
    program: program.label, phase: phase?.name ?? 'done', phaseIndex,
    setpointF: r.setpointF, awaitingConfirm: !!r.awaitingConfirm, paused: !!r.paused,
    done: !!r.done, note: r.note, status: statusStr,
  });

  if (r.done) { console.log(`[${tankId}] program complete`); return; }

  // ── TILT-COMPENSATED SETPOINT (fail-safe against Tilt loss) ────────────────
  // The ITC-308 controls off ITS thermowell probe. On a shallow fill the probe reads
  // off vs the actual beer (the Tilt, floating IN the liquid, is truer). In 'Tilt'
  // mode we shift the commanded setpoint by (probe − tilt) so the 308 holds the BEER
  // at target. E.g. want 68°F, probe 2°F below Tilt → command 70°F.
  //
  // THE FAILURE MODE THIS GUARDS: if the Tilt goes unresponsive/flaps (Black does),
  // naively snapping back to the raw probe setpoint would OVERSHOOT the beer (the probe
  // was reading cold) AND oscillate on every flap. So instead the offset is a slow,
  // persisted value that RIDES THROUGH outages:
  //   • Tilt fresh          → recompute offset, persist it (input_number.tank_N_temp_offset).
  //   • Tilt lost < GRACE    → HOLD the last-good offset (flap-proof; beer barely drifts).
  //   • Tilt lost > GRACE    → DECAY the held offset toward 0 over DECAY_H, and flag it,
  //                            so control returns to the probe GRADUALLY, never a snap.
  //   • never had an offset  → plain probe (no harm).
  const OFFSET_CAP_F = 7;          // hard clamp on the applied offset. Raised 4→7: the real
                                  // probe-vs-beer stratification gap measured ~5-6°F (Thermapen
                                  // vs thermowell), so ±4 under-corrected. ±7 lets the live
                                  // self-calibrating (probe−Tilt) offset fully apply while still
                                  // bounding a bad reading from running cooling away.
  const GRACE_MIN = 45;            // Tilt may vanish this long with NO change (flap-proof)
  const DECAY_H = 4;               // after grace, unwind the held offset to 0 over this long
  // SMOOTHING (anti-hunting): the probe is fast+noisy, the Tilt is slow+lagged, so the raw
  // per-tick offset jitters and makes the ITC-308 chase itself. EMA-smooth the offset + slew-
  // limit the setpoint. Both damping-only (can't run the beer away). Env-tunable.
  const EMA_ALPHA = Math.min(1, Math.max(0.05, Number(process.env.TILT_EMA_ALPHA || 0.3)));  // small = smoother
  const MAX_SLEW_F = Math.max(0.1, Number(process.env.TILT_MAX_SLEW_F || 0.5));              // °F/tick cap
  // TARGET DEADBAND: when the beer is within ±BAND_F of target, FREEZE the offset (stop chasing)
  // — this is what actually kills the ±2°F limit cycle. Wider band = calmer but looser hold.
  const BAND_F = Math.max(0.2, Number(process.env.TILT_DEADBAND_F || 0.6));
  // FAR-OFF threshold: beyond ±FAR_OFF_F from target, correct at FULL strength (raw offset, no
  // EMA/slew throttle) so a real error (beer stuck 2°F cold) recovers fast instead of crawling.
  const FAR_OFF_F = Math.max(BAND_F + 0.3, Number(process.env.TILT_FAR_OFF_F || 1.5));
  let commandF = r.setpointF;
  let tiltCtl = 'probe';           // for the status entity: probe | tilt | held | decaying
  const tempSource = (s(`input_select.${tankId}_temp_source`) || 'Probe');
  if (commandF != null && /tilt/i.test(tempSource)) {
    const probeF = numOr(s(`sensor.${tankId}_probe_temp`));
    const tiltF = ci.beerTempF ?? null;
    const tiltAgeMin = ci.beerTempAgeMin ?? null;
    const tiltFresh = tiltF != null && (tiltAgeMin == null || tiltAgeMin <= 30);
    const prevOffset = numOr(s(`input_number.${tankId}_temp_offset`));  // persisted last-good
    const clamp = (o) => Math.max(-OFFSET_CAP_F, Math.min(OFFSET_CAP_F, o));

    let offset = null;
    let farOff = false;   // beer is meaningfully off target → correct FAST (no damping throttle)
    if (probeF != null && tiltF != null && tiltFresh) {
      // ASYMMETRIC control by how far the beer is from target — damping must NOT throttle a real
      // recovery (the bug: beer stuck at 64 wanting 66 while EMA+slew let the setpoint only crawl
      // up 0.2°/tick). Three regimes:
      //   • IN-BAND (|beer−target| ≤ BAND_F):   FREEZE offset — kills the lagged-feedback swing.
      //   • NEAR    (BAND_F < err ≤ FAR_OFF_F): EMA-smooth + slew — gentle, damped correction.
      //   • FAR     (err > FAR_OFF_F):          use RAW offset, NO slew cap — get the beer back now.
      const targetF = r.setpointF;                       // the program's intended BEER temp
      const err = Math.abs(tiltF - targetF);
      const raw = clamp(probeF - tiltF);
      if (beerInBand(tiltF, targetF, BAND_F) && prevOffset != null) {
        offset = clamp(prevOffset);                      // hold — do NOT chase
        tiltCtl = 'tilt';
        console.log(`[${tankId}] beer ${tiltF} within ±${BAND_F} of target ${targetF} — HOLDING offset ${offset.toFixed(2)} (no chase)`);
      } else if (err > FAR_OFF_F || prevOffset == null) {
        // FAR from target → apply the full raw offset immediately; don't EMA-throttle a real error.
        offset = raw;
        farOff = true;
        tiltCtl = 'tilt';
        console.log(`[${tankId}] beer ${tiltF} FAR off target ${targetF} (err ${err.toFixed(1)}>${FAR_OFF_F}) — FULL correct: offset=${offset.toFixed(2)} (no EMA/slew)`);
      } else {
        // NEAR (just outside band) → gentle EMA-smoothed correction + slew (below).
        offset = clamp(smoothOffset(raw, prevOffset, EMA_ALPHA));
        tiltCtl = 'tilt';
        console.log(`[${tankId}] beer ${tiltF} near-target ${targetF} (err ${err.toFixed(1)}) — gentle correct: raw=${raw.toFixed(1)} ema=${offset.toFixed(2)}`);
      }
      // persist the offset (survives restarts + Tilt gaps). Only write past the deadband so we
      // don't bump the helper every tick for sub-0.1° drift.
      if (!DRY_RUN && (prevOffset == null || Math.abs(offset - prevOffset) >= 0.1)) {
        await callService('input_number', 'set_value',
          { entity_id: `input_number.${tankId}_temp_offset`, value: Math.round(offset * 10) / 10 });
      }
    } else if (prevOffset != null) {
      // Tilt not usable → decide HOLD vs DECAY based on how long it's been gone.
      const gapMin = tiltAgeMin ?? 9999;
      if (gapMin <= GRACE_MIN) {
        offset = clamp(prevOffset); tiltCtl = 'held';
        console.warn(`[${tankId}] Tilt stale ${Math.round(gapMin)}m (<${GRACE_MIN}m grace) — HOLDING offset ${offset.toFixed(1)}°F`);
      } else {
        // linear decay of the held offset toward 0 over DECAY_H past the grace window
        const past = (gapMin - GRACE_MIN) / 60;            // hours past grace
        const f = Math.max(0, 1 - past / DECAY_H);
        offset = clamp(prevOffset * f); tiltCtl = 'decaying';
        console.warn(`[${tankId}] ⚠ Tilt lost ${Math.round(gapMin)}m — DECAYING offset ${prevOffset.toFixed(1)}→${offset.toFixed(1)}°F (reverting to probe over ${DECAY_H}h)`);
        if (Math.abs(offset) < 0.1 && !DRY_RUN) {
          await callService('input_number', 'set_value', { entity_id: `input_number.${tankId}_temp_offset`, value: 0 });
        }
      }
    } else {
      console.log(`[${tankId}] temp_source=Tilt but no Tilt + no saved offset → plain probe ${r.setpointF}°F`);
    }

    if (offset != null && Math.abs(offset) >= 0.05) {
      const compensated = r.setpointF + offset;
      const clamped = program.clamp
        ? Math.max(program.clamp.minF, Math.min(program.clamp.maxF, compensated)) : compensated;
      // SLEW-LIMIT the commanded setpoint (NEAR-target only): the beer can't track a big instant
      // jump, so cap per-tick change to MAX_SLEW_F — ramps gently, no compressor slam/overshoot.
      // BUT when the beer is FAR off target, DON'T slew-throttle the recovery — command the full
      // correction now (the bug this fixes: beer stuck 2°F cold while the setpoint only crawled up).
      commandF = farOff ? clamped : slewLimit(clamped, currentSetpointF, MAX_SLEW_F);
      console.log(`[${tankId}] tilt-ctl(${tiltCtl}): probe=${probeF} tilt=${tiltF} off=${offset.toFixed(2)} → target ${r.setpointF}→ want ${clamped.toFixed(1)} → cmd ${commandF.toFixed(1)}°F${farOff ? ' [FAR — full]' : ` (slew ${MAX_SLEW_F}/tick)`}`);
    }
  }

  // surface the tilt-control MODE so the app + health notify can show/warn on it. 'held'
  // and 'decaying' mean the Tilt is unresponsive while this tank is in Tilt mode — the
  // very failure you flagged. 'decaying' publishes an ATTR the health platform pages on.
  tempCtlMode.set(tankId, tiltCtl);
  if (!DRY_RUN && (tiltCtl === 'held' || tiltCtl === 'decaying')) {
    // write a small flag entity so glasshaus_health can raise a warning ("Tank N: Tilt lost,
    // temp control holding/reverting to probe") — you find out BEFORE the beer drifts.
    await callService('input_text', 'set_value',
      { entity_id: `input_text.${tankId}_temp_ctl_note`,
        value: `${tiltCtl}: Tilt unresponsive, ${tiltCtl === 'held' ? 'holding offset' : 'reverting to probe'}` })
      .catch(() => {});
  } else if (!DRY_RUN && tiltCtl === 'tilt') {
    await callService('input_text', 'set_value', { entity_id: `input_text.${tankId}_temp_ctl_note`, value: '' }).catch(() => {});
  }

  // write the setpoint if it changed meaningfully (and not dry-run)
  if (commandF != null && (currentSetpointF == null || Math.abs(commandF - currentSetpointF) >= 0.1)) {
    console.log(`[${tankId}] setpoint ${currentSetpointF}→${commandF}°F (${r.note})${DRY_RUN ? ' [DRY_RUN]' : ''}`);
    if (!DRY_RUN) {
      await callService('number', 'set_value',
        { entity_id: `number.${tankId}_setpoint_raw`, value: Math.round(commandF * 10) });
    }
  }

  // advance phase
  if (r.advanceTo != null) {
    console.log(`[${tankId}] advance phase ${phaseIndex}→${r.advanceTo}`);
    // Anchor the NEXT phase on where we ended this one (its ramp/crash steps from here).
    // Keyed by (tank, next-index); the fresh-phase block above will find it already set.
    phaseStartSetpoints.set(`${tankId}:${r.advanceTo}`, r.setpointF ?? currentSetpointF);
    if (!DRY_RUN) {
      await callService('input_number', 'set_value',
        { entity_id: `input_number.${tankId}_program_phase`, value: r.advanceTo });
      await callService('input_datetime', 'set_datetime',
        { entity_id: `input_datetime.${tankId}_program_phase_started`, datetime: nowIso() });
    }
    pendingConfirm.delete(tankId); // consumed
  }
}

function resolveProgram(key, by, tankId) {
  const map = { 'Ale — free-rise + D-rest': 'ale', 'Lager — Brülosophy fast': 'lager_fast',
    'Lager — modern (ale-temp)': 'lager_modern', 'Kveik — warm & fast': 'kveik',
    'Cold crash only': 'coldcrash' };
  if (PRESETS[key]) return PRESETS[key];
  if (map[key]) return PRESETS[map[key]];
  // A Claude-GENERATED (or hand-edited) plan lives in the ATTRIBUTES of
  // sensor.tank_N_program_plan (attr `plan`) — too big for input_text's 255 cap.
  // The editor writes it; the runner re-writes it each tick so it survives an HA
  // restart (POSTed sensor state alone doesn't). Same shape as a preset.
  if (key === 'Generated' || key === 'Custom') {
    const planObj = by[`sensor.${tankId}_program_plan`]?.attributes?.plan;
    return parsePlan(planObj);
  }
  return null;
}

/** The assigned batch's strain expected attenuation %. The HA Brewfather
 *  integration STRIPS recipe.yeasts, so we can't read it live here — instead it's
 *  baked into the generated plan at creation time (the container has full yeast
 *  data via complete=true) and read back from the running plan's `expectedAtten`.
 *  Returns null if no generated plan / not carried → attenuationOfExpected treats
 *  its pct as absolute. */
function expectedAttenuationFor(tankId, by) {
  const key = by[`input_select.${tankId}_program`]?.state;
  if (key !== 'Generated' && key !== 'Custom') return null;
  const plan = parsePlan(by[`sensor.${tankId}_program_plan`]?.attributes?.plan);
  return plan?.expectedAtten ?? null;
}

/** Parse + validate a stored plan (object from a sensor attribute, or a JSON
 *  string) into a program the engine accepts. Returns null (engine skips the tank)
 *  on anything malformed — never runs a bad plan. */
function parsePlan(raw) {
  if (!raw || raw === 'unknown' || raw === 'unavailable' || raw === '') return null;
  let p;
  if (typeof raw === 'object') p = raw;
  else { try { p = JSON.parse(raw); } catch { return null; } }
  if (!p || !Array.isArray(p.phases) || p.phases.length === 0) return null;
  const clamp = (p.clamp && Number.isFinite(p.clamp.minF) && Number.isFinite(p.clamp.maxF))
    ? { minF: p.clamp.minF, maxF: p.clamp.maxF }
    : { minF: 32, maxF: 75 }; // safe default if the plan omitted/mangled the clamp
  const KINDS = ['hold', 'ramp', 'wait', 'coldCrash'];
  // Defensive duration caps — a generated/custom plan must NOT be able to hold a tank
  // at a temp for absurd lengths (an LLM plan once specified a 500-hour cold hold).
  // A real conditioning hold is days; a cold crash is 2-5 days. Cap elapsed-gated
  // holds at 14 days and any explicit `hours`/crash window at ~5 days. This bounds the
  // damage from a bad plan regardless of what the model emitted.
  const MAX_HOLD_H = 14 * 24;   // 336h — a long-but-real conditioning hold
  const MAX_CRASH_H = 5 * 24;   // 120h — the longest a cold crash should ever take
  const capHours = (h, kind) => {
    if (!Number.isFinite(h)) return undefined;
    const cap = kind === 'coldCrash' ? MAX_CRASH_H : MAX_HOLD_H;
    return Math.min(h, cap);
  };
  const capAdvance = (adv, kind) => {
    if (!adv || typeof adv !== 'object') return adv || undefined;
    if (adv.type === 'elapsed' && Number.isFinite(adv.hours)) {
      return { ...adv, hours: capHours(adv.hours, kind) };
    }
    return adv;
  };
  const phases = p.phases.filter((ph) => ph && KINDS.includes(ph.kind)).map((ph) => ({
    name: String(ph.name || ph.kind),
    kind: ph.kind,
    tempF: Number.isFinite(ph.tempF) ? ph.tempF : undefined,
    targetF: Number.isFinite(ph.targetF) ? ph.targetF : undefined,
    stepF: Number.isFinite(ph.stepF) ? ph.stepF : undefined,
    everyHours: Number.isFinite(ph.everyHours) ? ph.everyHours : undefined,
    hours: capHours(ph.hours, ph.kind),
    advance: capAdvance(ph.advance, ph.kind),
    // ANY cold-crash phase is force-gated regardless of what the plan said — safety.
    requiresConfirm: ph.kind === 'coldCrash' ? true : !!ph.requiresConfirm,
  }));
  if (!phases.length) return null;
  const expectedAtten = Number.isFinite(p.expectedAtten) ? p.expectedAtten : null;
  return { label: String(p.label || 'Generated plan'), clamp, phases, expectedAtten, generated: true };
}

// track crash-confirm presses + per-phase start setpoints + adopt-once guard between ticks
const pendingConfirm = new Set();
const phaseStartSetpoints = new Map();
const adopted = new Set(); // tanks whose in-progress ferment we've already adopted this run

function nowIso() { return new Date().toISOString(); }
/** epoch ms → "YYYY-MM-DD HH:MM:SS" in the container's local TZ, for HA
 *  input_datetime.set_datetime (which wants local wall-clock, not ISO/UTC). */
function isoLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function writeStatus(tankId, obj) {
  await fetch(`${HA_URL}/api/states/sensor.${tankId}_program_status`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ state: obj.status.slice(0, 255), attributes: { friendly_name: `${tankId} program`, ...obj } }),
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// GENERIC per-tank DERIVED values + alerts (replaces the Black-only derived YAML).
// Read-only w.r.t. control — only computes + writes sensor.tank_N_derived. Never
// touches setpoints, so it cannot affect the safety-critical program path.
// ---------------------------------------------------------------------------
const gravWindow = new Map();   // tankId → [{t, sg}] rolling ~8h for the settling-proof peak
const latchState = new Map();   // tankId → { batchKey, latched } one-shot fermentation-started
// PER-TANK control inputs, resolved by deriveTank each tick and consumed by tickTank.
// Fixes the single-tank-era bug where tickTank read GLOBAL Black sensors
// (sensor.tilt_black_gravity, sensor.batch_og, sensor.apparent_attenuation) for
// EVERY tank — so all tanks' control keyed off tank_1's Black Tilt. Now each tank's
// control uses ITS OWN resolved gravity/og/attenuation (same values deriveTank
// already computes), so multi-tank control is correct and testable in isolation.
const controlInputs = new Map();   // tankId → { gravity, og, expectedFg, attenuationPct, progressToFgPct, delta, gravityStale }
const metricPoints = new Map();    // tankId → { tankId, tags, fields } for the per-tick VM write
const tempCtlMode = new Map();     // tankId → 'probe'|'tilt'|'held'|'decaying' (tilt-comp status)

// resolve a tank's live gravity/temp from its ASSIGNED Tilt color (generic — any color)
function tiltData(by, tiltColor) {
  if (!tiltColor || tiltColor.toLowerCase() === 'none') return { gravity: null, tempF: null, ageMin: null };
  const c = tiltColor.toLowerCase();
  const g = by[`sensor.tilt_${c}_gravity`];
  const tp = by[`sensor.tilt_${c}_temperature`];
  const gv = g && g.state !== 'unknown' && g.state !== 'unavailable' ? Number(g.state) : null;
  const ageMin = g?.last_updated ? (Date.now() - Date.parse(g.last_updated)) / 60000 : null;
  return { gravity: Number.isFinite(gv) ? gv : null,
    tempF: tp && tp.state !== 'unavailable' ? Number(tp.state) : null, ageMin };
}

// push a gravity sample into the tank's rolling window (kept 24h) and return the
// 8h MAX (settling-proof peak for the drop-from-peak metric).
function roll8hMax(tankId, sg) {
  if (sg == null) return null;
  const now = Date.now();
  const buf = gravWindow.get(tankId) || [];
  buf.push({ t: now, sg });
  const cutoff = now - 24 * 3600_000;                    // keep 24h so we can also slope it
  const kept = buf.filter((x) => x.t >= cutoff);
  gravWindow.set(tankId, kept);
  const last8h = kept.filter((x) => x.t >= now - 8 * 3600_000);
  return Math.max(...last8h.map((x) => x.sg));
}

// READ the current 8h peak WITHOUT pushing a sample — used during a held-gravity tick so
// a repeated last-good value can't create a phantom new peak. Falls back to the held value
// itself if the window is empty (fresh process during a dropout), so drop-from-peak is 0
// rather than null (honest: "no drop observed since we last had a live reading").
function peekRoll8hMax(tankId, fallbackSg) {
  const now = Date.now();
  const buf = (gravWindow.get(tankId) || []).filter((x) => x.t >= now - 8 * 3600_000);
  if (!buf.length) return fallbackSg ?? null;
  return Math.max(...buf.map((x) => x.sg));
}

// Self-computed 24h gravity slope in POINTS/day from the runner's own window —
// a fallback for when the HA statistics sensor is missing/stale (e.g. reads a
// truncated -0.0, or the per-color stat entity doesn't exist). Needs samples
// spanning enough time to be meaningful; returns null until the window fills.
function windowSlopePts(tankId) {
  const buf = gravWindow.get(tankId) || [];
  if (buf.length < 2) return null;
  const first = buf[0], last = buf[buf.length - 1];
  const days = (last.t - first.t) / 86_400_000;
  if (days < 0.25) return null;                          // <6h of data → not trustworthy yet
  return ((last.sg - first.sg) / days) * 1000;           // SG/day → pts/day
}

async function deriveTank(tankId, by) {
  const s = (id) => by[id]?.state;
  const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const usable = (v) => v != null && v !== 'unknown' && v !== 'unavailable' && v !== '';

  const tiltSel = s(`input_select.${tankId}_tilt`);
  const { gravity, tempF, ageMin } = tiltData(by, tiltSel);

  // ── DISPLAY-ONLY last-good gravity HOLD (weak-BLE flap mitigation) ──────────
  // Orange (tank_3) has a marginal signal (~RSSI -81) and drops out for stretches.
  // When that happens the live `gravity` is null/stale, so every derived metric that
  // needs a CURRENT gravity (attenuation, drop-from-peak, progress) blanks and the
  // card looks broken — even though we KNOW roughly where the beer is. So for the
  // DISPLAY derivation only, hold the last-good gravity from VM (≤ HOLD_MAX_MIN old).
  // CONTROL never sees this — it keeps the strict `gravityStale` gate below — and
  // METRICS still write only the real live reading (never the held value), so the
  // stored curve stays honest. The card shows the held value flagged as `gravityHeld`.
  const HOLD_MAX_MIN = 120;                    // hold up to 2h; older than that, honestly blank
  const gravityLive = gravity != null && (ageMin == null || ageMin <= 20);
  let dispGravity = gravity, dispGravityAgeMin = ageMin, gravityHeld = false;
  if (!gravityLive) {
    const held = await vmLastGravity(tankId, HOLD_MAX_MIN).catch(() => null);
    if (held) { dispGravity = held.sg; dispGravityAgeMin = held.ageMin; gravityHeld = true; }
  }
  // batch is now the Brewfather batch NUMBER stored as free text (input_text).
  // Treat empty / 'None' / 'unknown' (HA's default initial input_text value) as
  // unassigned. Match by number first, then name (back-compat with any old value).
  const rawBatch = s(`input_text.${tankId}_batch`);
  const batchSel = (rawBatch && !['', 'none', 'None', 'unknown', 'unavailable'].includes(rawBatch))
    ? rawBatch : null;
  const bfData = by['sensor.brewfather_all_batches_data']?.attributes?.data || [];
  const batch = batchSel
    ? bfData.find((b) => String(b.batchNo) === batchSel || b.name === batchSel) || null
    : null;
  // brewfather-container facts (dryHop, status, conditionDays + og/fermentingStart
  // fallbacks). Fetched here so og/start can fall back to it — the HA feed only
  // carries FERMENTING batches, so once a batch conditions the HA `batch` is null
  // and we'd otherwise lose og → stop computing terminal/conditioning entirely.
  const facts = batchSel ? await bfFacts(batchSel) : null;
  const og = batch?.measuredOg != null ? Number(batch.measuredOg)
    : (facts?.og != null ? facts.og : null);
  const fermentingStartMs = batch?.fermentingStart ? Date.parse(batch.fermentingStart)
    : (facts?.fermentingStart != null ? facts.fermentingStart : null);

  // Feed the DISPLAY gravity (live, or the held last-good) into the 8h-peak window so
  // drop-from-peak keeps computing through a dropout. The window only ADVANCES on live
  // readings (a repeated held value can't create a fake new peak); when held, we read the
  // existing peak without pushing a duplicate sample.
  const gravity8hMaxSg = gravityHeld
    ? roll8hMax(tankId, null) ?? peekRoll8hMax(tankId, dispGravity)
    : roll8hMax(tankId, gravity); // live push (also fills the 24h window)

  // 24h delta (pts/day), most-trustworthy source first:
  //  1) per-color Tilt stat sensor if it exists (sensor.tilt_<color>_gravity_24h_stat)
  //  2) the legacy un-prefixed Black stat / delta sensors (older HA setups)
  //  3) the runner's OWN window slope — robust to a missing/truncated HA stat
  //     (that "-0.0" bug where the statistics sensor rounds a slow drop to zero).
  const c = tiltSel?.toLowerCase();
  const statPerColor = num(s(`sensor.tilt_${c}_gravity_24h_stat`));   // SG/day, THIS color
  const statLegacy = num(s('sensor.tilt_gravity_24h_stat'));          // SG/day (un-prefixed = BLACK)
  const deltaLegacy = num(s('sensor.gravity_24h_delta'));             // already pts/day (BLACK)
  const own = windowSlopePts(tankId);                                 // pts/day, in-memory window
  // Delta source, most-trustworthy first. CRITICAL: the legacy un-prefixed sensors are the
  // BLACK Tilt's — they must ONLY be used when THIS tank IS Black. A non-Black tank (e.g.
  // Orange on tank_3) with no per-color stat was borrowing Black's delta → wrong velocity.
  // For non-Black, skip the legacy sensors and use our OWN per-tank slope. And when the
  // IN-MEMORY window is too short (wiped on every container restart — why tank_3 velocity was
  // null), fall back to the DURABLE slope from VictoriaMetrics history (survives restarts).
  const isBlack = c === 'black';
  let delta;
  if (statPerColor != null) delta = statPerColor * 1000;              // this color's own stat
  else if (isBlack && statLegacy != null) delta = statLegacy * 1000;  // legacy = Black only
  else if (isBlack && deltaLegacy != null) delta = deltaLegacy;       // legacy = Black only
  else if (own != null) delta = own;                                  // per-tank in-memory slope
  else delta = await vmGravitySlopePts(tankId).catch(() => null);     // durable VM history slope
  // normalize -0 → 0 so downstream |delta|<1 flat-checks read cleanly
  if (delta === 0) delta = 0;

  // per-tank persisted state — HYDRATED from HA helpers so it survives an HA
  // reboot AND a container redeploy (in-memory alone dies on both). The helpers
  // (input_datetime.tank_N_stable_since, input_boolean.tank_N_fermentation_started,
  // input_text.tank_N_state_batchkey) are written each tick below; HA restores them.
  const batchKey = batchSel || 'none';
  const storedKey = s(`input_text.${tankId}_state_batchkey`);
  // if the stored state belongs to a DIFFERENT batch, it's stale → start fresh.
  const sameBatch = storedKey === batchKey;
  const hydratedLatch = sameBatch && s(`input_boolean.${tankId}_fermentation_started`) === 'on';
  const stableSinceState = s(`input_datetime.${tankId}_stable_since`);
  const hydratedStableMs = sameBatch && usable(stableSinceState) && stableSinceState !== 'unknown'
    ? Date.parse(stableSinceState.replace(' ', 'T')) : null;

  let st = latchState.get(tankId);
  if (!st || st.batchKey !== batchKey) {
    // first sight of this batch this process → seed from the HA-persisted values
    st = { batchKey, latched: hydratedLatch, stableSinceMs: Number.isFinite(hydratedStableMs) ? hydratedStableMs : null };
    latchState.set(tankId, st);
  }
  const prevLatched = st.latched;

  // is this batch dry-hopped? Ask the brewfather container, which reads the REAL
  // recipe hop schedule (use: "Dry Hop"). The HA integration's recipe object has no
  // hops, so the old name-regex was the only signal and it false-fired on any batch
  // named "...pale..." — real truth is worth the (cached) sidecar call. Raises the
  // terminal-confirmation window to 6d for hop creep. Null facts (BF_URL unset or
  // fetch failed) → dryHop:false, so we never HOLD a beer we can't verify.
  // (facts is fetched once, earlier, right after batch resolution.)
  const dryHopped = !!facts?.dryHop;

  // Signals that suppress false "temp excursion"/"stalled" alerts while the program is
  // actively driving the temp (see computeDerived): (1) how long since the setpoint
  // last CHANGED — the beer can't track a stepped setpoint instantly; (2) whether the
  // current program phase is a cold crash — cold halts fermentation on purpose.
  const spEnt = by[`number.${tankId}_setpoint_raw`] || by[`sensor.${tankId}_setpoint`];
  const spChangedIso = spEnt?.last_changed || spEnt?.last_updated;
  const setpointChangedMinAgo = spChangedIso ? (Date.now() - Date.parse(spChangedIso)) / 60000 : null;
  const progKey = by[`input_select.${tankId}_program`]?.state;
  const prog = (progKey && progKey !== 'None') ? resolveProgram(progKey, by, tankId) : null;
  const phIdx = numOr(s(`input_number.${tankId}_program_phase`), 0);
  const inCrash = prog?.phases?.[phIdx]?.kind === 'coldCrash';

  const d = computeDerived({
    // DISPLAY gravity: live when fresh, else the VM-held last-good (weak-BLE hold). Keeps
    // attenuation/drop/progress populated through an Orange dropout instead of blanking.
    gravity: dispGravity, og,
    expectedFg: num(s(`input_number.${tankId}_expected_fg`)),
    beerTempF: tempF,
    probeTempF: num(s(`sensor.${tankId}_probe_temp`)),
    setpointF: num(s(`sensor.${tankId}_setpoint`)),
    gravity24hDeltaPts: delta,
    gravity8hMaxSg,
    gravityAgeMin: dispGravityAgeMin,
    // TRUE live-signal age (independent of the display hold) so the "TILT SIGNAL LOST"
    // warning still fires honestly when the Tilt is actually flapping — the hold keeps the
    // NUMBERS on-screen, but we still tell you the signal dropped.
    liveGravityAgeMin: ageMin,
    gravityHeld,
    daysFermenting: fermentingStartMs ? (Date.now() - fermentingStartMs) / 86_400_000 : null,
    // min elapsed hours before velocity/ETA are trustworthy (early-batch suppression). Env override.
    minVelocityHours: Number(process.env.MIN_VELOCITY_HOURS || 12),
    // physical ceiling for gravity velocity (pts/day) — rejects garbage HA-stat rates on fresh
    // batches (e.g. -120 pts/day). No real ferment exceeds ~20 pts/day even at peak.
    maxVelocityPtsPerDay: Number(process.env.MAX_VELOCITY_PTS || 20),
    prevLatched,
    stableSinceMs: st.stableSinceMs,
    dryHopped,
    conditionDays: facts?.conditionDays ?? null,
    setpointChangedMinAgo,
    inCrash,
  }, Date.now());

  // A physically implausible gravity (computeDerived's gravitySuspect: SG below
  // water, or apparent attenuation > ~100.5%) means the Tilt isn't in the beer —
  // fallen sideways, in foam/CO₂, or lifted out. Treat it as "don't trust it" —
  // same as stale — so the state machine HOLDS instead of advancing a phase on
  // garbage. Better a paused program than one driven off a fallen hydrometer.
  if (d.gravitySuspect) {
    console.warn(`[${tankId}] gravity ${gravity} implausible (att ${d.attenuationPct}%) — holding, treating as stale`);
  }

  // publish THIS tank's resolved control inputs for tickTank (single source of truth
  // — no re-deriving off global sensors). gravityStale mirrors deriveTank's own
  // signal-lost gating: no gravity, a stale reading, or an implausible value means
  // "don't trust it".
  controlInputs.set(tankId, {
    gravity, og,
    expectedFg: num(s(`input_number.${tankId}_expected_fg`)),
    attenuationPct: d.attenuationPct ?? null,
    progressToFgPct: d.progressToFgPct ?? null,
    delta,
    gravityStale: gravity == null || (ageMin != null && ageMin > 20) || d.gravitySuspect,
    // Tilt beer temp + freshness — for the tilt-compensated setpoint (tickTank). ageMin is
    // the gravity sensor's age, a good proxy for whether the Tilt is broadcasting at all.
    beerTempF: tempF ?? null,
    beerTempAgeMin: ageMin,
  });

  // METRICS: stash this tank's full point for the durable VM write (done once per tick,
  // after all tanks derive). Only tanks WITH a batch (og present) produce ferment metrics;
  // a batchless tank still logs its probe/setpoint under a batch="" tag so temp history
  // exists even between brews. Suspect gravity is omitted (don't poison the curve with a
  // fallen-Tilt reading). Labeled by batch so you can query one beer across its whole life.
  const batchTag = s(`input_text.${tankId}_batch`) || '';
  metricPoints.set(tankId, {
    tankId,
    tags: { batch: batchTag, tilt: (s(`input_select.${tankId}_tilt`) || '').toLowerCase(),
      status: s(`input_select.${tankId}_status`) || '' },
    fields: {
      ...(!d.gravitySuspect && gravity != null ? { gravity } : {}),
      ...(og != null ? { og } : {}),
      ...(num(s(`input_number.${tankId}_expected_fg`)) != null ? { expected_fg: num(s(`input_number.${tankId}_expected_fg`)) } : {}),
      ...(tempF != null ? { beer_temp_f: tempF } : {}),
      ...(num(s(`sensor.${tankId}_probe_temp`)) != null ? { probe_temp_f: num(s(`sensor.${tankId}_probe_temp`)) } : {}),
      ...(num(s(`sensor.${tankId}_setpoint`)) != null ? { setpoint_f: num(s(`sensor.${tankId}_setpoint`)) } : {}),
      // gravity-DERIVED fields are omitted while the display gravity is HELD (Tilt dropout) —
      // storing them would poison the durable curve with non-live duplicates. Only real,
      // live-gravity ticks write attenuation/progress/drop. Temp/setpoint always write.
      ...(!gravityHeld && d.attenuationPct != null ? { attenuation_pct: d.attenuationPct } : {}),
      ...(!gravityHeld && d.progressToFgPct != null ? { progress_to_fg_pct: d.progressToFgPct } : {}),
      ...(d.abv != null ? { abv: d.abv } : {}),
      ...(!gravityHeld && d.dropFromPeakPts != null ? { drop_from_peak_pts: d.dropFromPeakPts } : {}),
      ...(delta != null ? { gravity_24h_delta_pts: delta } : {}),
    },
  });

  // maintain state, and PERSIST any change to the HA helpers (survives reboots).
  const before = { latched: st.latched, stableSinceMs: st.stableSinceMs };
  if (d.fermentationStarted) st.latched = true;
  // STABILITY CLOCK with noise tolerance (see updateStableClock in derived.mjs). A single
  // non-stable tick must NOT reset a multi-day clock — a jittery Tilt reading (esp. the
  // Black Tilt's BLE flakiness) briefly breaks isStableNow and would zero accumulated
  // stability, so the beer never confirms terminal. The clock only resets after gravity is
  // continuously non-stable past a grace window. Pure + unit-tested in derived.test.mjs.
  const clock = updateStableClock(d.isStableNow, st, Date.now());
  st.stableSinceMs = clock.stableSinceMs;
  st.unstableSinceMs = clock.unstableSinceMs;

  // PERSIST state changes to the HA helpers. This is READ-ONLY w.r.t. the beer
  // (never touches setpoints), so it runs even in DRY_RUN — the whole point is the
  // clock survives reboots regardless of control mode.
  if (storedKey !== batchKey) {
    await callService('input_text', 'set_value', { entity_id: `input_text.${tankId}_state_batchkey`, value: batchKey }).catch(() => {});
  }
  if (st.latched !== before.latched || !sameBatch) {
    await callService('input_boolean', st.latched ? 'turn_on' : 'turn_off', { entity_id: `input_boolean.${tankId}_fermentation_started` }).catch(() => {});
  }
  if ((st.stableSinceMs !== before.stableSinceMs || !sameBatch) && st.stableSinceMs != null) {
    await callService('input_datetime', 'set_datetime', { entity_id: `input_datetime.${tankId}_stable_since`, datetime: isoLocal(st.stableSinceMs) }).catch(() => {});
  }
  // (HA input_datetime can't be nulled; when gravity leaves the stable band the
  //  sameBatch+isStableNow gates make the stored value ignored, so no clear needed.)

  // --- AUTO-ADVANCE Brewfather → Conditioning, once, on confirmed terminal -------
  // The intelligence is already in `terminalConfirmed`: it needs the full stability
  // WINDOW held (3d clean, 6d dry-hopped for hop creep), and the runner RESETS the
  // clock (stableSinceMs=null above) the moment gravity re-drops — so a hop-creep
  // secondary fermentation un-confirms terminal and this WON'T fire mid-creep.
  // Guards: fire only if BF says the batch is still 'Fermenting' (never touch a
  // Planning/Completed/Archived batch), and latch via input_boolean so it fires
  // exactly once per batch. The latch key follows the batch, so a NEW batch on this
  // tank starts un-latched. bfConditioned surfaces the note in the app.
  // The latch belongs to the CURRENT batch. If HA still holds a latch from a
  // previous batch (storedKey != batchKey handled below via sameBatch), clear it so
  // the new batch on this tank can flip on its own terminal.
  if (!sameBatch && s(`input_boolean.${tankId}_bf_conditioned`) === 'on') {
    await callService('input_boolean', 'turn_off', { entity_id: `input_boolean.${tankId}_bf_conditioned` }).catch(() => {});
  }
  const flipLatchOn = sameBatch && s(`input_boolean.${tankId}_bf_conditioned`) === 'on';
  // bfConditioned reflects the AUTHORITATIVE Brewfather status (Conditioning or
  // later), not just our latch — so the app's "✓ Conditioning" confirmation is
  // correct even if the HA latch helper isn't installed, and it follows a manual
  // BF change. The latch is only the re-fire guard.
  const CONDITIONED_OR_LATER = ['Conditioning', 'Completed', 'Archived'];
  let bfConditioned = flipLatchOn || (facts?.status ? CONDITIONED_OR_LATER.includes(facts.status) : false);
  if (d.terminalConfirmed && !flipLatchOn && BF_URL && batchSel && facts?.status === 'Fermenting') {
    try {
      const r = await fetch(`${BF_URL}/batch/${encodeURIComponent(batchSel)}/status`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'Conditioning' }), signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`brewfather status HTTP ${r.status}`);
      await callService('input_boolean', 'turn_on', { entity_id: `input_boolean.${tankId}_bf_conditioned` }).catch(() => {});
      _bfFactsCache.delete(batchSel);   // force a fresh status read next tick
      bfConditioned = true;
      console.log(`[${tankId}] batch ${batchSel}: terminal confirmed (${d.stableDays}d, dryHop=${dryHopped}) → advanced Brewfather to Conditioning`);
    } catch (e) {
      console.error(`[${tankId}] BF conditioning flip failed:`, e.message);
    }
  }
  // if this tank cleared its batch, drop the latch so the next batch can flip
  if (!batchSel && flipLatchOn) {
    await callService('input_boolean', 'turn_off', { entity_id: `input_boolean.${tankId}_bf_conditioned` }).catch(() => {});
    bfConditioned = false;
  }

  // write ONE generic per-tank entity the app + notifications read
  await fetch(`${HA_URL}/api/states/sensor.${tankId}_derived`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      state: d.alerts[0]?.label || (d.fermentationStarted ? 'fermenting' : 'nominal'),
      // expose the RESOLVED og (from BF batch OR the container fallback) so other
      // services (analyzer) don't re-resolve it off the Fermenting-only HA feed and
      // wrongly see null for a Conditioning batch → the intermittent "no OG" warning.
      attributes: { friendly_name: `${tankId} derived`, tank: tankId, ...d, og: og ?? null, dryHop: dryHopped, bfStatus: facts?.status ?? null, bfConditioned },
    }),
  }).catch((e) => console.error(`[${tankId}] derived write failed:`, e.message));

  // PERSIST the generated ferm plan across HA restarts: POSTed sensor STATE is lost
  // on an HA restart, but the runner re-writes it here every tick from the plan it
  // last saw (in-memory generatedPlans), so it comes back within one tick. The
  // editor's initial write seeds generatedPlans via the state we read this tick.
  const liveplan = by[`sensor.${tankId}_program_plan`]?.attributes?.plan;
  if (liveplan) generatedPlans.set(tankId, liveplan);           // remember what HA has
  const rememberedPlan = generatedPlans.get(tankId);
  if (rememberedPlan && !liveplan) {                            // HA lost it (restart) → restore
    await fetch(`${HA_URL}/api/states/sensor.${tankId}_program_plan`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ state: rememberedPlan.label || 'generated plan',
        attributes: { friendly_name: `${tankId} program plan`, tank: tankId, plan: rememberedPlan } }),
    }).catch(() => {});
  }
}
// in-memory mirror of each tank's generated plan (for HA-restart re-seeding)
const generatedPlans = new Map();

async function tickAll() {
  try {
    const states = await get('/api/states');
    const by = Object.fromEntries(states.map((e) => [e.entity_id, e]));
    // pick up crash-confirm button presses (input_button last_changed within this tick window)
    for (const t of TANKS) {
      const btn = by[`input_button.${t}_confirm_crash`];
      if (btn && Date.now() - Date.parse(btn.state || 0) < TICK_MINUTES * 60_000) pendingConfirm.add(t);
    }
    // GENERIC derived + alerts for every tank (read-only; separate from control)
    for (const t of TANKS) await deriveTank(t, by).catch((e) => console.error(`[${t}] derive:`, e.message));
    // DURABLE METRICS: push every tank's point (gravity/temps/setpoint/attenuation/abv) to
    // VictoriaMetrics so historical ferment data is ours + query-able forever. Best-effort —
    // never blocks control. One POST per tick (line protocol, batched).
    try {
      const pts = TANKS.map((t) => metricPoints.get(t)).filter(Boolean);
      const ok = await writeAllTankMetrics(pts);
      if (ok) console.log(`[metrics] wrote ${pts.length} tank point(s) to VM`);
    } catch (e) { console.error('[metrics] VM write failed:', e.message); }
    // program control (writes setpoints) — unchanged
    for (const t of TANKS) await tickTank(t, by);
    // OBSERVABILITY: plant/component health (infra staleness, disconnects, glycol).
    // Read-only; write sensor.glasshaus_health for the notify automation + app.
    await writeHealth(by).catch((e) => console.error('[health] write failed:', e.message));
  } catch (e) {
    console.error('[programs] tick failed:', e.message);
  }
}

async function writeHealth(by) {
  const { alerts, checkedCount } = computeHealth(by, Date.now(), TANKS);
  const worst = alerts[0]?.severity ?? null;
  // state summarizes at a glance: OK / N warnings / N critical
  const nCrit = alerts.filter((a) => a.severity === 'critical').length;
  const nWarn = alerts.filter((a) => a.severity === 'warning').length;
  const state = nCrit ? `${nCrit} critical` : nWarn ? `${nWarn} warning` : 'ok';
  await fetch(`${HA_URL}/api/states/sensor.glasshaus_health`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      state,
      attributes: {
        friendly_name: 'GlassHaus Health',
        // heartbeat: this timestamp advances every tick. An HA automation can watch
        // it going stale to detect the programs container itself being DEAD (a dead
        // container can't self-report — HA must catch that from the outside).
        heartbeat: new Date().toISOString(),
        worst, critical: nCrit, warnings: nWarn, checkedCount, alerts,
      },
    }),
  });
}

console.log(`[programs] runner up. tick every ${TICK_MINUTES}min. DRY_RUN=${DRY_RUN}. TIME_SCALE=${TIME_SCALE}x. tanks=${TANKS}`);
tickAll();
setInterval(tickAll, TICK_MINUTES * 60_000);
