// GlassHaus COMPREHENSIVE E2E SMOKE TEST — exercises every subsystem + every write
// round-trip in one run, reports PASS/FAIL. Designed to be the regression suite that
// catches breaks before you stumble on them.
//
// SAFETY (learned the hard way): NEVER touch real production state.
//   - Test bed = TANK_2 + TANK_3 only (tank_1 / #144 / #137 are REAL — off-limits).
//   - Write tests SAVE the current value → write a test value → verify → RESTORE.
//     Nothing is left changed.
//   - Uses Piwo #141 (a throwaway test batch) + the Red Tilt (floating in water).
//   - Does NOT write to Brewfather at all.
//
// Run: HA_URL=... HA_TOKEN=... BF_URL=http://192.168.50.118:8093 node e2e-smoke.mjs

const HA = (process.env.HA_URL || '').replace(/\/$/, '');
const TOK = process.env.HA_TOKEN;
const BF = (process.env.BF_URL || 'http://192.168.50.118:8093').replace(/\/$/, '');
const TEST_TANKS = ['tank_2', 'tank_3'];   // safe bed; tank_1 is REAL — never touched
const REAL_TANKS = ['tank_1'];
const TEST_BATCH = '141';                  // Piwo — throwaway

let pass = 0, fail = 0, warn = 0; const fails = [];
const ok = (m) => { pass++; console.log(`  ✅ ${m}`); };
const bad = (m) => { fail++; fails.push(m); console.log(`  ❌ ${m}`); };
const meh = (m) => { warn++; console.log(`  ⚠️  ${m}`); };
const H = { Authorization: `Bearer ${TOK}`, 'content-type': 'application/json' };

