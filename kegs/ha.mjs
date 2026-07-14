// HA push for the keg mirror — POST sensor states to Home Assistant's REST API. Same
// direct-REST approach GlassHaus uses for writes (see web useBreweryActions.ts): hakit's
// callService was unreliable, so we POST /api/states/<entity_id> directly. Best-effort:
// a failed push logs and never throws into a request handler.

import http from 'node:http';
import https from 'node:https';

const HA_URL = (process.env.HA_URL || '').replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';

/** POST a sensor state to HA. Returns true on success. Best-effort (never throws). */
export function pushState({ entityId, state, attrs = {} }) {
  return new Promise((resolve) => {
    if (!HA_URL || !HA_TOKEN) return resolve(false);   // HA mirror disabled — fine
    const lib = HA_URL.startsWith('https') ? https : http;
    const body = Buffer.from(JSON.stringify({ state: String(state), attributes: attrs }));
    const req = lib.request(`${HA_URL}/api/states/${entityId}`, {
      method: 'POST', timeout: 6000,
      headers: { Authorization: `Bearer ${HA_TOKEN}`, 'content-type': 'application/json', 'content-length': body.length },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode < 400)); });
    req.on('error', (e) => { console.error(`[ha] push ${entityId} failed:`, e.message); resolve(false); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

/** Push a batch of sensors (from haMirror/tapMirror). Returns count succeeded. */
export async function pushAll(sensors) {
  let ok = 0;
  for (const s of sensors) if (await pushState(s)) ok++;
  return ok;
}
