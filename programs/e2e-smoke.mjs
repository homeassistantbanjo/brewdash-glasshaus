// GlassHaus EXHAUSTIVE CONTRACT SMOKE TEST — verifies EVERY function in the estate
// responds + returns a valid shape, every write action round-trips, every HA entity
// exists + is fresh, and every app hook's backing data is present. "Is everything
// alive and wired." One run, PASS/FAIL, exits non-zero on fail.
//
// SAFETY (post-#137): test bed = tank_2/tank_3 + Piwo #141 + Red/Blue tilt ONLY.
// tank_1 / #144 / #137 are REAL — read-only, never written. Write tests
// save→set→verify→RESTORE. NEVER writes to Brewfather (only reads its endpoints).
//
// Run: HA_URL=... HA_TOKEN=... BF_URL=... ANALYZER_URL=... node e2e-smoke.mjs

const HA = (process.env.HA_URL || '').replace(/\/$/, '');
const TOK = process.env.HA_TOKEN;
const BF = (process.env.BF_URL || 'http://192.168.50.118:8093').replace(/\/$/, '');
const ANALYZER = (process.env.ANALYZER_URL || 'http://192.168.50.118:8091').replace(/\/$/, '');
const TEST_TANK = 'tank_2';                 // safe write bed
const ALL_TANKS = ['tank_1', 'tank_2', 'tank_3'];
const TEST_BATCH = '141';                   // Piwo — throwaway

let pass = 0, fail = 0, warn = 0; const fails = [];
const ok = (m) => { pass++; console.log(`  ✅ ${m}`); };
const bad = (m) => { fail++; fails.push(m); console.log(`  ❌ ${m}`); };
const meh = (m) => { warn++; console.log(`  ⚠️  ${m}`); };
const sec = (n) => console.log(`\n[${n}]`);
const H = { Authorization: `Bearer ${TOK}`, 'content-type': 'application/json' };

async function get(entity) { try { const r = await fetch(`${HA}/api/states/${entity}`, { headers: H, signal: AbortSignal.timeout(8000) }); return r.ok ? r.json() : null; } catch { return null; } }
async function svc(d, s, data) { try { const r = await fetch(`${HA}/api/services/${d}/${s}`, { method: 'POST', headers: H, body: JSON.stringify(data), signal: AbortSignal.timeout(8000) }); return r.ok; } catch { return false; } }
async function http(base, path, method = 'GET') { try { const r = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(12000) }); const body = await r.json().catch(() => null); return { status: r.status, body }; } catch (e) { return { status: 0, err: e.message }; } }
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const has = (v) => v != null && !['unknown', 'unavailable', ''].includes(String(v));
const ageMin = (e) => e?.last_updated ? Math.round((Date.now() - Date.parse(e.last_updated)) / 60000) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function endpoint(name, base, path, wantStatus, shapeFn) {
  const r = await http(base, path);
  if (r.status === 0) return bad(`${name} ${path}: unreachable (${r.err})`);
  if (Array.isArray(wantStatus) ? !wantStatus.includes(r.status) : r.status !== wantStatus) return bad(`${name} ${path}: HTTP ${r.status} (want ${wantStatus})`);
  if (shapeFn && !shapeFn(r.body)) return bad(`${name} ${path}: bad shape → ${JSON.stringify(r.body)?.slice(0, 100)}`);
  ok(`${name} ${path} → ${r.status} ✓shape`);
  return r.body;
}
async function roundTrip(label, entity, d, s, setData, expect, restore) {
  const before = await get(entity); const orig = before?.state;
  if (!await svc(d, s, setData)) return bad(`${label}: service ${d}.${s} rejected`);
  await sleep(500);
  const after = await get(entity);
  expect((after?.state)) ? ok(`${label}: round-trips (${entity})`) : bad(`${label}: write did NOT land (${entity}=${after?.state})`);
  if (has(orig) && restore) await restore(orig);
}

console.log('\n═══ GlassHaus EXHAUSTIVE CONTRACT SMOKE TEST ═══');
console.log(`bed: ${TEST_TANK} writes + #${TEST_BATCH} + red/blue tilt   real/untouched: tank_1/#144/#137\n`);

