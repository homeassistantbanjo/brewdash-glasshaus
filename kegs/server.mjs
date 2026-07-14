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
import { comingSoon } from './comingsoon.mjs';

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
      const priorTap = keg.tap;   // if this keg was on a tap, it may be coming OFF it
      const { patch, event } = K.applyTransition(keg, action, { at, tap: params.tap != null ? Number(params.tap) : undefined,
        beer: params.beer, cleanType: params.cleanType });
      db.patchKeg(id, patch, at); db.addEvent(id, event);
      // If the keg left a tap (new status is not 'tapped' and it had a tap), CLEAR that
      // tap's current_keg so the tap-line UI stops showing a beer that isn't connected.
      if (priorTap && patch.status !== 'tapped') {
        const tl = db.getTap(priorTap);
        if (tl && tl.current_keg === id) {
          db.patchTap(priorTap, { current_keg: null }, at);
          db.addTapEvent(priorTap, { action: 'keg-disconnected', at, detail: { keg: id } });
          await mirrorTap(priorTap);
        }
      }
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
  // Buttons carry their action + optional prompt/select wiring as DATA ATTRIBUTES, not by
  // splicing strings into an onclick expression (the old approach produced invalid JS and
  // every input-taking button silently failed). One delegated handler reads the dataset,
  // gathers params, and POSTs. No eval, no string-built call sites.
  //   data-action        the keg action
  //   data-prompt        if set → prompt() with this text; result stored under data-field
  //   data-prompt-default default value for the prompt
  //   data-field         param key the prompt/select value lands under
  //   data-from-select   id of a <select> to read the param value from (for Tap)
  const btn = (action, label, opts = {}) => {
    const attrs = [`data-action="${esc(action)}"`, opts.primary ? 'class="primary"' : ''];
    if (opts.field) attrs.push(`data-field="${esc(opts.field)}"`);
    if (opts.prompt) attrs.push(`data-prompt="${esc(opts.prompt)}"`, `data-prompt-default="${esc(opts.promptDefault || '')}"`);
    if (opts.fromSelect) attrs.push(`data-from-select="${esc(opts.fromSelect)}"`);
    return `<button ${attrs.filter(Boolean).join(' ')}>${esc(label)}</button>`;
  };
  const sealRow = K.SEAL_TYPES.map((t) => {
    const s = h.seals[t];
    const age = s.ageDays == null ? 'never' : `${s.ageDays}d`;
    const cls = s.due ? 'warn' : s.soon ? 'soon' : '';
    return `<div class="seal ${cls}"><span>${t} o-ring</span><b>${age}${s.due ? ' — DUE' : s.soon ? ' — soon' : ''}</b>
      <button data-action="seal" data-field="sealType" data-value="${esc(t)}">replace</button></div>`;
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
    ${keg.status === 'dirty' ? btn('clean', '✓ Mark cleaned', { primary: true, field: 'cleanType', prompt: 'Clean type? (rinse/caustic/acid/full-cip)', promptDefault: 'caustic' }) : ''}
    ${keg.status === 'clean' ? btn('filled', '🛢 Fill (manual)', { primary: true, field: 'beerName', prompt: 'Beer name?' }) : ''}
    ${keg.status === 'filled' ? `<select id="tapsel">${tapOptions}</select>` + btn('tap', '🍺 Tap it', { primary: true, field: 'tap', fromSelect: 'tapsel' }) : ''}
    ${keg.status === 'tapped' ? btn('empty', '💧 Mark empty', { primary: true }) : ''}
    ${keg.status === 'empty' ? btn('dirty', '↩ To dirty', { primary: true }) : ''}
    ${keg.status !== 'retired' ? btn('retired', '⊘ Retire') : ''}
    ${btn('note', '📝 Note', { field: 'text', prompt: 'Note?' })}
  </div>
  <h3>History</h3><ul>${events || '<li>no events yet</li>'}</ul>
  <a class="qr" href="/kegs/${esc(keg.id)}/label" target="_blank">⎙ Print label</a>
  <div id="msg"></div>
<script>
  const KEG_ID = ${JSON.stringify(keg.id)};
  function showMsg(text, hold){ const m=document.getElementById('msg'); m.textContent=text; m.className='show'; return hold; }
  // one delegated handler for every action button — reads data-* attrs, builds params,
  // POSTs. No eval, no string-spliced call sites.
  document.querySelector('.actions').addEventListener('click', onBtn);
  document.querySelectorAll('.seal button').forEach(b => b.addEventListener('click', onBtn));
  async function onBtn(ev){
    const b = ev.target.closest('button'); if(!b || !b.dataset.action) return;
    const d = b.dataset, params = {};
    if (d.field){
      let val;
      if (d.value !== undefined) val = d.value;                       // fixed value (seal type)
      else if (d.fromSelect) val = document.getElementById(d.fromSelect).value;
      else if (d.prompt) { val = prompt(d.prompt, d.promptDefault || ''); if (val === null) return; } // cancelled
      // map field → the param shape the server expects
      if (d.field === 'beerName') params.beer = { name: val };
      else if (d.field === 'tap') params.tap = Number(val);
      else params[d.field] = val;
    }
    const r = await fetch('/api/keg/'+encodeURIComponent(KEG_ID)+'/action',
      {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:d.action, params})})
      .then(r=>r.json()).catch(e=>({ok:false,error:e.message}));
    const hold = r.warn ? 2200 : 700;
    showMsg(r.warn ? '⚠ '+r.warn : (r.ok ? '✓ done' : '✗ '+(r.error||'failed')), hold);
    setTimeout(()=>location.reload(), hold);
  }
