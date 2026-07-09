// GlassHaus insight analyzer — runner. Two triggers:
//   1) periodic DIGEST: internal timer every DIGEST_HOURS (default 8h)
//   2) ON-ALERT: HTTP webhook POST /trigger (HA automation calls it when an alert fires)
// Both call runOnce() from analyze.mjs → gather → Claude → write sensor.glasshaus_insight.
// A min-interval guard prevents alert storms from spamming Claude calls.
import { createServer } from 'node:http';
import { runOnce, runPlant, getCachedPlant } from './analyze.mjs';

const PORT = Number(process.env.PORT || 8091);
const DIGEST_HOURS = Number(process.env.DIGEST_HOURS || 8);
const MIN_INTERVAL_SEC = Number(process.env.MIN_INTERVAL_SEC || 120); // debounce all triggers
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || ''; // optional shared secret for /trigger

let lastRunMs = 0;
let running = false;
// separate debounce for the full-plant analysis (heavier, its own throttle)
let lastPlantMs = 0;
let plantRunning = false;

async function trigger(reason) {
  const now = Date.now();
  if (running) { console.log(`[analyzer] busy — skip (${reason})`); return { skipped: 'busy' }; }
  if (now - lastRunMs < MIN_INTERVAL_SEC * 1000) {
    console.log(`[analyzer] debounced — skip (${reason})`);
    return { skipped: 'debounced' };
  }
  running = true; lastRunMs = now;
  try {
    const insight = await runOnce(reason);
    return { ok: true, insight };
  } catch (e) {
    console.error(`[analyzer] run failed (${reason}):`, e.message);
    return { error: e.message };
  } finally {
    running = false;
  }
}

// full-plant: force=true runs live (Refresh button); otherwise a min-interval guard
// coalesces bursts. Returns the (possibly cached) full analysis either way.
const PLANT_MIN_SEC = Number(process.env.PLANT_MIN_INTERVAL_SEC || 30);
async function runPlantGuarded(reason, force) {
  const now = Date.now();
  if (plantRunning) return getCachedPlant();
  if (!force && now - lastPlantMs < PLANT_MIN_SEC * 1000) return getCachedPlant();
  plantRunning = true; lastPlantMs = now;
  try {
    return await runPlant(reason);
  } catch (e) {
    console.error(`[analyzer] plant run failed (${reason}):`, e.message);
    const cached = getCachedPlant();
    if (cached) return cached;
    throw e;
  } finally {
    plantRunning = false;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-webhook-token',
};
const sendJson = (res, code, obj) =>
  res.writeHead(code, { 'content-type': 'application/json', ...CORS }).end(JSON.stringify(obj));

// ---- webhook: HA calls this when an alert fires --------------------------------
createServer((req, res) => {
  // CORS preflight for the browser SPA
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, CORS).end('ok'); return;
  }

  // full-plant analysis for the in-app Insights view.
  //   GET  /insights           → cached result instantly (runs once if empty)
  //   GET  /insights?refresh=1 → force a fresh live analysis
  //   POST /insights/refresh   → force a fresh live analysis
  if (req.url?.startsWith('/insights')) {
    const wantsRefresh =
      (req.method === 'POST' && req.url.startsWith('/insights/refresh')) ||
      /[?&]refresh=1\b/.test(req.url);
    (async () => {
      try {
        let result = getCachedPlant();
        if (wantsRefresh || !result) result = await runPlantGuarded(wantsRefresh ? 'refresh' : 'view', wantsRefresh);
        sendJson(res, 200, result || { plantSummary: null, tanks: [], equipment: null });
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
    })();
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/trigger')) {
    if (WEBHOOK_TOKEN && req.headers['x-webhook-token'] !== WEBHOOK_TOKEN) {
      res.writeHead(401).end('unauthorized'); return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let reason = 'alert';
      try { reason = JSON.parse(body || '{}').reason || 'alert'; } catch { /* ignore */ }
      const r = await trigger(reason);
      sendJson(res, r.error ? 500 : 200, r);
    });
    return;
  }
  res.writeHead(404, CORS).end('not found');
}).listen(PORT, () => console.log(`[analyzer] webhook listening on :${PORT}; digest every ${DIGEST_HOURS}h`));

// ---- periodic digest -----------------------------------------------------------
setInterval(() => { trigger('digest'); }, DIGEST_HOURS * 3600 * 1000);
// run one digest shortly after startup so the insight entity populates immediately
setTimeout(() => { trigger('startup-digest'); }, 10_000);