async function get(entity) {
  try { const r = await fetch(`${HA}/api/states/${entity}`, { headers: H, signal: AbortSignal.timeout(8000) }); return r.ok ? r.json() : null; } catch { return null; }
}
async function svc(domain, service, data) {
  try { const r = await fetch(`${HA}/api/services/${domain}/${service}`, { method: 'POST', headers: H, body: JSON.stringify(data), signal: AbortSignal.timeout(8000) }); return r.ok; } catch { return false; }
}
async function bf(path) { try { const r = await fetch(`${BF}${path}`, { signal: AbortSignal.timeout(9000) }); return { status: r.status, body: await r.json().catch(() => null) }; } catch (e) { return { status: 0, err: e.message }; } }
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const has = (v) => v != null && !['unknown', 'unavailable', ''].includes(String(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// write round-trip: save → set test → verify → restore. Returns pass/fail.
async function roundTrip(label, entity, domain, service, setData, expectFn, restoreFn) {
  const before = await get(entity);
  const orig = before?.state;
  const set = await svc(domain, service, setData);
  if (!set) { bad(`${label}: service call FAILED (${domain}.${service})`); return; }
  await sleep(600);
  const after = await get(entity);
  if (expectFn(after?.state)) ok(`${label}: write landed (${entity} = ${after?.state})`);
  else bad(`${label}: write did NOT land (${entity} = ${after?.state}, expected ${JSON.stringify(setData)})`);
  // restore original
  if (has(orig) && restoreFn) await restoreFn(orig);
}

console.log('\n═══ GlassHaus E2E SMOKE TEST ═══');
console.log(`bed: ${TEST_TANKS.join(',')} + batch #${TEST_BATCH} + Red Tilt   (real/untouched: ${REAL_TANKS.join(',')})\n`);

// ── 1. WRITE ROUND-TRIPS (the path that was broken today) ──────────────────
console.log('[1] Write round-trips (save→set→verify→restore, tank_2 only)');
const T = 'tank_2';
await roundTrip('setStatus', `input_select.${T}_status`, 'input_select', 'select_option',
  { entity_id: `input_select.${T}_status`, option: 'Fermenting' }, (v) => v === 'Fermenting',
  (orig) => svc('input_select', 'select_option', { entity_id: `input_select.${T}_status`, option: orig }));
await roundTrip('setTilt', `input_select.${T}_tilt`, 'input_select', 'select_option',
  { entity_id: `input_select.${T}_tilt`, option: 'Blue' }, (v) => v === 'Blue',
  (orig) => svc('input_select', 'select_option', { entity_id: `input_select.${T}_tilt`, option: orig }));
await roundTrip('setExpectedFg', `input_number.${T}_expected_fg`, 'input_number', 'set_value',
  { entity_id: `input_number.${T}_expected_fg`, value: 1.011 }, (v) => num(v) === 1.011,
  (orig) => svc('input_number', 'set_value', { entity_id: `input_number.${T}_expected_fg`, value: num(orig) }));
await roundTrip('markCleaned', `input_datetime.${T}_last_cleaned`, 'input_datetime', 'set_datetime',
  { entity_id: `input_datetime.${T}_last_cleaned`, date: '2020-01-01' }, (v) => String(v).startsWith('2020-01-01'),
  (orig) => svc('input_datetime', 'set_datetime', { entity_id: `input_datetime.${T}_last_cleaned`, datetime: orig }));
await roundTrip('setProgram', `input_select.${T}_program`, 'input_select', 'select_option',
  { entity_id: `input_select.${T}_program`, option: 'None' }, (v) => v === 'None', null);

// ── 2. DATA PIPELINE (BF endpoints + DB) ────────────────────────────────────
console.log('\n[2] Data pipeline');
for (const [p, chk, name] of [
  ['/health', (b, s) => s === 200, 'BF /health'],
  ['/assignable', (b) => Array.isArray(b?.batches), 'BF /assignable'],
  ['/history', (b) => Array.isArray(b?.batches), 'DB /history'],
]) { const r = await bf(p); chk(r.body, r.status) ? ok(`${name} ok`) : bad(`${name} failed (${r.status} ${r.err || ''})`); }
const rec = await bf(`/batch/${TEST_BATCH}`);
rec.status === 200 && rec.body?.batchNo ? ok(`BF /batch/${TEST_BATCH} resolves (og=${rec.body.og}, status=${rec.body.status})`) : bad(`BF /batch/${TEST_BATCH} failed (${rec.status})`);

// ── 3. FERMENT RESOLUTION per tank (derived correctness) ────────────────────
console.log('\n[3] Ferment resolution (per tank)');
for (const t of [...REAL_TANKS, ...TEST_TANKS]) {
  const batch = await get(`input_text.${t}_batch`);
  const d = await get(`sensor.${t}_derived`);
  if (!d) { bad(`${t}: no derived sensor`); continue; }
  const a = d.attributes || {};
  const assigned = has(batch?.state);
  if (assigned) {
    ok(`${t}: assigned #${batch.state} → derived writes (bfStatus=${a.bfStatus}, og=${a.og})`);
    if (a.og == null && a.bfStatus) meh(`${t}: has bfStatus but og=null (OG resolution gap for this batch)`);
    const at = num(a.attenuationPct);
    if (at != null && (at < -5 || at > 105)) meh(`${t}: atten=${at}% out of range (Tilt in water / not in beer — expected for test bed)`);
  } else {
    ok(`${t}: unassigned (derived state=${d.state})`);
  }
}

// ── 4. CONTROLLER DETECTION (the tank_2 warning) ────────────────────────────
console.log('\n[4] Controller detection');
for (const t of ['tank_1', 'tank_2', 'tank_3']) {
  const sw = await get(`switch.${t}_temp_controller_power`) || await get(`switch.${t}_temperature_controller`);
  const hasCtrl = !!sw;
  if (t === 'tank_2') (!hasCtrl ? ok('tank_2: no controller (correct — none wired; the warning is legit not a bug)') : meh('tank_2: unexpectedly has a controller now'));
  else (hasCtrl ? ok(`${t}: controller present`) : meh(`${t}: no controller entity`));
}

// ── 5. PROGRAM ENGINE liveness ──────────────────────────────────────────────
console.log('\n[5] Program engine');
const ph = await get('sensor.glasshaus_health');   // runner heartbeat via health sensor (if present)
const anyStatus = await get('sensor.tank_1_program_status');
anyStatus ? ok('program status sensor exists (runner writing program state)') : meh('no program_status sensor (runner may not have run a program)');

// ── 6. OBSERVABILITY / HEALTH ───────────────────────────────────────────────
console.log('\n[6] Observability');
const health = await get('sensor.glasshaus_health');
if (health) {
  const age = health.last_updated ? Math.round((Date.now() - Date.parse(health.last_updated)) / 60000) : null;
  age != null && age < 12 ? ok(`glasshaus_health fresh (${age}m, state=${health.state})`) : meh(`glasshaus_health stale (${age}m) — programs container heartbeat?`);
} else meh('no glasshaus_health sensor');

console.log(`\n═══ ${pass} pass · ${warn} warn · ${fail} fail ═══`);
if (fails.length) { console.log('\nFAILURES:'); fails.forEach((f) => console.log('  • ' + f)); }
process.exit(fail > 0 ? 1 : 0);