</script></body></html>`;
}

// ── TAPLIST — the public bar-top DISPLAY (distinct from the mgmt board + QR page).
// Glanceable, non-touch, auto-refreshing. Shows what's ON TAP now (tapped kegs) + a
// "Coming Soon" panel (fermenting/conditioning batches: name · style · FG · ETA). Big
// type, dark, no controls. The Pi 5 kiosk points Chromium fullscreen at /taplist. ──
function taplistHtml(tapped, soon) {
  const abv = (v) => (v != null ? `${Number(v).toFixed(1)}%` : '');
  const onTap = tapped.length ? tapped.sort((a, b) => (a.tap ?? 99) - (b.tap ?? 99)).map((k) => `
    <div class="tap">
      <div class="tapno">${k.tap ?? '—'}</div>
      <div class="beer">
        <div class="bname">${esc(k.beer_batch || k.label)}</div>
        <div class="bmeta">${[esc(k.beer_style || ''), abv(k.beer_abv)].filter(Boolean).join(' · ')}</div>
      </div>
    </div>`).join('') : `<div class="empty">No kegs on tap</div>`;
  const soonRows = soon.length ? soon.map((b) => `
    <div class="soon-item">
      <span class="sname">${esc(b.name)}</span>
      <span class="smeta">${[esc(b.style || ''), b.fg != null ? `FG ${b.fg.toFixed(3)}` : '',
        b.etaDays != null ? `~${b.etaDays}d` : ''].filter(Boolean).join(' · ')}</span>
    </div>`).join('') : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>On Tap · GlassHaus</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box} html,body{height:100%}
  body{margin:0;font-family:'Inter',system-ui,sans-serif;background:radial-gradient(1200px 700px at 50% -15%, #12233a, #06090d 70%);color:#f2f6fb;
    display:flex;flex-direction:column;padding:3vh 4vw;overflow:hidden}
  header{display:flex;align-items:baseline;gap:16px;margin-bottom:2.5vh}
  header h1{font-size:5vh;margin:0;font-weight:800;letter-spacing:1px}
  header .brand{font-size:2vh;color:#5fa9c9;text-transform:uppercase;letter-spacing:3px}
  .taps{flex:1;display:grid;grid-template-columns:repeat(2,1fr);gap:1.6vh 4vw;align-content:start}
  .tap{display:flex;align-items:center;gap:2.5vw;padding:1.4vh 0;border-bottom:1px solid #ffffff14}
  .tapno{font-family:'JetBrains Mono',monospace;font-size:6vh;font-weight:700;color:#4fd1e8;min-width:1.4em;text-align:center;
    text-shadow:0 0 24px #4fd1e880;line-height:1}
  .bname{font-size:3.6vh;font-weight:700;line-height:1.05}
  .bmeta{font-size:2.2vh;color:#9fb2c4;margin-top:.4vh}
  .empty{font-size:4vh;color:#5a6b7d;grid-column:1/-1;text-align:center;padding-top:8vh}
  .soon{margin-top:2vh;padding-top:2vh;border-top:2px solid #ffffff1a}
  .soon h2{font-size:2.2vh;color:#f5a623;text-transform:uppercase;letter-spacing:2px;margin:0 0 1vh}
  .soon-item{display:flex;justify-content:space-between;font-size:2.6vh;padding:.6vh 0}
  .sname{font-weight:600} .smeta{color:#9fb2c4;font-size:2.2vh}
  footer{margin-top:2vh;font-family:'JetBrains Mono',monospace;font-size:1.5vh;color:#3a4a58;text-align:right}
</style></head><body>
  <header><h1>On Tap</h1><span class="brand">Iconoclast Brewing</span></header>
  <div class="taps">${onTap}</div>
  ${soon.length ? `<div class="soon"><h2>Coming Soon</h2>${soonRows}</div>` : ''}
  <footer>updated <span id="t"></span></footer>
<script>
  document.getElementById('t').textContent = new Date().toLocaleTimeString();
  // non-touch display: just refresh periodically so it stays current with no interaction.
  setTimeout(() => location.reload(), 60000);
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
  // ── fleet index — a browsable page (no client app needed): list every keg + a link
  // to its QR label, so "where do I find the QRs" has one obvious answer even before
  // the GlassHaus tablet board exists. ──
  if (p === '/kegs' || p === '/') {
    const kegs = db.listKegs().map(withHealth);
    const rows = kegs.map((k) => {
      const c = { ok: '#3ad29f', warning: '#f5a623', critical: '#ff4d5e' }[k.health.severity] || '#8b95a1';
      return `<tr onclick="location.href='/kegs/${esc(k.id)}'">
        <td class="id">${esc(k.id)}</td><td>${esc(k.label)}</td>
        <td><span class="pill" style="color:${c};border-color:${c}66;background:${c}18">${esc(k.status)}</span></td>
        <td>${esc(k.beer_batch || '—')}</td><td>${k.tap ? 'Tap ' + k.tap : '—'}</td>
        <td><a href="/kegs/${esc(k.id)}/label" onclick="event.stopPropagation()">QR ⎙</a></td></tr>`;
    }).join('');
    return html(res, 200, `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Kegs · GlassHaus</title>
