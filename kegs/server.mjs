// GlassHaus keg-management service — HTTP surface. Two faces:
//   1. JSON API (/api/*) — consumed by the GlassHaus SPA's Kegs/Taps section.
//   2. HTML keg pages (/kegs/:id) — what a phone opens when it scans a keg's QR sticker:
//      a self-contained mobile page showing that keg's state + quick-action buttons.
// On any state change we mirror a summary to HA (sensor.keg_* / sensor.tap_*) so HA
// dashboards + alerts + the future taplist can read it. Zero runtime deps (node:sqlite +
// pre-generated QR svgs). Pattern mirrors analyzer/server.mjs.

import { createServer } from 'node:http';
import * as db from './db.mjs';
import * as K from './kegs.mjs';
import { kegUrl, kegQrSvg } from './qr.mjs';
import { pushAll } from './ha.mjs';

const PORT = Number(process.env.PORT || 8097);
const BASE_URL = (process.env.BASE_URL || 'https://unraid.tail229434.ts.net').replace(/\/$/, '');
const TAP_COUNT = K.TAP_COUNT;

// ── boot: ensure the fleet + taps exist (idempotent seed) ──
const nowIso = () => new Date().toISOString();
function seedIfEmpty() {
  db.db();
  db.ensureTaps(TAP_COUNT, nowIso());
  if (db.listKegs().length === 0) {
    const at = nowIso();
    for (let i = 1; i <= Number(process.env.SEED_KEGS || 10); i++) {
      db.createKeg({ id: `keg-${String(i).padStart(3, '0')}`, label: `Keg ${i}`, at });
    }
    console.log(`[kegs] seeded ${process.env.SEED_KEGS || 10} kegs`);
  }
}

// ── HA mirror: push one keg's (or tap's) summary. Best-effort, fire-and-forget-safe. ──
async function mirrorKeg(id) {
  const keg = db.getKeg(id); if (!keg) return;
  await pushAll(K.haMirror(keg, Date.now()));
}
async function mirrorTap(tap) {
  const t = db.getTap(tap); if (!t) return;
  await pushAll(K.tapMirror(t, Date.now()));
}

// ── JSON helpers ──
const CORS = { 'Access-Control-Allow-Origin': process.env.ALLOW_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (res, code, obj) => res.writeHead(code, { 'content-type': 'application/json', ...CORS }).end(JSON.stringify(obj));
const html = (res, code, body) => res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...CORS }).end(body);
function readBody(req) {
  return new Promise((resolve) => { const ch = []; req.on('data', (d) => ch.push(d));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString() || '{}')); } catch { resolve(null); } }); req.on('error', () => resolve(null)); });
}

// enrich a keg row with computed health for API/UI
const withHealth = (keg) => ({ ...keg, health: K.kegHealth(keg, Date.now()) });
const withTapHealth = (t) => ({ ...t, health: K.tapHealth(t, Date.now()) });

