// GlassHaus → VictoriaMetrics: durable per-tank ferment metrics.
//
// Brewfather holds each batch's reading history, but that's THEIRS — if their API changes
// or a batch is archived, the granular curve is gone. This writes EVERY tank's live
// gravity / beer temp / probe temp / setpoint / attenuation / ABV / drop-from-peak to our
// OWN VictoriaMetrics every tick, labeled by tank + batch, so historical ferment data is
// query-able forever via PromQL/Grafana, independent of Brewfather. "Store everything,
// query anytime" — for real, in a TSDB we own.
//
// Uses InfluxDB line protocol (VM's /write endpoint) — no deps, one POST per tick.
// Best-effort: a failed write never disrupts the control tick (metrics are observational).

import http from 'node:http';
import https from 'node:https';

const VM_URL = (process.env.VM_URL || 'http://tower.lan:8428').replace(/\/$/, '');
const ENABLED = process.env.METRICS_ENABLED !== '0';   // on by default; METRICS_ENABLED=0 to disable

/** escape an InfluxDB line-protocol TAG value (commas, spaces, equals). */
function tag(v) {
  return String(v == null ? '' : v).replace(/[,= ]/g, '_').replace(/"/g, '');
}

/**
 * Write one tank's metrics as a single line-protocol point.
 * fields: any numeric metric present (nulls are skipped — VM needs at least one field).
 * tags: tank (always) + batch/tilt/status when known, so you can filter by beer.
 * Measurement: gh_ferment. ts is ms → line protocol wants ns (append 6 zeros).
 */
export async function writeTankMetrics(tankId, { tags = {}, fields = {} }, nowMs = Date.now()) {
  if (!ENABLED) return false;
  const fieldParts = Object.entries(fields)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .map(([k, v]) => `${k}=${v}`);
  if (!fieldParts.length) return false;                 // nothing numeric to store this tick

  const tagParts = [`tank=${tag(tankId)}`];
  for (const [k, v] of Object.entries(tags)) if (v != null && v !== '') tagParts.push(`${k}=${tag(v)}`);

  const line = `gh_ferment,${tagParts.join(',')} ${fieldParts.join(',')} ${nowMs}000000`;
  return post(`${VM_URL}/write`, line);
}

/** Write many tanks in one POST (line protocol accepts newline-separated points). */
export async function writeAllTankMetrics(points, nowMs = Date.now()) {
  if (!ENABLED || !points.length) return false;
  const lines = [];
  for (const p of points) {
    const fieldParts = Object.entries(p.fields || {})
      .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
      .map(([k, v]) => `${k}=${v}`);
    if (!fieldParts.length) continue;
    const tagParts = [`tank=${tag(p.tankId)}`];
    for (const [k, v] of Object.entries(p.tags || {})) if (v != null && v !== '') tagParts.push(`${k}=${tag(v)}`);
    lines.push(`gh_ferment,${tagParts.join(',')} ${fieldParts.join(',')} ${nowMs}000000`);
  }
  if (!lines.length) return false;
  return post(`${VM_URL}/write`, lines.join('\n'));
}

function post(url, body) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve(false); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'POST', timeout: 5000,
      headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode < 300)); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

export const metricsConfigured = () => ENABLED && !!VM_URL;

/**
 * DURABLE 24h gravity slope from VictoriaMetrics (pts/day), for a tank's velocity when the
 * runner's in-memory window is too short — e.g. right after a container restart, which wipes
 * the in-memory buffer and left Tank 3's velocity null. VM has the full history (survives
 * restarts + the every-tick writes), so this is the robust source. Returns null if VM is
 * unconfigured/unreachable or there isn't enough spread (<6h) to be meaningful.
 * Uses a range query over the last 26h and slopes first→last sample.
 */
export async function vmGravitySlopePts(tankId, nowMs = Date.now()) {
  if (!metricsConfigured()) return null;
  const end = Math.floor(nowMs / 1000);
  const start = end - 26 * 3600;                      // 26h window
  const q = encodeURIComponent(`gh_ferment_gravity{tank="${tankId}"}`);
  const path = `/api/v1/query_range?query=${q}&start=${start}&end=${end}&step=1800`;  // 30-min steps
  const j = await vmGet(path);
  const series = j?.data?.result?.[0]?.values;       // [[ts, "sg"], ...]
  if (!Array.isArray(series) || series.length < 2) return null;
  const first = series[0], last = series[series.length - 1];
  const days = (Number(last[0]) - Number(first[0])) / 86400;
  if (days < 0.25) return null;                       // <6h spread → not trustworthy
  const dSg = Number(last[1]) - Number(first[1]);
  if (!Number.isFinite(dSg)) return null;
  return (dSg / days) * 1000;                         // SG/day → pts/day
}

/**
 * MOST-RECENT stored gravity for a tank (+ how old it is), from VictoriaMetrics.
 * Used to HOLD the last-good gravity through a Tilt BLE dropout so the DISPLAY-derived
 * metrics (attenuation, drop-from-peak, progress) stay populated instead of half-blanking
 * the card — the weak-signal flap can't fully be fixed in software, so we degrade
 * gracefully around it. DISPLAY ONLY: control never uses this (it keeps the strict
 * gravityStale gate), so a held value can never drive a setpoint off an old reading.
 * Returns { sg, ageMin } from the freshest sample in the last `maxAgeMin`, or null if
 * none that recent (then the card honestly blanks — we don't fabricate ancient data).
 */
export async function vmLastGravity(tankId, maxAgeMin = 120, nowMs = Date.now()) {
  if (!metricsConfigured()) return null;
  const end = Math.floor(nowMs / 1000);
  const start = end - Math.ceil((maxAgeMin + 5) * 60);   // look back just past the window
  const q = encodeURIComponent(`gh_ferment_gravity{tank="${tankId}"}`);
  const path = `/api/v1/query_range?query=${q}&start=${start}&end=${end}&step=60`;
  const j = await vmGet(path);
  const series = j?.data?.result?.[0]?.values;           // [[ts, "sg"], ...]
  if (!Array.isArray(series) || !series.length) return null;
  const last = series[series.length - 1];
  const sg = Number(last[1]);
  const ageMin = (nowMs / 1000 - Number(last[0])) / 60;
  if (!Number.isFinite(sg) || ageMin > maxAgeMin) return null;
  return { sg, ageMin };
}

/** GET a VM API path, parse JSON. null on any failure. */
function vmGet(path) {
  return new Promise((resolve) => {
    let u; try { u = new URL(path, VM_URL); } catch { return resolve(null); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'GET', timeout: 6000 }, (res) => {
      const ch = []; res.on('data', (d) => ch.push(d));
      res.on('end', () => { if (res.statusCode >= 400) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(ch).toString())); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}
