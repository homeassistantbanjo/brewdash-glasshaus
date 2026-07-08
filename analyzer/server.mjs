// GlassHaus insight analyzer — runner. Two triggers:
//   1) periodic DIGEST: internal timer every DIGEST_HOURS (default 8h)
//   2) ON-ALERT: HTTP webhook POST /trigger (HA automation calls it when an alert fires)
// Both call runOnce() from analyze.mjs → gather → Claude → write sensor.glasshaus_insight.
// A min-interval guard prevents alert storms from spamming Claude calls.
import { createServer } from 'node:http';
import { runOnce } from './analyze.mjs';

const PORT = Number(process.env.PORT || 8091);
const DIGEST_HOURS = Number(process.env.DIGEST_HOURS || 8);
const MIN_INTERVAL_SEC = Number(process.env.MIN_INTERVAL_SEC || 120); // debounce all triggers
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || ''; // optional shared secret for /trigger

let lastRunMs = 0;
let running = false;

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

// ---- webhook: HA calls this when an alert fires --------------------------------
createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200).end('ok'); return;
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
      res.writeHead(r.error ? 500 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r));
    });
    return;
  }
  res.writeHead(404).end('not found');
}).listen(PORT, () => console.log(`[analyzer] webhook listening on :${PORT}; digest every ${DIGEST_HOURS}h`));

// ---- periodic digest -----------------------------------------------------------
setInterval(() => { trigger('digest'); }, DIGEST_HOURS * 3600 * 1000);
// run one digest shortly after startup so the insight entity populates immediately
setTimeout(() => { trigger('startup-digest'); }, 10_000);