// ── action dispatch (shared by API + HTML form posts) ──
// Returns { ok, keg?/tap?, warn?, error? }. Every action appends to the log + mirrors HA.
async function doKegAction(id, action, params = {}) {
  const keg = db.getKeg(id);
  if (!keg) return { ok: false, error: 'no such keg' };
  const at = nowIso();
  try {
    if (action === 'clean') {
      const { patch, event } = K.applyTransition(keg, 'clean', { at, cleanType: params.cleanType });
      db.patchKeg(id, patch, at); db.addEvent(id, event);
    } else if (['dirty', 'empty', 'retired', 'clean', 'filled', 'tapped'].includes(action) && action !== 'clean') {
      const { patch, event } = K.applyTransition(keg, action, { at, tap: params.tap != null ? Number(params.tap) : undefined,
        beer: params.beer, cleanType: params.cleanType });
      db.patchKeg(id, patch, at); db.addEvent(id, event);
    } else if (action === 'seal') {
      const { patch, event } = K.replaceSeal(keg, params.sealType, { at });
      db.patchKeg(id, patch, at); db.addEvent(id, event);
    } else if (action === 'tap') {
      // tap onto a faucet: transition keg→tapped, link the tap, check the line
      const tapNo = Number(params.tap);
      const tapLine = db.getTap(tapNo);
      const { warn, tapPatch, tapEvent } = K.tapOnto(keg, tapNo, tapLine, { at });
      const { patch, event } = K.applyTransition(keg, 'tapped', { at, tap: tapNo });
      db.patchKeg(id, patch, at); db.addEvent(id, event);
      db.patchTap(tapNo, tapPatch, at); db.addTapEvent(tapNo, tapEvent);
      await Promise.all([mirrorKeg(id), mirrorTap(tapNo)]);
      return { ok: true, keg: withHealth(db.getKeg(id)), warn };
    } else if (action === 'kegBatch') {
      const { patch, event } = K.kegBatch(keg, params.batch || {}, { at, sourceTank: params.sourceTank });
      db.patchKeg(id, patch, at); db.addEvent(id, event);
    } else if (action === 'note') {
      db.addEvent(id, { action: 'note', at, detail: { text: String(params.text || '') } });
    } else {
      return { ok: false, error: `unknown action "${action}"` };
    }
    await mirrorKeg(id);
    return { ok: true, keg: withHealth(db.getKeg(id)) };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function doTapAction(tap, action, params = {}) {
  const t = db.getTap(tap);
  if (!t) return { ok: false, error: 'no such tap' };
  const at = nowIso();
  if (action === 'cleanLine') {
    const { patch, event } = K.cleanTapLine(t, { at });
    db.patchTap(tap, patch, at); db.addTapEvent(tap, event);
    await mirrorTap(tap);
    return { ok: true, tap: withTapHealth(db.getTap(tap)) };
  }
  return { ok: false, error: `unknown tap action "${action}"` };
}

// ── HTML: the mobile keg page a QR scan opens ──
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function kegPageHtml(keg) {
  const h = K.kegHealth(keg, Date.now());
  const sevColor = { ok: '#3ad29f', warning: '#f5a623', critical: '#ff4d5e' }[h.severity] || '#8b95a1';
  const chip = (label, val, warn) => `<div class="chip${warn ? ' warn' : ''}"><span>${esc(label)}</span><b>${esc(val)}</b></div>`;
  const btn = (action, label, extra = '') => `<button onclick="act('${action}'${extra})">${esc(label)}</button>`;
  const sealRow = K.SEAL_TYPES.map((t) => {
    const s = h.seals[t];
    const age = s.ageDays == null ? 'never' : `${s.ageDays}d`;
    const cls = s.due ? 'warn' : s.soon ? 'soon' : '';
    return `<div class="seal ${cls}"><span>${t} o-ring</span><b>${age}${s.due ? ' — DUE' : s.soon ? ' — soon' : ''}</b>
      <button onclick="act('seal',\`,sealType:'${t}'\`)">replace</button></div>`;
  }).join('');
  const events = db.kegEvents(keg.id, 8).map((e) =>
    `<li><span>${esc(e.at.slice(0, 16).replace('T', ' '))}</span> ${esc(e.action)}${e.detail?.batch ? ` · ${esc(e.detail.batch)}` : ''}${e.detail?.sealType ? ` · ${esc(e.detail.sealType)}` : ''}</li>`).join('');
  const tapOptions = Array.from({ length: TAP_COUNT }, (_, i) => `<option value="${i + 1}">Tap ${i + 1}</option>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>${esc(keg.label)} · GlassHaus Kegs</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0b0d0f;color:#e9edf2;padding:16px;max-width:520px;margin:0 auto}
  h1{font-size:22px;margin:4px 0 2px} .id{font-family:ui-monospace,monospace;color:#7d8894;font-size:13px}
  .status{display:inline-block;padding:4px 12px;border-radius:20px;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:1px;margin:10px 0;background:${sevColor}22;color:${sevColor};border:1px solid ${sevColor}66}
  .beer{font-size:16px;font-weight:600;margin:6px 0}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}
  .chip{background:#161a1f;border:1px solid #232a31;border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}
  .chip span{font-size:11px;color:#7d8894;text-transform:uppercase;letter-spacing:.5px} .chip b{font-size:15px}
  .chip.warn{border-color:#f5a62366;background:#f5a62311} .chip.warn b{color:#f5a623}
  .seal{display:flex;align-items:center;gap:8px;background:#161a1f;border:1px solid #232a31;border-radius:10px;padding:8px 10px;margin:6px 0}
  .seal span{flex:1;font-size:13px;text-transform:capitalize} .seal b{font-size:13px} .seal.warn{border-color:#ff4d5e66} .seal.warn b{color:#ff4d5e} .seal.soon b{color:#f5a623}
  .seal button,.actions button{background:#1f2933;color:#e9edf2;border:1px solid #313d47;border-radius:8px;padding:8px 12px;font-size:13px;cursor:pointer}
  .actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}
  .actions button.primary{background:${sevColor}22;border-color:${sevColor}66;color:${sevColor};font-weight:700}
  h3{font-size:13px;color:#7d8894;text-transform:uppercase;letter-spacing:1px;margin:18px 0 6px}
  ul{list-style:none;padding:0;margin:0;font-size:12px;color:#9aa5b1} ul li{padding:4px 0;border-bottom:1px solid #161a1f} ul li span{color:#5a6570;font-family:ui-monospace,monospace}
  select{background:#161a1f;color:#e9edf2;border:1px solid #313d47;border-radius:8px;padding:8px;font-size:14px}
  #msg{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#1f2933;border:1px solid #313d47;border-radius:10px;padding:10px 16px;font-size:13px;opacity:0;transition:.2s;pointer-events:none}
  #msg.show{opacity:1}
  a.qr{display:inline-block;margin-top:10px;color:#4fd1e8;font-size:12px}
</style></head><body>
  <div class="id">${esc(keg.id)} · ${esc(keg.type || 'corny')}${keg.size_l ? ` · ${keg.size_l}L` : ''}</div>
  <h1>${esc(keg.label)}</h1>
  <div class="status">${esc(keg.status)}${keg.tap ? ` · Tap ${keg.tap}` : ''}</div>
  ${keg.beer_batch ? `<div class="beer">🍺 ${esc(keg.beer_batch)}${keg.beer_style ? ` — ${esc(keg.beer_style)}` : ''}${keg.beer_abv ? ` · ${esc(keg.beer_abv)}%` : ''}</div>` : ''}
  <div class="grid">
    ${chip('cleaned', h.cleanAgeDays == null ? 'never' : `${h.cleanAgeDays}d ago`, h.cleanExpired)}
    ${chip('clean type', keg.clean_type || '—')}
  </div>
  <h3>Seals</h3>${sealRow}
  <h3>Actions</h3>
  <div class="actions">
    ${keg.status === 'dirty' ? btn('clean', '✓ Mark cleaned', ",cleanType:prompt('Clean type? (rinse/caustic/acid/full-cip)','caustic')").replace('<button', '<button class="primary"') : ''}
    ${keg.status === 'clean' ? btn('filled', '🛢 Fill (manual)').replace('<button', '<button class="primary"') : ''}
    ${keg.status === 'filled' ? `<select id="tapsel">${tapOptions}</select>` + btn('tap', '🍺 Tap it', ",tap:document.getElementById('tapsel').value").replace('<button', '<button class="primary"') : ''}
    ${keg.status === 'tapped' ? btn('empty', '💧 Mark empty').replace('<button', '<button class="primary"') : ''}
    ${keg.status === 'empty' ? btn('dirty', '↩ To dirty').replace('<button', '<button class="primary"') : ''}
    ${keg.status !== 'retired' ? btn('retired', '⊘ Retire') : ''}
    ${btn('note', '📝 Note', ",text:prompt('Note?')")}
  </div>
  <h3>History</h3><ul>${events || '<li>no events yet</li>'}</ul>
  <a class="qr" href="/kegs/${esc(keg.id)}/label" target="_blank">⎙ Print label</a>
  <div id="msg"></div>
<script>
  async function act(action, extra){
    const params = {}; ${''/* extra injects fields like ,tap:.. ,sealType:.. */}
    try { eval('Object.assign(params'+(arguments[1]||'')+')'); } catch(e){}
    if (Object.values(params).some(v=>v===null)) return; // cancelled prompt
    const r = await fetch('/api/keg/${esc(keg.id)}/action', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,params})});
    const j = await r.json();
    const m=document.getElementById('msg'); m.textContent = j.warn ? '⚠ '+j.warn : (j.ok?'✓ done':'✗ '+(j.error||'failed')); m.className='show';
    setTimeout(()=>location.reload(), j.warn?2200:700);
  }
</script></body></html>`;
}

// ── router ──
const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return; }
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/health') { res.writeHead(200, CORS).end('ok'); return; }

  // ── JSON API ──
  if (p === '/api/kegs') return json(res, 200, { kegs: db.listKegs().map(withHealth), baseUrl: BASE_URL });
  if (p === '/api/taps') return json(res, 200, { taps: db.listTaps().map(withTapHealth) });

  let m;
  if ((m = p.match(/^\/api\/keg\/([\w-]+)$/))) {
    const keg = db.getKeg(m[1]); if (!keg) return json(res, 404, { error: 'not found' });
    return json(res, 200, { keg: withHealth(keg), events: db.kegEvents(keg.id, 30), qrUrl: kegUrl(BASE_URL, keg.id) });
  }
  if ((m = p.match(/^\/api\/keg\/([\w-]+)\/action$/)) && req.method === 'POST') {
    const body = await readBody(req); if (!body?.action) return json(res, 400, { error: 'action required' });
    return json(res, 200, await doKegAction(m[1], body.action, body.params || {}));
  }
  if ((m = p.match(/^\/api\/tap\/(\d+)\/action$/)) && req.method === 'POST') {
    const body = await readBody(req); if (!body?.action) return json(res, 400, { error: 'action required' });
    return json(res, 200, await doTapAction(Number(m[1]), body.action, body.params || {}));
  }

  // ── HTML keg page (QR target) + label ──
  if ((m = p.match(/^\/kegs\/([\w-]+)\/label$/))) {
    try {
      const svg = await kegQrSvg(m[1]);
      const keg = db.getKeg(m[1]);
      return html(res, 200, `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
        <div style="font-family:system-ui;text-align:center;padding:24px">${svg}
        <div style="font-family:ui-monospace,monospace;font-size:18px;margin-top:8px">${esc(keg?.label || m[1])}</div>
        <div style="color:#888;font-size:12px">${esc(m[1])}</div></div>`);
    } catch (e) { return html(res, 404, `<p>${esc(e.message)}</p>`); }
  }
  if ((m = p.match(/^\/kegs\/([\w-]+)$/))) {
    const keg = db.getKeg(m[1]);
    if (!keg) return html(res, 404, `<!doctype html><meta charset=utf-8><body style="font-family:system-ui;background:#0b0d0f;color:#e9edf2;padding:24px"><h1>Unknown keg</h1><p>${esc(m[1])} isn't in the registry.</p>`);
    return html(res, 200, kegPageHtml(keg));
  }
  if (p === '/kegs' || p === '/') return json(res, 200, { kegs: db.listKegs().map((k) => k.id), hint: 'scan a keg QR or GET /api/kegs' });

  return json(res, 404, { error: 'not found' });
});

seedIfEmpty();
// prime HA mirror for the whole fleet on boot (so sensors exist even before first action)
(async () => { for (const k of db.listKegs()) await mirrorKeg(k.id); for (const t of db.listTaps()) await mirrorTap(t.tap); console.log('[kegs] HA mirror primed'); })().catch((e) => console.error('[kegs] mirror prime failed:', e.message));
server.listen(PORT, () => console.log(`[kegs] GlassHaus keg service on :${PORT} (base ${BASE_URL})`));