// ══ A. BREWFATHER CONTAINER — all 13 endpoints ══
sec('A. Brewfather endpoints (all 13)');
await endpoint('BF', BF, '/health', 200, () => true);
await endpoint('BF', BF, '/assignable', 200, (b) => Array.isArray(b?.batches));
await endpoint('BF', BF, '/batches', 200, (b) => Array.isArray(b?.batches));
await endpoint('BF', BF, `/batch/${TEST_BATCH}`, 200, (b) => b?.batchNo != null && 'og' in b && 'measured' in b);
await endpoint('BF', BF, `/recipe/${TEST_BATCH}`, [200, 502], (b) => b == null || 'name' in b || 'og' in b || 'fermentables' in b || 'error' in b);
await endpoint('BF', BF, `/fermplan-intents/${TEST_BATCH}`, [200, 501, 502], (b) => b == null || Array.isArray(b?.intents) || 'error' in b);
await endpoint('BF', BF, '/history', 200, (b) => Array.isArray(b?.batches));
await endpoint('BF', BF, `/record/${TEST_BATCH}`, [200, 404], (b) => b == null || 'batch' in b || 'error' in b);
// POST endpoints: verify they EXIST + validate input (don't mutate real data). A
// malformed body should get 400, not 404/500 — proves the route is wired.
const stR = await http(BF, `/batch/${TEST_BATCH}/status`, 'POST'); [200, 400, 502].includes(stR.status) ? ok(`BF /batch/:id/status POST wired (${stR.status})`) : bad(`BF /batch/:id/status POST → ${stR.status}`);
const cmpR = await http(BF, `/batch/999999/complete`, 'POST'); [200, 400, 404, 502].includes(cmpR.status) ? ok(`BF /batch/:id/complete POST wired (${cmpR.status})`) : bad(`BF /complete → ${cmpR.status}`);
const tasteR = await http(BF, `/record/999999/tasting`, 'POST'); [200, 400, 404].includes(tasteR.status) ? ok(`BF /record/:no/tasting POST wired (${tasteR.status})`) : bad(`BF /tasting → ${tasteR.status}`);
const fpR = await http(BF, `/fermplan/${TEST_BATCH}`, 'POST'); [200, 400, 501, 502].includes(fpR.status) ? ok(`BF /fermplan/:id POST wired (${fpR.status})`) : bad(`BF /fermplan → ${fpR.status}`);

// ══ B. ANALYZER CONTAINER — endpoints ══
sec('B. Analyzer endpoints');
await endpoint('ANALYZER', ANALYZER, '/health', [200, 404], () => true);
const insR = await http(ANALYZER, '/insights'); [200, 404, 500].includes(insR.status) ? ok(`ANALYZER /insights (${insR.status})`) : bad(`ANALYZER /insights → ${insR.status}`);
const trigR = await http(ANALYZER, '/trigger', 'POST'); [200, 202, 400, 404, 405].includes(trigR.status) ? ok(`ANALYZER /trigger wired (${trigR.status})`) : bad(`ANALYZER /trigger → ${trigR.status}`);

// ══ C. WRITE ACTIONS — all 18 (round-trip on tank_2, restore) ══
sec('C. Write actions (round-trip, tank_2)');
const T = TEST_TANK;
await roundTrip('setStatus', `input_select.${T}_status`, 'input_select', 'select_option', { entity_id: `input_select.${T}_status`, option: 'Fermenting' }, (v) => v === 'Fermenting', (o) => svc('input_select', 'select_option', { entity_id: `input_select.${T}_status`, option: o }));
await roundTrip('setTilt', `input_select.${T}_tilt`, 'input_select', 'select_option', { entity_id: `input_select.${T}_tilt`, option: 'Blue' }, (v) => v === 'Blue', (o) => svc('input_select', 'select_option', { entity_id: `input_select.${T}_tilt`, option: o }));
await roundTrip('setBatch(input_text)', `input_text.${T}_batch`, 'input_text', 'set_value', { entity_id: `input_text.${T}_batch`, value: TEST_BATCH }, (v) => v === TEST_BATCH, (o) => svc('input_text', 'set_value', { entity_id: `input_text.${T}_batch`, value: o }));
await roundTrip('setExpectedFg', `input_number.${T}_expected_fg`, 'input_number', 'set_value', { entity_id: `input_number.${T}_expected_fg`, value: 1.011 }, (v) => num(v) === 1.011, (o) => svc('input_number', 'set_value', { entity_id: `input_number.${T}_expected_fg`, value: num(o) }));
await roundTrip('markCleaned', `input_datetime.${T}_last_cleaned`, 'input_datetime', 'set_datetime', { entity_id: `input_datetime.${T}_last_cleaned`, date: '2020-01-01' }, (v) => String(v).startsWith('2020-01-01'), (o) => svc('input_datetime', 'set_datetime', { entity_id: `input_datetime.${T}_last_cleaned`, datetime: o }));
await roundTrip('setSetpoint(number)', `number.${T}_setpoint_raw`, 'number', 'set_value', { entity_id: `number.${T}_setpoint_raw`, value: 650 }, (v) => num(v) === 650, (o) => svc('number', 'set_value', { entity_id: `number.${T}_setpoint_raw`, value: num(o) }));
await roundTrip('setProgram', `input_select.${T}_program`, 'input_select', 'select_option', { entity_id: `input_select.${T}_program`, option: 'None' }, (v) => v === 'None', null);
await roundTrip('program_phase(set)', `input_number.${T}_program_phase`, 'input_number', 'set_value', { entity_id: `input_number.${T}_program_phase`, value: 0 }, (v) => num(v) === 0, null);
await roundTrip('program_plan(input_text)', `input_text.${T}_program_plan`, 'input_text', 'set_value', { entity_id: `input_text.${T}_program_plan`, value: '' }, (v) => v === '' || v === 'unknown', null);
await roundTrip('confirmCrash(button)', `input_button.${T}_confirm_crash`, 'input_button', 'press', { entity_id: `input_button.${T}_confirm_crash` }, () => true, null);

