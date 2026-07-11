// GlassHaus SMOKE TEST — one run, exercises every subsystem, reports PASS/FAIL/WARN.
// Read-only by default (does NOT mutate live state). Run:
//   HA_URL=... HA_TOKEN=... BF_URL=http://192.168.50.118:8093 node smoke-test.mjs
//
// Checks: (A) ferment control per-tank (derived correctness, no leftover data on
// empty tanks), (B) data pipeline (BF endpoints + DB), (C) assignment→reaction
// (does input_text.tank_N_batch resolve → derived reflect it). Pinpoints breaks.

const HA = (process.env.HA_URL || '').replace(/\/$/, '');
const TOK = process.env.HA_TOKEN;
const BF = (process.env.BF_URL || 'http://192.168.50.118:8093').replace(/\/$/, '');
const TANKS = ['tank_1', 'tank_2', 'tank_3'];

let pass = 0, fail = 0, warn = 0;
const line = (sym, msg) => console.log(`  ${sym} ${msg}`);
const ok = (m) => { pass++; line('✅', m); };
const bad = (m) => { fail++; line('❌', m); };
const meh = (m) => { warn++; line('⚠️ ', m); };

async function ha(entity) {
  try { const r = await fetch(`${HA}/api/states/${entity}`, { headers: { Authorization: `Bearer ${TOK}` }, signal: AbortSignal.timeout(8000) });
    return r.ok ? r.json() : null; } catch { return null; }
}
async function bf(path) {
  try { const r = await fetch(`${BF}${path}`, { signal: AbortSignal.timeout(9000) }); return { status: r.status, body: await r.json().catch(() => null) }; }
  catch (e) { return { status: 0, err: e.message }; }
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const ageMin = (e) => e?.last_updated ? Math.round((Date.now() - Date.parse(e.last_updated)) / 60000) : null;
const has = (v) => v != null && !['unknown', 'unavailable', ''].includes(String(v));

console.log('\n═══ GlassHaus SMOKE TEST ═══');

// ── A. FERMENT CONTROL — per tank ──────────────────────────────────────────
console.log('\n[A] Ferment control (per-tank correctness)');
for (const t of TANKS) {
  const batch = await ha(`input_text.${t}_batch`);
  const tilt = await ha(`input_select.${t}_tilt`);
  const derived = await ha(`sensor.${t}_derived`);
  const assigned = has(batch?.state);
  const b = String(batch?.state);
  const a = derived?.attributes || {};
  const dAge = ageMin(derived);

  if (!derived) { bad(`${t}: sensor.${t}_derived MISSING (runner not writing it)`); continue; }
  if (dAge != null && dAge > 12) meh(`${t}: derived stale (${dAge}m) — runner may not be ticking`);

  if (assigned) {
    // assigned tank: derived should reflect THIS batch (og present, plausible atten)
    const atten = num(a.attenuationPct);
    if (a.bfStatus || atten != null) ok(`${t}: assigned #${b} → derived active (atten=${atten}, bfStatus=${a.bfStatus})`);
    else meh(`${t}: assigned #${b} but derived shows no batch data (og/atten null) — assignment not resolving to a BF batch?`);
    if (atten != null && (atten < -5 || atten > 105)) bad(`${t}: atten=${atten}% is GARBAGE (leftover/wrong-tilt data)`);
  } else {
    // UNASSIGNED tank: derived must be CLEAN — no fermentation data leaking in
    const atten = num(a.attenuationPct);
    if (atten != null) bad(`${t}: UNASSIGNED but derived shows atten=${atten}% + bfStatus=${a.bfStatus} — STALE/LEAKED data (should be clean)`);
    else ok(`${t}: unassigned → derived clean (no leaked fermentation data)`);
  }
}

// ── B. DATA PIPELINE — brewfather container + DB ────────────────────────────
console.log('\n[B] Data pipeline (Brewfather endpoints + batch DB)');
const health = await bf('/health');
health.status === 200 ? ok('BF container /health responds') : bad(`BF container unreachable (${health.err || health.status})`);
const assignable = await bf('/assignable');
if (assignable.status === 200 && Array.isArray(assignable.body?.batches)) ok(`/assignable → ${assignable.body.batches.length} batches (${assignable.body.batches.map(x => '#' + x.batchNo).join(',')})`);
else bad(`/assignable failed (${assignable.status})`);
const hist = await bf('/history');
if (hist.status === 200 && Array.isArray(hist.body?.batches)) ok(`/history (DB) → ${hist.body.batches.length} captured batches`);
else bad(`/history failed (${hist.status}) — DB or endpoint broken`);
// a known captured batch (#137 from earlier) should be retrievable + persisted
const rec = await bf('/record/137');
if (rec.status === 200 && rec.body?.batch) ok(`/record/137 → captured (${rec.body.readings?.length ?? 0} readings persisted)`);
else if (rec.status === 404) meh('/record/137 not in DB (was it captured? or DB reset?)');
else bad(`/record/137 errored (${rec.status})`);

// ── C. ASSIGNMENT → REACTION ────────────────────────────────────────────────
console.log('\n[C] Assignment → reaction (the "doesn\'t do shit" check)');
const bfData = await ha('sensor.brewfather_all_batches_data');
const feed = (bfData?.attributes?.data || []).map((x) => String(x.batchNo));
ok(`HA brewfather feed has: [${feed.join(',') || 'empty'}] (Fermenting-only integration)`);
for (const t of TANKS) {
  const batch = await ha(`input_text.${t}_batch`);
  if (!has(batch?.state)) continue;
  const b = String(batch.state);
  const inFeed = feed.includes(b);
  const derived = await ha(`sensor.${t}_derived`);
  const resolvedOg = derived?.attributes?.bfStatus != null;   // proxy: did runner resolve the batch?
  if (inFeed) ok(`${t}: batch #${b} IS in HA feed → runner can resolve it directly`);
  else if (resolvedOg) ok(`${t}: batch #${b} NOT in HA feed but runner resolved it (BF-container fallback working)`);
  else bad(`${t}: batch #${b} assigned but NOT in HA feed AND runner didn't resolve it → tank shows nothing (THE BUG)`);
}

// ── SUMMARY ──────────────────────────────────────────────────────────────────
console.log(`\n═══ RESULT: ${pass} pass · ${warn} warn · ${fail} fail ═══\n`);
process.exit(fail > 0 ? 1 : 0);