<style>
  body{margin:0;font-family:system-ui,sans-serif;background:#0b0d0f;color:#e9edf2;padding:20px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:#7d8894;font-size:13px;margin-bottom:16px}
  a.top{color:#4fd1e8;font-size:13px;text-decoration:none} table{width:100%;border-collapse:collapse;margin-top:10px}
  th{text-align:left;font-size:11px;color:#7d8894;text-transform:uppercase;letter-spacing:.5px;padding:8px;border-bottom:1px solid #232a31}
  td{padding:10px 8px;border-bottom:1px solid #161a1f;font-size:14px;cursor:pointer} tr:hover td{background:#141820}
  td.id{font-family:ui-monospace,monospace;color:#7d8894;font-size:12px} .pill{padding:3px 9px;border-radius:12px;font-size:11px;text-transform:uppercase;border:1px solid;font-weight:700}
  td a{color:#4fd1e8;text-decoration:none;font-size:12px}
</style>
<h1>🛢 Kegs</h1><div class="sub">${kegs.length} kegs · tap a row to open, "QR" to print a label · <a class="top" href="/kegs-print">print ALL labels →</a></div>
<table><thead><tr><th>id</th><th>label</th><th>status</th><th>beer</th><th>tap</th><th></th></tr></thead><tbody>${rows}</tbody></table>`);
  }

  // ── print sheet: every keg's QR at once, sized for sticker paper ──
  if (p === '/kegs-print') {
    const kegs = db.listKegs();
    const cells = await Promise.all(kegs.map(async (k) => {
      let svg = ''; try { svg = await kegQrSvg(k.id); } catch { svg = '<p>missing</p>'; }
      return `<div class="cell">${svg}<div class="lab">${esc(k.label)}</div><div class="idl">${esc(k.id)}</div></div>`;
    }));
    return html(res, 200, `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Print keg labels</title>
<style>
  body{font-family:system-ui,sans-serif;background:#fff;color:#111;padding:16px}
  .bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
  button{padding:8px 16px;border:1px solid #ccc;border-radius:8px;background:#f5f5f5;cursor:pointer;font-size:14px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:16px}
  .cell{text-align:center;border:1px dashed #ccc;border-radius:10px;padding:10px;page-break-inside:avoid}
  .lab{font-weight:700;font-size:14px;margin-top:4px} .idl{font-family:ui-monospace,monospace;font-size:11px;color:#666}
  @media print{.bar{display:none}}
</style>
<div class="bar"><b>${kegs.length} keg labels</b><button onclick="window.print()">🖨 Print</button></div>
<div class="grid">${cells.join('')}</div>`);
  }

  // ── the public taplist display (Pi 5 kiosk points here) ──
  if (p === '/taplist') {
    const tapped = db.listKegs().filter((k) => k.status === 'tapped');
    let soon = []; try { soon = await comingSoon(); } catch { soon = []; }  // never break the board
    return html(res, 200, taplistHtml(tapped, soon));
  }

  return json(res, 404, { error: 'not found' });
});

seedIfEmpty();
// prime HA mirror for the whole fleet on boot (so sensors exist even before first action)
(async () => { for (const k of db.listKegs()) await mirrorKeg(k.id); for (const t of db.listTaps()) await mirrorTap(t.tap); console.log('[kegs] HA mirror primed'); })().catch((e) => console.error('[kegs] mirror prime failed:', e.message));
server.listen(PORT, () => console.log(`[kegs] GlassHaus keg service on :${PORT} (base ${BASE_URL})`));