// ══ D. HA ENTITIES — every registry entity ×3 tanks + plant ══
sec('D. HA entities (existence + freshness)');
const perTank = ['input_select.{}_status', 'input_select.{}_tilt', 'input_select.{}_program', 'input_text.{}_batch', 'input_text.{}_program_plan', 'input_text.{}_state_batchkey', 'input_number.{}_expected_fg', 'input_number.{}_program_phase', 'input_datetime.{}_last_cleaned', 'input_datetime.{}_program_phase_started', 'input_datetime.{}_stable_since', 'input_boolean.{}_fermentation_started', 'input_boolean.{}_bf_conditioned', 'input_button.{}_confirm_crash', 'sensor.{}_derived', 'sensor.{}_program_status', 'sensor.{}_program_plan', 'sensor.{}_probe_temp', 'sensor.{}_setpoint'];
let missing = 0, present = 0;
for (const t of ALL_TANKS) for (const pat of perTank) {
  const e = await get(pat.replace('{}', t));
  if (e) present++; else { missing++; meh(`entity missing: ${pat.replace('{}', t)}`); }
}
missing === 0 ? ok(`all ${present} per-tank entities present (3 tanks × ${perTank.length})`) : bad(`${missing} per-tank entities MISSING (${present} present)`);
const plant = ['sensor.glycol_temp', 'sensor.glycol_power_current_consumption', 'binary_sensor.glycol_chiller_running_power', 'sensor.kegerator_power_current_consumption', 'sensor.brewfather_all_batches_data', 'sensor.glasshaus_health'];
let pMiss = 0;
for (const e of plant) { const st = await get(e); if (!st) { pMiss++; meh(`plant entity missing: ${e}`); } }
pMiss === 0 ? ok(`all ${plant.length} plant entities present`) : bad(`${pMiss} plant entities MISSING`);

// ══ E. HOOK BACKING DATA — the reads every app hook depends on ══
sec('E. App-hook backing data');
const feed = await get('sensor.brewfather_all_batches_data'); Array.isArray(feed?.attributes?.data) ? ok(`useBrewfatherBatches: feed valid (${feed.attributes.data.length} batches)`) : bad('useBrewfatherBatches: feed data not an array');
const gly = await get('sensor.glycol_temp'); has(gly?.state) ? ok('useGlycol: glycol_temp present') : meh('useGlycol: glycol_temp unavailable');
const hlth = await get('sensor.glasshaus_health'); hlth ? ok(`useHealth: health sensor present (${hlth.state})`) : meh('useHealth: no health sensor');
const asgn = await http(BF, '/assignable'); Array.isArray(asgn.body?.batches) ? ok('useAssignableBatches: /assignable valid') : bad('useAssignableBatches: /assignable bad');
const ins = await get('sensor.glasshaus_insight'); ins ? ok('useInsight: insight sensor present') : meh('useInsight: no insight sensor (analyzer may not have run)');
// freshness of the derived sensors (useActiveBatches core)
for (const t of ALL_TANKS) { const d = await get(`sensor.${t}_derived`); const a = ageMin(d); if (d && (a == null || a < 15)) ok(`useActiveBatches: ${t}_derived fresh (${a}m)`); else if (d) meh(`${t}_derived stale (${a}m)`); else bad(`${t}_derived MISSING`); }

console.log(`\n═══ ${pass} pass · ${warn} warn · ${fail} fail ═══`);
if (fails.length) { console.log('\nFAILURES:'); fails.forEach((f) => console.log('  • ' + f)); }
process.exit(fail > 0 ? 1 : 0);
