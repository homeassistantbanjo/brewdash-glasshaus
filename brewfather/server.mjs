// GlassHaus Brewfather WRITE service — holds the Brewfather API key server-side
// (never in the browser) and exposes a tiny HTTP API the dashboard calls to write
// brew-day measurements back to Brewfather. Reads still come via HA's Brewfather
// integration; this container is ONLY for writes + a small read to prefill the form.
//
// Brewfather API: base https://api.brewfather.app/v2, Basic auth userid:apikey,
// 500 calls/hour. Writable batch fields (PATCH /batches/:id, scope batches.write):
//   measuredPreBoilGravity, measuredPostBoilGravity, measuredOg, measuredFg (SG),
//   measuredMashPh (0-14), measuredBoilSize/BatchSize/BottlingSize/KettleSize (L),
//   status. NOT writable: notes, arbitrary readings.
//
// Config via env (NEVER git): BF_USERID, BF_APIKEY, [PORT=8093], [ALLOW_ORIGIN=*].
import { createServer } from 'node:http';
import { captureBatch } from './capture.mjs';
import { addEvent, addTasting, getBatch, getTastings, listBatches, getReadings } from './db.mjs';

const BF_USERID = required('BF_USERID');
const BF_APIKEY = required('BF_APIKEY');
const PORT = Number(process.env.PORT || 8093);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const BF = 'https://api.brewfather.app/v2';
const AUTH = 'Basic ' + Buffer.from(`${BF_USERID}:${BF_APIKEY}`).toString('base64');
// Optional: Anthropic key enables POST /fermplan (Claude-generated ferm plans).
// Absent → the endpoint returns 501 and the UI hides the "Suggest Ferm Plan" button.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const PLAN_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

function required(k) {
  const v = process.env[k];
  if (!v) { console.error(`[brewfather] missing required env ${k}`); process.exit(1); }
  return v;
}

const CORS = {
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  // best-practice headers (clears the DevTools Issues-panel security/perf nags)
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};
const sendJson = (res, code, obj) =>
  res.writeHead(code, { 'content-type': 'application/json', ...CORS }).end(JSON.stringify(obj));

// ---- unit conversion: the panel sends the user's units; BF wants metric --------
const galToL = (g) => g * 3.785411784;
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Tiny TTL cache for READ calls, keyed by a string. Stops rapid view-switching
// (BrewDayView unmounts/remounts on each Tanks↔Brew Day flip → refetch) from
// spamming the Brewfather API. 60s is imperceptible for a recipe; a PATCH clears
// the affected batch's entries so a write shows fresh immediately.
const READ_TTL = Number(process.env.READ_TTL_SEC || 60) * 1000;
const _reads = new Map(); // key → { at, val }
async function cached(key, fn) {
  const hit = _reads.get(key);
  if (hit && Date.now() - hit.at < READ_TTL) return hit.val;
  const val = await fn();
  _reads.set(key, { at: Date.now(), val });
  return val;
}
function invalidate(batchId) {
  for (const k of _reads.keys()) if (k.includes(String(batchId))) _reads.delete(k);
}

// Map the panel's payload (user units) → Brewfather metric field set. Only include
// fields the user actually provided (BF does a shallow merge; omit = leave as-is).
function toBrewfatherPatch(body) {
  const out = {};
  // gravities are unit-agnostic SG — pass straight through, clamped to BF's range
  const sg = (v) => { const x = n(v); return x != null && x >= 0.1 && x <= 1.9 ? x : undefined; };
  if (sg(body.preBoilGravity) !== undefined) out.measuredPreBoilGravity = sg(body.preBoilGravity);
  if (sg(body.postBoilGravity) !== undefined) out.measuredPostBoilGravity = sg(body.postBoilGravity);
  if (sg(body.og) !== undefined) out.measuredOg = sg(body.og);
  if (sg(body.fg) !== undefined) out.measuredFg = sg(body.fg);
  // pH 0-14, unit-agnostic
  const ph = n(body.mashPh);
  if (ph != null && ph >= 0 && ph <= 14) out.measuredMashPh = ph;
  // volumes: panel sends GALLONS → BF wants LITERS
  const vol = (v) => { const x = n(v); return x != null && x >= 0 ? galToL(x) : undefined; };
  if (vol(body.boilSizeGal) !== undefined) out.measuredBoilSize = vol(body.boilSizeGal);
  if (vol(body.batchSizeGal) !== undefined) out.measuredBatchSize = vol(body.batchSizeGal);
  if (vol(body.bottlingSizeGal) !== undefined) out.measuredBottlingSize = vol(body.bottlingSizeGal);
  if (vol(body.kettleSizeGal) !== undefined) out.measuredKettleSize = vol(body.kettleSizeGal);
  // status passthrough (validated against BF's enum)
  const STATUSES = ['Planning', 'Brewing', 'Fermenting', 'Conditioning', 'Completed', 'Archived'];
  if (typeof body.status === 'string' && STATUSES.includes(body.status)) out.status = body.status;
  return out;
}

