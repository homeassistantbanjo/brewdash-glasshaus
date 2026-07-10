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
// Config via env (NEVER git): BF_USERID, BF_APIKEY, [PORT=8092], [ALLOW_ORIGIN=*].
import { createServer } from 'node:http';

const BF_USERID = required('BF_USERID');
const BF_APIKEY = required('BF_APIKEY');
const PORT = Number(process.env.PORT || 8092);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const BF = 'https://api.brewfather.app/v2';
const AUTH = 'Basic ' + Buffer.from(`${BF_USERID}:${BF_APIKEY}`).toString('base64');

function required(k) {
  const v = process.env[k];
  if (!v) { console.error(`[brewfather] missing required env ${k}`); process.exit(1); }
  return v;
}

const CORS = {
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};
const sendJson = (res, code, obj) =>
  res.writeHead(code, { 'content-type': 'application/json', ...CORS }).end(JSON.stringify(obj));

// ---- unit conversion: the panel sends the user's units; BF wants metric --------
const galToL = (g) => g * 3.785411784;
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

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
async function resolveId(batchIdOrNo) {
  const s = String(batchIdOrNo);
  // a real _id is long + non-numeric; a batchNo is a short integer
  if (!/^\d{1,6}$/.test(s)) return s;
  const list = await bfListBatches();
  const hit = list.find((b) => String(b.batchNo) === s);
  if (!hit) throw new Error(`no Brewfather batch with number ${s}`);
  return hit._id;
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

// read a batch's current measured values so the panel can prefill (also confirms
// the key works). Returns just the measured/status fields we care about.
async function bfGetBatch(batchIdOrNo) {
  const batchId = await resolveId(batchIdOrNo);
  const r = await fetch(`${BF}/batches/${encodeURIComponent(batchId)}`, { headers: { Authorization: AUTH } });
  if (!r.ok) throw new Error(`Brewfather HTTP ${r.status}`);
  const b = await r.json();
  const Lto = (v) => (n(v) != null ? +(v / 3.785411784).toFixed(2) : null); // L→gal for display
  return {
    id: b._id, name: b.name, batchNo: b.batchNo, status: b.status,
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

createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return; }
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, CORS).end('ok'); return; }

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
        const result = await bfPatchBatch(decodeURIComponent(patchMatch[1]), patch);
        console.log(`[brewfather] wrote ${Object.keys(patch).join(',')} to batch ${patchMatch[1]}`);
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
