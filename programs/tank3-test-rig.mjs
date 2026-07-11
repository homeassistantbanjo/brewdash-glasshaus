// Tank 3 LIVE TEST RIG — drives the ferment engine end-to-end against real HA,
// with SCRIPTED gravity/attenuation (Red Tilt is in water, can't ferment). Proves:
// compound advance ({all:[elapsed,active]}), attenuationOfExpected, the +1°F/4h ramp,
// and terminal — the whole Belle Saison plan advancing on real runner ticks.
//
// SAFE: writes only HA helper/sensor STATE + reads runner decisions. The programs
// container is DRY_RUN=true, so it never commands the ITC-308. This is a decision
// test, not a hardware test. Uses a THROWAWAY batch key ('TEST') — touches NO
// Brewfather batch.
//
// Run: HA_URL=... HA_TOKEN=... node tank3-test-rig.mjs <setup|step N|read|teardown>
// It sets state, then you tick the runner (or wait for its 5-min tick) and re-read.
//
// ⚠ KNOWN LIMITATION (found 2026-07-11 live test): this rig CANNOT drive a clean
// scripted curve yet, because tickTank() reads GLOBAL sensors that a LIVE integration
// owns — `sensor.tilt_black_gravity` (real Tilt) and `sensor.apparent_attenuation`
// (analyzer). Any state we POST to those is OVERWRITTEN within ~40s by the live feed,
// so the runner sees real values, not our curve. The compound-advance engine WAS
// observed running correctly against whatever inputs it got (it advanced when
// elapsed≥18h AND active were both genuinely true) — so the engine is validated; the
// RIG isn't usable for scripted curves until:
//   1. tickTank() reads PER-TANK / per-Tilt-color sensors (it currently hardcodes the
//      global Black sensors — a latent single-tank-era bug), AND
//   2. we point tank_3 at a dedicated TEST sensor nothing else writes.
// Until then this file is a reference/scaffold, not a working scripted test.

const HA = (process.env.HA_URL || '').replace(/\/$/, '');
const TOK = process.env.HA_TOKEN;
const H = { Authorization: `Bearer ${TOK}`, 'content-type': 'application/json' };
const T = 'tank_3';

async function setState(entity, state, attributes = {}) {
  const r = await fetch(`${HA}/api/states/${entity}`, {
    method: 'POST', headers: H, body: JSON.stringify({ state: String(state), attributes }),
  });
  if (!r.ok) throw new Error(`set ${entity} → HTTP ${r.status}`);
}
async function setHelper(domain, service, data) {
  const r = await fetch(`${HA}/api/services/${domain}/${service}`, { method: 'POST', headers: H, body: JSON.stringify(data) });
  if (!r.ok) throw new Error(`${domain}.${service} → HTTP ${r.status}`);
}
async function get(entity) {
  const r = await fetch(`${HA}/api/states/${entity}`, { headers: H });
  return r.ok ? r.json() : null;
}

// The Belle Saison plan — exactly Jordan's spec, using the new compound advance.
const BELLE_PLAN = {
  label: 'Belle Saison (TEST)',
  clamp: { minF: 60, maxF: 92 },     // saison runs hot — allow up to 92
  expectedAtten: 80,                 // Belle Saison ~80% apparent
  phases: [
    { name: 'Pitch/hold 68', kind: 'hold', tempF: 68,
      advance: { all: [ { type: 'elapsed', hours: 18 }, { type: 'active' } ] } },   // compound!
    { name: 'Free-rise 82', kind: 'ramp', targetF: 82, stepF: 3, everyHours: 6,
      advance: { type: 'attenuationOfExpected', pct: 75 } },                        // 75% of 80 = 60% AA
    { name: 'Finish ramp 87 (+1F/4h)', kind: 'ramp', targetF: 87, stepF: 1, everyHours: 4,
      advance: { type: 'terminal' } },
  ],
};

const cmd = process.argv[2];