// The BF API paths use the batch _id (a long string), but the dashboard only knows
// the human batchNo (from HA). Resolve batchNo → _id by listing batches. Accepts
// either: if it looks like a _id (long, non-numeric) use it directly; else treat as
// a batchNo and look it up. Cached briefly to stay under the 500/hr rate limit.
let _batchCache = { at: 0, list: [] };
async function bfListBatches() {
  if (Date.now() - _batchCache.at < 60_000 && _batchCache.list.length) return _batchCache.list;
  // include=... keeps the payload small; we only need _id, batchNo, name, status
  const r = await fetch(`${BF}/batches?limit=50&include=batchNo,name,status`, { headers: { Authorization: AUTH } });
  if (!r.ok) throw new Error(`Brewfather list HTTP ${r.status}`);
  const list = await r.json();
  _batchCache = { at: Date.now(), list };
  return list;
}
// resolve a batchNo → _id. Batches move through statuses (Planning→Brewing→
// Fermenting→Conditioning→Completed), and the unfiltered ?limit=50 list can push
// an older Fermenting batch off the end — so a batchNo we can't find in the
// default list isn't necessarily gone. Try, in order: brew-day list (Planning/
// Brewing), the general recent list, then an explicit per-status sweep of the
// ACTIVE statuses (Fermenting/Conditioning) which is where auto-advance operates.
let _statusCache = new Map();  // status → { at, list }
async function bfBatchesByStatus(status) {
  const hit = _statusCache.get(status);
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  // include recipe.name — the batch's own `name` is the generic "Batch"; the real
  // beer name lives on the recipe. Normalize so `name` is always the beer name.
  const r = await fetch(`${BF}/batches?status=${status}&limit=50&include=batchNo,name,status,recipe.name`, { headers: { Authorization: AUTH } });
  if (!r.ok) throw new Error(`Brewfather list (${status}) HTTP ${r.status}`);
  const raw = await r.json();
  const list = raw.map((b) => ({
    _id: b._id, batchNo: b.batchNo, status: b.status,
    name: (b.recipe && b.recipe.name) || b.name || `#${b.batchNo}`,
  }));
  _statusCache.set(status, { at: Date.now(), list });
  return list;
}
async function resolveId(batchIdOrNo) {
  const s = String(batchIdOrNo);
  // a real _id is long + non-numeric; a batchNo is a short integer
  if (!/^\d{1,6}$/.test(s)) return s;
  // brew-day batches (Planning/Brewing) are the primary use; check those first
  // (this is also what the picker offered), then fall back to the general list.
  try {
    const bd = await bfBrewDayBatches();
    const hitBd = bd.find((b) => String(b.batchNo) === s);
    if (hitBd) return hitBd._id;
  } catch { /* fall through */ }
  const list = await bfListBatches();
  const hit = list.find((b) => String(b.batchNo) === s);
  if (hit) return hit._id;
  // not in the default list → sweep statuses explicitly (a batch older than the 50
  // most-recent won't appear above but is real). MUST include Completed/Archived:
  // once a batch is completed it leaves the active statuses, and we still need to
  // resolve it (to correct an FG, re-read its record, etc.). Omitting Completed made
  // a just-completed batch un-resolvable → PATCH 'no batch with number N'.
  for (const status of ['Fermenting', 'Conditioning', 'Completed', 'Archived']) {
    try {
      const byStatus = await bfBatchesByStatus(status);
      const h = byStatus.find((b) => String(b.batchNo) === s);
      if (h) return h._id;
    } catch { /* try next status */ }
  }
  throw new Error(`no Brewfather batch with number ${s}`);
}

