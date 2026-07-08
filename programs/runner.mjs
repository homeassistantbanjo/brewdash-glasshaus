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
  if (key === 'Custom') {
    // custom program stored as JSON in an input_text attribute (future); skip for now
    return null;
  }
  return null;
}

// track crash-confirm presses + per-phase start setpoints + adopt-once guard between ticks
const pendingConfirm = new Set();
const phaseStartSetpoints = new Map();
const adopted = new Set(); // tanks whose in-progress ferment we've already adopted this run

function nowIso() { return new Date().toISOString(); }

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

function roll8hMax(tankId, sg) {
  if (sg == null) return null;
  const now = Date.now();
  const buf = gravWindow.get(tankId) || [];
  buf.push({ t: now, sg });
  const cutoff = now - 8 * 3600_000;
  const kept = buf.filter((x) => x.t >= cutoff);
  gravWindow.set(tankId, kept);
  return Math.max(...kept.map((x) => x.sg));
}

async function deriveTank(tankId, by) {
  const s = (id) => by[id]?.state;
  const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const usable = (v) => v != null && v !== 'unknown' && v !== 'unavailable' && v !== '';

  const tiltSel = s(`input_select.${tankId}_tilt`);
  const { gravity, tempF, ageMin } = tiltData(by, tiltSel);
  const batchSel = s(`input_select.${tankId}_batch`);
  // OG for this tank's batch: match the assigned batch in all_batches_data
  const bfData = by['sensor.brewfather_all_batches_data']?.attributes?.data || [];
  const batch = bfData.find((b) => b.name === batchSel || String(b.batchNo) === batchSel) || null;
  const og = batch?.measuredOg != null ? Number(batch.measuredOg) : null;
  const fermentingStartMs = batch?.fermentingStart ? Date.parse(batch.fermentingStart) : null;

  // 24h delta: prefer the per-color Tilt stat if present, else the Black legacy one
  const c = tiltSel?.toLowerCase();
  const delta = num(s(`sensor.tilt_${c}_gravity_24h_stat`)) != null
    ? num(s(`sensor.tilt_${c}_gravity_24h_stat`)) * 1000  // stat is SG → pts
    : num(s('sensor.gravity_24h_delta'));                 // legacy pts (Black)

  const gravity8hMaxSg = roll8hMax(tankId, gravity);

  // latch state, reset when the batch changes
  const batchKey = batchSel || 'none';
  const prev = latchState.get(tankId);
  if (!prev || prev.batchKey !== batchKey) latchState.set(tankId, { batchKey, latched: false });
  const prevLatched = latchState.get(tankId).latched;

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
  }, Date.now());

  // persist the latch (one-shot until batch changes)
  if (d.fermentationStarted) latchState.get(tankId).latched = true;

  // write ONE generic per-tank entity the app + notifications read
  await fetch(`${HA_URL}/api/states/sensor.${tankId}_derived`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      state: d.alerts[0]?.label || (d.fermentationStarted ? 'fermenting' : 'nominal'),
      attributes: { friendly_name: `${tankId} derived`, tank: tankId, ...d },
    }),
  }).catch((e) => console.error(`[${tankId}] derived write failed:`, e.message));
}

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
  } catch (e) {
    console.error('[programs] tick failed:', e.message);
  }
}

console.log(`[programs] runner up. tick every ${TICK_MINUTES}min. DRY_RUN=${DRY_RUN}. tanks=${TANKS}`);
tickAll();
setInterval(tickAll, TICK_MINUTES * 60_000);