if (cmd === 'setup') {
  // seed a throwaway batch + the plan, reset program to phase 0
  await setHelper('input_text', 'set_value', { entity_id: `input_text.${T}_batch`, value: 'TEST' });
  await setHelper('input_number', 'set_value', { entity_id: `input_number.${T}_expected_fg`, value: 1.006 });
  await setState('sensor.batch_og', 1.058);                        // fake OG
  await setState(`sensor.${T}_program_plan`, 'ready', { plan: BELLE_PLAN });
  // program select → the plan key the runner resolves ('Generated' per resolveProgram)
  await setHelper('input_select', 'select_option', { entity_id: `input_select.${T}_program`, option: 'Generated' }).catch(async () => {
    // if 'Generated' isn't an option, set the plan sensor is enough for resolveProgram; log
    console.log('  (note: input_select.tank_3_program has no "Generated" option — resolveProgram may need it; plan sensor is set)');
  });
  await setHelper('input_number', 'set_value', { entity_id: `input_number.${T}_program_phase`, value: 0 });
  console.log('SETUP done: batch=TEST, OG=1.058, expFG=1.006, Belle Saison plan on tank_3, phase=0');
  console.log('Now run:  node tank3-test-rig.mjs step <n>   to drive the curve.');
}

// each "step" sets the scripted sensors for a point in the fermentation curve.
// CURVE (OG 1.058 → FG ~1.006, Belle Saison ~80% atten):
const CURVE = {
  0: { label: 'just pitched (hour 0)',      gravity: 1.058, atten: 0,  delta: 0 },
  1: { label: 'active, ~20h in',            gravity: 1.050, atten: 14, delta: -8 },   // active + (needs 18h elapsed)
  2: { label: 'free-rise zone ~45% AA',     gravity: 1.035, atten: 40, delta: -10 },
  3: { label: 'hit 60% AA (=75% of exp80)', gravity: 1.027, atten: 60, delta: -6 },  // advance step2→3
  4: { label: 'near terminal, flattening',  gravity: 1.010, atten: 83, delta: -1 },
  5: { label: 'terminal, flat @ FG',        gravity: 1.007, atten: 88, delta: 0 },   // advance step3→terminal
};
if (cmd === 'step') {
  const n = Number(process.argv[3]);
  const c = CURVE[n];
  if (!c) { console.log('steps: 0..5'); process.exit(1); }
  await setState('sensor.tilt_black_gravity', c.gravity);
  await setState('sensor.apparent_attenuation', c.atten);
  await setState('sensor.gravity_24h_delta', c.delta);
  // progress-to-fg = how far from OG to FG (for progressToFg conditions if any)
  const prog = Math.round(((1.058 - c.gravity) / (1.058 - 1.006)) * 100);
  await setState('sensor.attenuation_progress', prog);
  console.log(`STEP ${n}: ${c.label} — gravity=${c.gravity} atten=${c.atten}% delta=${c.delta} progress=${prog}%`);
  console.log('  (tick the runner or wait ≤5min, then: node tank3-test-rig.mjs read)');
}

if (cmd === 'read') {
  const phase = await get(`input_number.${T}_program_phase`);
  const status = await get(`sensor.${T}_program_status`);
  const setpoint = await get(`sensor.${T}_setpoint`);
  console.log('RUNNER STATE for tank_3:');
  console.log('  phase index :', phase?.state);
  console.log('  program status:', status?.state, status?.attributes?.note ? `(${status.attributes.note})` : '');
  console.log('  commanded setpoint:', setpoint?.state, '(DRY_RUN → decided, not written to hardware)');
  if (status?.attributes) {
    const a = status.attributes;
    console.log('  phase name:', a.phaseName ?? a.phase ?? '?', '| advanceTo:', a.advanceTo ?? '—');
  }
}

if (cmd === 'teardown') {
  await setHelper('input_text', 'set_value', { entity_id: `input_text.${T}_batch`, value: 'unknown' });
  await setHelper('input_select', 'select_option', { entity_id: `input_select.${T}_program`, option: 'None' }).catch(() => {});
  await setHelper('input_number', 'set_value', { entity_id: `input_number.${T}_program_phase`, value: 0 });
  console.log('TEARDOWN: tank_3 batch cleared, program None, phase 0. (scripted global sensors will refresh from real data.)');
}

if (!['setup', 'step', 'read', 'teardown'].includes(cmd)) {
  console.log('usage: node tank3-test-rig.mjs <setup|step N|read|teardown>');
}