async function bfPatchBatch(batchIdOrNo, patch) {
  const id = await resolveId(batchIdOrNo);
  const r = await fetch(`${BF}/batches/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Authorization: AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) throw new Error(`Brewfather HTTP ${r.status}: ${text.slice(0, 200)}`);
  return json;
}

// ---- CONDITIONING duration --------------------------------------------------
// After fermentation confirms terminal, the beer conditions for a while before
// it's ready to keg. Duration priority (per design):
//   1. BF fermentation-profile POST-fermentation time steps (Conditioning / Lager
//      / Secondary / Cold Crash) — if the brewer actually planned them.
//   2. YEAST TYPE is the primary signal (a lager yeast physically needs cold
//      lagering regardless of the profile/style label), refined by style: a dark/
//      strong lager conditions longer than a pale one. Ale → short.
//   3. (manual override lives in GlassHaus, applied there — not here.)
// This is a TIME countdown, deliberately separate from the gravity-driven ferm
// program — it never touches setpoints, so it can't clash with a generated plan.
const POST_FERMENT_STEP = /^(condition|lager|secondary|cold\s*crash)/i;
function conditioningPlan(batch, rec) {
  const f = (rec && rec.fermentation) || batch.fermentation || {};
  const steps = Array.isArray(f.steps) ? f.steps : [];
  // 1) explicit post-fermentation time steps in the BF profile
  const profileDays = steps
    .filter((s) => typeof s.type === 'string' && POST_FERMENT_STEP.test(s.type))
    .reduce((sum, s) => sum + (n(s.stepTime) || 0), 0);

  const yeasts = Array.isArray(rec && rec.yeasts) ? rec.yeasts : [];
  // most-attenuative / first yeast drives the type; lager beats ale if mixed
  const yeastType = yeasts.some((y) => /lager/i.test(String(y.type))) ? 'Lager'
    : yeasts.some((y) => /ale/i.test(String(y.type))) ? 'Ale'
    : (yeasts[0] && yeasts[0].type) || null;
  const style = (rec && rec.style && (rec.style.name || rec.style.type)) || null;
  const styleStr = String(style || '');
  const isLagerYeast = yeastType === 'Lager';
  const dark = /dark|black|schwarz|dunkel|baltic|bock/i.test(styleStr);
  const strong = /imperial|double|strong|barleywine|bock|baltic/i.test(styleStr);

  // 2) yeast-type default, refined by style
  let styleDefault;
  if (isLagerYeast) styleDefault = (dark || strong) ? 28 : 21;   // lager: 3-4 wk
  else styleDefault = strong ? 14 : 7;                            // ale: ~1 wk (2 if big)

  const conditionDays = profileDays > 0 ? profileDays : styleDefault;
  const source = profileDays > 0 ? 'bf-profile'
    : isLagerYeast ? 'yeast-lager' : (yeastType === 'Ale' ? 'yeast-ale' : 'style-default');
  return { conditionDays, source, yeastType, style };
}

// read a batch's current measured values so the panel can prefill (also confirms
// the key works). Returns just the measured/status fields we care about.
async function bfGetBatch(batchIdOrNo) {
  const batchId = await resolveId(batchIdOrNo);
  return cached(`get:${batchId}`, async () => {
  // complete=true pulls the embedded recipe so we can read the hop schedule and
  // decide dryHop from TRUTH (a "Dry Hop" use in the schedule) rather than guessing
  // from the batch name — the programs container uses this to set the 6d vs 3d
  // terminal-confirmation window (hop creep) and to gate the Conditioning flip.
  // fetch the batch AND its readings in parallel. readings give the app the full
  // gravity/temp CURVE so a conditioning batch (dropped from the HA feed) can still
  // be GRAPHED — without this the fallback batch had empty history and the Graphs
  // view showed "no fermenting batches" the moment a batch conditioned.
  const [r, rr] = await Promise.all([
    fetch(`${BF}/batches/${encodeURIComponent(batchId)}?complete=true`, { headers: { Authorization: AUTH } }),
    fetch(`${BF}/batches/${encodeURIComponent(batchId)}/readings`, { headers: { Authorization: AUTH } }),
  ]);
  if (!r.ok) throw new Error(`Brewfather HTTP ${r.status}`);
  const b = await r.json();
  // normalize readings → { t(ms), sg, tempF }, oldest→newest, drop junk
  let history = [];
  if (rr.ok) {
    const raw = await rr.json();
    if (Array.isArray(raw)) {
      history = raw
        .map((x) => ({ t: Number(x.time), sg: Number(x.sg), tempF: n(x.temp) != null ? +(x.temp * 9 / 5 + 32).toFixed(1) : null }))
        .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.sg) && x.tempF != null)
        .sort((a, z) => a.t - z.t);
    }
  }
  const Lto = (v) => (n(v) != null ? +(v / 3.785411784).toFixed(2) : null); // L→gal for display
  const rec = b.recipe || {};
  const hops = Array.isArray(rec.hops) ? rec.hops : [];
  const dryHop = hops.some((h) => typeof h.use === 'string' && /dry\s*hop/i.test(h.use));
  const cond = conditioningPlan(b, rec);
  return {
    id: b._id, name: (rec.name || b.name), batchNo: b.batchNo, status: b.status, dryHop,
    // conditioning duration inputs + resolved target (see conditioningPlan)
    yeastType: cond.yeastType, style: cond.style,
    conditionDays: cond.conditionDays, conditionSource: cond.source,
    // display fields the app needs to keep showing a batch once it leaves
    // Fermenting (the HA integration drops non-Fermenting batches, so the app
    // falls back to this endpoint). Timestamps as epoch ms; og as SG.
    og: b.measuredOg ?? b.estimatedOg ?? null,
    fermentingStart: b.fermentingStart ? Date.parse(b.fermentingStart) : null,
    fermentingEnd: b.fermentingEnd ? Date.parse(b.fermentingEnd) : null,
    history,
    measured: {
      preBoilGravity: b.measuredPreBoilGravity ?? null,
      postBoilGravity: b.measuredPostBoilGravity ?? null,
      og: b.measuredOg ?? null,
      fg: b.measuredFg ?? null,
      mashPh: b.measuredMashPh ?? null,
      boilSizeGal: Lto(b.measuredBoilSize),
      batchSizeGal: Lto(b.measuredBatchSize),
      bottlingSizeGal: Lto(b.measuredBottlingSize),
    },
  };
  });
}

// Brew-day batches: Planning + Brewing (the statuses HA's integration doesn't
// surface — HA only pulls active fermentations). Status filter is single-value, so
// two calls, merged. Small cache to respect the 500/hr limit.
let _brewdayCache = { at: 0, list: null };
async function bfBrewDayBatches() {
  if (Date.now() - _brewdayCache.at < 30_000 && _brewdayCache.list) return _brewdayCache.list;
  const out = [];
  for (const status of ['Planning', 'Brewing']) {
    const r = await fetch(`${BF}/batches?status=${status}&limit=25`, { headers: { Authorization: AUTH } });
    if (!r.ok) throw new Error(`Brewfather list (${status}) HTTP ${r.status}`);
    for (const b of await r.json()) out.push({ _id: b._id, batchNo: b.batchNo, name: b.name, status: b.status });
  }
  _brewdayCache = { at: Date.now(), list: out };
  return out;
}

// ---- recipe PREP data for brew day: grain bill, water, salts, hops -------------
// Amounts come metric (fermentables kg, hops/salts g); the dashboard converts for
// display. Water volumes: BF often leaves mash/spargeWaterAmount null, so fall back
// to the computed adjustment volumes.
async function bfRecipePrep(batchIdOrNo) {
  const id = await resolveId(batchIdOrNo);
  return cached(`recipe:${id}`, async () => {
  const r = await fetch(`${BF}/batches/${encodeURIComponent(id)}?complete=true`, { headers: { Authorization: AUTH } });
  if (!r.ok) throw new Error(`Brewfather HTTP ${r.status}`);
  const b = await r.json();
  const rec = b.recipe || {};
  const w = rec.water || {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const mashL = num(w.mashWaterAmount) ?? num(w.mashAdjustments?.volume);
  const spargeL = num(w.spargeWaterAmount) ?? num(w.spargeAdjustments?.volume);
  const miscs = Array.isArray(rec.miscs) ? rec.miscs : [];
  return {
    name: rec.name || b.name, batchNo: b.batchNo, style: rec.style?.name || null,
    batchSizeL: num(rec.batchSize), boilSizeL: num(rec.boilSize), boilTime: num(rec.boilTime),
    fermentables: (rec.fermentables || []).map((f) => ({ name: f.name, kg: num(f.amount), type: f.type })),
    hops: (rec.hops || []).map((h) => ({ name: h.name, g: num(h.amount), use: h.use, time: num(h.time), alpha: num(h.alpha), form: h.type })),
    // water agents (salts/acids) vs other mash miscs — keep unit BF provides (g/ml)
    salts: miscs.filter((m) => m.type === 'Water Agent').map((m) => ({ name: m.name, amount: num(m.amount), unit: m.unit || 'g', use: m.use })),
    otherMiscs: miscs.filter((m) => m.type !== 'Water Agent').map((m) => ({ name: m.name, amount: num(m.amount), unit: m.unit || 'g', use: m.use, type: m.type })),
    water: { mashL, spargeL },
    mashSteps: (rec.mash?.steps || []).map((s) => ({ name: s.name, tempC: num(s.stepTemp), min: num(s.stepTime) })),
    // TARGET/expected values from the recipe, so brew-day entry shows "target X" next
    // to each field. Gravities unit-agnostic SG; volumes L→gal for the panel.
    target: {
      preBoilGravity: num(rec.preBoilGravity),
      postBoilGravity: num(rec.postBoilGravity),
      og: num(rec.og) ?? num(b.estimatedOg),
      fg: num(rec.fg) ?? num(b.estimatedFg),
      mashPh: num(w.mashPh),
      boilSizeGal: num(rec.boilSize) != null ? +(rec.boilSize * 0.2641720524).toFixed(2) : null,
      batchSizeGal: num(rec.batchSize) != null ? +(rec.batchSize * 0.2641720524).toFixed(2) : null,
    },
  };
  });
}

// ---- Claude-generated fermentation plan ---------------------------------------
// Gathers the batch's YEAST spec + style + gravities (full recipe from BF) and asks
// Claude for a strain/style-aware temp-step plan whose advances key off REAL
// attenuation (as % of the strain's expected attenuation), not the calendar. The
// returned plan is a STARTING POINT the user edits before it runs. Cold crash is
// always gated. Amounts stay SG/°F for the UI; the runner enforces the clamp.
const PLAN_SYSTEM = `You are a master brewer designing a FERMENTATION TEMPERATURE plan for one batch,
grounded in modern practice (Brülosophy findings, yeast-lab guidance, general craft consensus).

You are given the YEAST (name, lab, type, expected attenuation %, min/max temp °C), the STYLE,
and OG/expected FG. Design an ordered set of temperature STEPS that fits THIS yeast and style.

RULES:
- FLAVOR INTENT DRIVES THE TEMPS. The user's target profile (given in the message) is a PRIMARY
  input: cooler suppresses esters/phenols (cleaner), warmer + warmer PITCH expresses them (fruity/
  estery/phenolic). A hefe pitched cool→clove-ish, warm→banana. If they want "clean" run cool and
  rise only to finish; if "fruity/estery" pitch warmer and free-rise sooner; match the goal.
- Output temps in °F. Respect the yeast's min/max temp range (converted from °C).
- Advances key off REAL fermentation data, NOT days. Use advance type
  "attenuationOfExpected" with pct = % OF THIS STRAIN'S expected attenuation (e.g. pct:80 means
  80% of the strain's expected attenuation reached). Early primary steps advance mid-way; the
  free-rise/D-rest step advances at "terminal" (gravity flat near FG). This handles slow starts.
- Include a free-rise / diacetyl-rest step when the style/yeast benefits (most ales & lagers);
  lagers stay cool then rise; kveik runs warm; hazy/NEIPA free-rise for biotransformation.
- End with a conditioning hold, then a cold-crash step. The cold-crash step MUST have
  requiresConfirm:true (the brewer tastes & confirms before crashing — never auto).
- clamp.maxF must not exceed the yeast's max temp; for any lager, clamp.maxF <= 70.
- Every step needs a short "why" (the reasoning shown to the brewer).

Primitives: hold {tempF} | ramp {stepF, everyHours, targetF} | wait {hours} | coldCrash
{targetF, stepF, everyHours}. Advance types: attenuationOfExpected {pct} | terminal | active |
elapsed {hours} | confirm. Output ONLY valid JSON (no markdown, no fences), EXACTLY:
{"summary":"<=90 chars","expectedAtten":<strain expected attenuation %>,"clamp":{"minF":N,"maxF":N},
 "phases":[{"name":"...","kind":"hold|ramp|wait|coldCrash","tempF":N,"targetF":N,"stepF":N,
 "everyHours":N,"hours":N,"advance":{"type":"...","pct":N,"hours":N},"requiresConfirm":bool,"why":"..."}]}`;

// pull the batch's yeast+style facts (shared by intents + plan generation)
async function batchFacts(id) {
  const r = await fetch(`${BF}/batches/${encodeURIComponent(id)}?complete=true`, { headers: { Authorization: AUTH } });
  if (!r.ok) throw new Error(`Brewfather HTTP ${r.status}`);
  const b = await r.json(); const rec = b.recipe || {};
  const yeasts = (rec.yeasts || []).map((y) => ({
    name: y.name, lab: y.laboratory, productId: y.productId, type: y.type, form: y.form,
    attenuation: y.attenuation ?? y.maxAttenuation ?? null, minTempC: y.minTemp, maxTempC: y.maxTemp,
    flocculation: y.flocculation,
  }));
  return {
    batchNo: b.batchNo, style: rec.style?.name || null, name: rec.name || b.name,
    og: rec.og ?? b.estimatedOg ?? null, expectedFg: rec.fg ?? b.estimatedFg ?? null, yeasts,
  };
}

// yeast-aware FLAVOR INTENT suggestions — Claude proposes the sensible flavor goals
// for THIS strain (e.g. hefe → Banana/Clove/Balanced; US-05 → Clean/Slight fruit).
async function suggestIntents(batchIdOrNo) {
  if (!ANTHROPIC_KEY) throw new Error('no ANTHROPIC_API_KEY');
  const facts = await batchFacts(await resolveId(batchIdOrNo));
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: PLAN_MODEL, max_tokens: 400,
      system: `Given a yeast strain + style, list the 3-5 realistic FLAVOR-PROFILE intents a brewer
might target with THIS yeast (temperature drives ester/phenol expression). E.g. a hefeweizen yeast
→ "Banana-forward","Clove-forward","Balanced"; a clean American ale yeast → "Clean/neutral","Slight
fruit","Max attenuation". Output ONLY JSON: {"intents":[{"label":"...","hint":"how temp achieves it"}]}`,
      messages: [{ role: 'user', content: JSON.stringify({ style: facts.style, yeasts: facts.yeasts }) }] }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  const text = (j.content?.[0]?.text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { intents: [] }; }
  return { batchNo: facts.batchNo, yeast: facts.yeasts[0]?.name || null, intents: parsed.intents || [] };
}

