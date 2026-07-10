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
import { computeDerived } from './derived.mjs';
import { computeHealth } from './monitor.mjs';

const HA_URL = req('HA_URL');
const HA_TOKEN = req('HA_TOKEN');
// 5-min default: fermentation logic is slow (hours/days) so tighter buys nothing
// for the beer, but it keeps interactive moments (crash-confirm, program start)
// responsive — those act within one tick. Override via TICK_MINUTES env.
const TICK_MINUTES = Number(process.env.TICK_MINUTES || 5);
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const TANKS = (process.env.TANKS || 'tank_1,tank_2,tank_3').split(',').map((t) => t.trim());

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

async function tickTank(tankId, by) {
  const s = (id) => by[`${id}`]?.state;
  const programKey = s(`input_select.${tankId}_program`);
  if (!usable(programKey) || programKey === 'None') { adopted.delete(tankId); return; } // no program → reset adopt guard

  const program = resolveProgram(programKey, by, tankId);
  if (!program) { console.log(`[${tankId}] unknown program '${programKey}'`); return; }

  const phaseIndex = numOr(s(`input_number.${tankId}_program_phase`), 0);
  const phaseStartedIso = s(`input_datetime.${tankId}_program_phase_started`);
  const phaseElapsedHours = phaseStartedIso
    ? (Date.now() - Date.parse(phaseStartedIso)) / 3.6e6 : 0;
  const currentSetpointF = numOr(by[`number.${tankId}_setpoint_raw`]?.state) != null
    ? numOr(by[`number.${tankId}_setpoint_raw`].state) / 10 : null;

  // gravity staleness: signal-lost sensor OR gravity age > threshold
  const gravityStale = by['binary_sensor.tilt_black_signal_lost']?.state === 'on';
  const confirmPressed = pendingConfirm.has(tankId);

  const state = {
    phaseIndex, phaseElapsedHours, currentSetpointF,
    phaseStartSetpointF: numOr(phaseStartSetpoints.get(tankId), currentSetpointF),
    gravityStale, confirmPressed,
    gravity: numOr(s('sensor.tilt_black_gravity')),
    expectedFg: numOr(s(`input_number.${tankId}_expected_fg`)),
    og: numOr(s('sensor.batch_og')),
    apparentAttenuationPct: numOr(s('sensor.apparent_attenuation')),
    progressToFgPct: numOr(s('sensor.attenuation_progress')),
    gravity24hDeltaPts: numOr(s('sensor.gravity_24h_delta')),
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

  // write the setpoint if it changed meaningfully (and not dry-run)
  if (r.setpointF != null && (currentSetpointF == null || Math.abs(r.setpointF - currentSetpointF) >= 0.1)) {
    console.log(`[${tankId}] setpoint ${currentSetpointF}→${r.setpointF}°F (${r.note})${DRY_RUN ? ' [DRY_RUN]' : ''}`);
    if (!DRY_RUN) {
      await callService('number', 'set_value',
        { entity_id: `number.${tankId}_setpoint_raw`, value: Math.round(r.setpointF * 10) });
    }
  }

  // advance phase
  if (r.advanceTo != null) {
    console.log(`[${tankId}] advance phase ${phaseIndex}→${r.advanceTo}`);
    if (!DRY_RUN) {
      await callService('input_number', 'set_value',
        { entity_id: `input_number.${tankId}_program_phase`, value: r.advanceTo });
      await callService('input_datetime', 'set_datetime',
        { entity_id: `input_datetime.${tankId}_program_phase_started`, datetime: nowIso() });
      phaseStartSetpoints.set(tankId, r.setpointF); // remember start for next phase's ramp
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
  const phases = p.phases.filter((ph) => ph && KINDS.includes(ph.kind)).map((ph) => ({
    name: String(ph.name || ph.kind),
    kind: ph.kind,
    tempF: Number.isFinite(ph.tempF) ? ph.tempF : undefined,
    targetF: Number.isFinite(ph.targetF) ? ph.targetF : undefined,
    stepF: Number.isFinite(ph.stepF) ? ph.stepF : undefined,
    everyHours: Number.isFinite(ph.everyHours) ? ph.everyHours : undefined,
    hours: Number.isFinite(ph.hours) ? ph.hours : undefined,
    advance: ph.advance || undefined,
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

  const gravity8hMaxSg = roll8hMax(tankId, gravity); // (also fills the 24h window)

  // 24h delta (pts/day), most-trustworthy source first:
  //  1) per-color Tilt stat sensor if it exists (sensor.tilt_<color>_gravity_24h_stat)
  //  2) the legacy un-prefixed Black stat / delta sensors (older HA setups)
  //  3) the runner's OWN window slope — robust to a missing/truncated HA stat
  //     (that "-0.0" bug where the statistics sensor rounds a slow drop to zero).
  const c = tiltSel?.toLowerCase();
  const statPerColor = num(s(`sensor.tilt_${c}_gravity_24h_stat`));   // SG/day
  const statLegacy = num(s('sensor.tilt_gravity_24h_stat'));          // SG/day (un-prefixed Black)
  const deltaLegacy = num(s('sensor.gravity_24h_delta'));             // already pts/day
  const own = windowSlopePts(tankId);                                 // pts/day, self-computed
  // Prefer a real HA stat reading; a value of 0/-0 is LEGITIMATE (a terminal beer's
  // 24h change genuinely IS ~0 — that's the "flat" signal, not a bug). Only treat a
  // NULL/missing source as untrusted. Fall back to the self-computed window slope
  // ONLY when every HA source is absent AND we have enough of our own samples.
  let delta;
  if (statPerColor != null) delta = statPerColor * 1000;
  else if (statLegacy != null) delta = statLegacy * 1000;
  else if (deltaLegacy != null) delta = deltaLegacy;
  else delta = own;
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

  const d = computeDerived({
    gravity, og,
    expectedFg: num(s(`input_number.${tankId}_expected_fg`)),
    beerTempF: tempF,
    probeTempF: num(s(`sensor.${tankId}_probe_temp`)),
    setpointF: num(s(`sensor.${tankId}_setpoint`)),
    gravity24hDeltaPts: delta,
    gravity8hMaxSg,
    gravityAgeMin: ageMin,
    daysFermenting: fermentingStartMs ? (Date.now() - fermentingStartMs) / 86_400_000 : null,
    prevLatched,
    stableSinceMs: st.stableSinceMs,
    dryHopped,
    conditionDays: facts?.conditionDays ?? null,
  }, Date.now());

  // maintain state, and PERSIST any change to the HA helpers (survives reboots).
  const before = { latched: st.latched, stableSinceMs: st.stableSinceMs };
  if (d.fermentationStarted) st.latched = true;
  if (d.isStableNow) { if (st.stableSinceMs == null) st.stableSinceMs = Date.now(); }
  else st.stableSinceMs = null;

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
      attributes: { friendly_name: `${tankId} derived`, tank: tankId, ...d, dryHop: dryHopped, bfStatus: facts?.status ?? null, bfConditioned },
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

console.log(`[programs] runner up. tick every ${TICK_MINUTES}min. DRY_RUN=${DRY_RUN}. tanks=${TANKS}`);
tickAll();
setInterval(tickAll, TICK_MINUTES * 60_000);