async function generatePlan(batchIdOrNo, intent, notes) {
  if (!ANTHROPIC_KEY) throw new Error('no ANTHROPIC_API_KEY set on the brewfather container');
  const id = await resolveId(batchIdOrNo);
  const facts = await batchFacts(id);
  const yeasts = facts.yeasts;
  const goal = [intent && `Target flavor profile: ${intent}.`, notes && `Brewer notes: ${notes}.`]
    .filter(Boolean).join(' ') || 'No specific flavor target — brew it to style.';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: PLAN_MODEL, max_tokens: 1200, system: PLAN_SYSTEM,
      messages: [{ role: 'user', content: `${goal}\n\nDesign a fermentation plan for:\n${JSON.stringify(facts, null, 1)}` }] }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${j.error.type}: ${j.error.message}`);
  const text = (j.content?.[0]?.text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let plan; try { plan = JSON.parse(text); } catch { throw new Error('Claude returned unparseable plan'); }
  // ensure expectedAtten present (fall back to the strain spec) + gate any cold crash
  if (plan.expectedAtten == null && yeasts[0]?.attenuation != null) plan.expectedAtten = yeasts[0].attenuation;
  for (const ph of (plan.phases || [])) if (ph.kind === 'coldCrash') ph.requiresConfirm = true;
  return { ...plan, batchNo: facts.batchNo, yeast: yeasts[0]?.name || null };
}

createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return; }
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, CORS).end('ok'); return; }

  // GET /fermplan-intents/:id → yeast-aware flavor-profile intent options
  const intentsMatch = req.method === 'GET' && req.url?.match(/^\/fermplan-intents\/([^/?]+)/);
  if (intentsMatch) {
    (async () => {
      try {
        if (!ANTHROPIC_KEY) return sendJson(res, 501, { error: 'not configured (no Anthropic key)' });
        sendJson(res, 200, await suggestIntents(decodeURIComponent(intentsMatch[1])));
      } catch (e) { sendJson(res, 502, { error: e.message }); }
    })();
    return;
  }

  // POST /fermplan/:id {intent, notes} → Claude-generated plan (starting point to edit)
  const planMatch = req.method === 'POST' && req.url?.match(/^\/fermplan\/([^/?]+)/);
  if (planMatch) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        if (!ANTHROPIC_KEY) return sendJson(res, 501, { error: 'ferm-plan generation not configured (no Anthropic key)' });
        let p = {}; try { p = JSON.parse(body || '{}'); } catch { /* no body ok */ }
        const plan = await generatePlan(decodeURIComponent(planMatch[1]), p.intent, p.notes);
        console.log(`[brewfather] generated ferm plan for batch ${planMatch[1]} (${plan.phases?.length} steps, intent=${p.intent || 'none'})`);
        sendJson(res, 200, plan);
      } catch (e) {
        console.error('[brewfather] fermplan failed:', e.message);
        sendJson(res, 502, { error: e.message });
      }
    });
    return;
  }

  // GET /recipe/:id → brew-day prep (grain/water/salts/hops), amounts metric
  const recipeMatch = req.method === 'GET' && req.url?.match(/^\/recipe\/([^/?]+)/);
  if (recipeMatch) {
    bfRecipePrep(decodeURIComponent(recipeMatch[1]))
      .then((p) => sendJson(res, 200, p))
      .catch((e) => sendJson(res, 502, { error: e.message }));
    return;
  }

  // GET /assignable → batches that live IN a fermenter (Fermenting + Conditioning),
  // the tank-view batch picker's source. Must come from HERE not the HA feed: the
  // HA Brewfather integration only surfaces FERMENTING batches, so once every batch
  // conditions the HA feed is empty and the picker had nothing to offer. This sees
  // all statuses. Names are the real recipe name (not "Batch").
  if (req.method === 'GET' && req.url?.startsWith('/assignable')) {
    Promise.all([bfBatchesByStatus('Fermenting'), bfBatchesByStatus('Conditioning')])
      .then(([f, c]) => sendJson(res, 200, { batches: [...f, ...c] }))
      .catch((e) => sendJson(res, 502, { error: e.message }));
    return;
  }

  // GET /batches → Planning + Brewing batches for the Brew Day picker
  if (req.method === 'GET' && req.url?.startsWith('/batches')) {
    bfBrewDayBatches()
      .then((list) => sendJson(res, 200, { batches: list }))
      .catch((e) => sendJson(res, 502, { error: e.message }));
    return;
  }

  // GET /batch/:id  → current measured values (prefill)
  const getMatch = req.method === 'GET' && req.url?.match(/^\/batch\/([^/?]+)/);
  if (getMatch) {
    bfGetBatch(decodeURIComponent(getMatch[1]))
      .then((b) => sendJson(res, 200, b))
      .catch((e) => sendJson(res, 502, { error: e.message }));
    return;
  }

  // POST /batch/:id/status  → advance the batch's Brewfather status (e.g. Brewing).
  // Deliberate, one intended transition per call; validated against BF's enum.
  const statusMatch = req.method === 'POST' && req.url?.match(/^\/batch\/([^/?]+)\/status/);
  if (statusMatch) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let parsed; try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      const STATUSES = ['Planning', 'Brewing', 'Fermenting', 'Conditioning', 'Completed', 'Archived'];
      if (!STATUSES.includes(parsed.status)) return sendJson(res, 400, { error: 'invalid status' });
      try {
        const arg = decodeURIComponent(statusMatch[1]);
        await bfPatchBatch(arg, { status: parsed.status });
        try { invalidate(await resolveId(arg)); } catch { /* ignore */ }
        // also drop the brew-day list cache so the batch's new status shows fast
        _brewdayCache = { at: 0, list: null };
        console.log(`[brewfather] status → ${parsed.status} on batch ${arg}`);
        sendJson(res, 200, { ok: true, status: parsed.status });
      } catch (e) {
        console.error('[brewfather] status write failed:', e.message);
        sendJson(res, 502, { error: e.message });
      }
    });
    return;
  }

  // POST /batch/:id/complete → the manual "Complete batch" action. Captures the
  // FULL record to the batch DB (measured + temp/gravity curve + summary) AND writes
  // the WRITABLE subset back to Brewfather (status→Completed + measuredFg). Body may
  // include { fg, daysConditioned, profileId, planJson } that GlassHaus knows.
  const completeMatch = req.method === 'POST' && req.url?.match(/^\/batch\/([^/?]+)\/complete/);
  if (completeMatch) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let parsed; try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      try {
        const arg = decodeURIComponent(completeMatch[1]);
        const bf = await bfGetBatch(arg);                 // measured + recipe + curve
        const fg = n(parsed.fg) ?? bf.measured?.fg ?? null; // terminal gravity to record
        // 1) capture the complete record to the DB
        const extra = { completed_at: Date.now(), days_conditioned: n(parsed.daysConditioned) ?? null };
        if (parsed.profileId != null) extra.profile_id = parsed.profileId;
        if (parsed.planJson) extra.plan_json = typeof parsed.planJson === 'string' ? parsed.planJson : JSON.stringify(parsed.planJson);
        if (fg != null) { bf.measured = { ...(bf.measured || {}), fg }; }
        const cap = captureBatch(bf, extra);
        addEvent(cap.batchId, 'complete', `fg=${fg ?? '?'}`);
        // 2) write the WRITABLE subset back to Brewfather (status + measuredFg)
        const patch = { status: 'Completed' };
        if (fg != null) patch.fg = fg;
        await bfPatchBatch(arg, patch);
        try { invalidate(await resolveId(arg)); } catch { /* ignore */ }
        _brewdayCache = { at: 0, list: null };
        console.log(`[brewfather] COMPLETE batch ${arg}: DB record #${cap.batchId}, ${cap.readingsInserted} readings, BF status→Completed fg=${fg}`);
        sendJson(res, 200, { ok: true, batchId: cap.batchId, readingsCaptured: cap.readingsInserted, fg, bf: 'Completed' });
      } catch (e) {
        console.error('[brewfather] complete failed:', e.message);
        sendJson(res, 502, { error: e.message });
      }
    });
    return;
  }

  // GET /history → list captured batches (for the metrics/history view)
  if (req.method === 'GET' && req.url?.startsWith('/history')) {
    try { sendJson(res, 200, { batches: listBatches(200) }); }
    catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  // GET /record/:batchNo → one batch's full DB record (batch + readings + tastings)
  const recordMatch = req.method === 'GET' && req.url?.match(/^\/record\/(\d+)/);
  if (recordMatch) {
    try {
      const b = getBatch(Number(recordMatch[1]));
      if (!b) return sendJson(res, 404, { error: 'not captured' });
      sendJson(res, 200, { batch: b, readings: getReadings(b.id), tastings: getTastings(b.id) });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  // POST /record/:batchNo/tasting → log a tasting/outcome observation
  const tastingMatch = req.method === 'POST' && req.url?.match(/^\/record\/(\d+)\/tasting/);
  if (tastingMatch) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed; try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      try {
        const b = getBatch(Number(tastingMatch[1]));
        if (!b) return sendJson(res, 404, { error: 'batch not captured — complete it first' });
        addTasting(b.id, parsed);
        sendJson(res, 200, { ok: true, tastings: getTastings(b.id).length });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    });
    return;
  }

  // PATCH /batch/:id  → write measured values (body in user units)
  const patchMatch = req.method === 'PATCH' && req.url?.match(/^\/batch\/([^/?]+)/);
  if (patchMatch) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let parsed; try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      const patch = toBrewfatherPatch(parsed);
      if (!Object.keys(patch).length) return sendJson(res, 400, { error: 'no valid fields to write' });
      try {
        const arg = decodeURIComponent(patchMatch[1]);
        const result = await bfPatchBatch(arg, patch);
        // clear cached reads for this batch so the write shows fresh immediately
        try { invalidate(await resolveId(arg)); } catch { /* ignore */ }
        console.log(`[brewfather] wrote ${Object.keys(patch).join(',')} to batch ${arg}`);
        sendJson(res, 200, { ok: true, wrote: Object.keys(patch), result });
      } catch (e) {
        console.error('[brewfather] write failed:', e.message);
        sendJson(res, 502, { error: e.message });
      }
    });
    return;
  }

  res.writeHead(404, CORS).end('not found');
}).listen(PORT, () => console.log(`[brewfather] write service on :${PORT}`));
