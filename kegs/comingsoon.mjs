// "Coming Soon" data for the taplist — batches that are fermenting/conditioning (not yet
// on tap). Sources: the GlassHaus Brewfather sidecar (:8093) for durable name/style/FG,
// and HA for the live projected-FG ETA sensor (which is only present while a Tilt is
// actively feeding the ferment — so ETA is shown ONLY when available, never faked).
//
// Kept separate + defensive: the taplist must render even if Brewfather or HA is down —
// a failure here just yields an empty "coming soon" list, never a broken board.

import http from 'node:http';
import https from 'node:https';

const BREWFATHER_URL = (process.env.BREWFATHER_URL || 'http://192.168.50.118:8093').replace(/\/$/, '');
const HA_URL = (process.env.HA_URL || '').replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';

function getJson(url, headers = {}, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve(null); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'GET', timeout: timeoutMs, headers }, (res) => {
      const ch = []; res.on('data', (d) => ch.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString())); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// batches "coming soon" = still in the tank pipeline, not yet kegged/tapped.
const COMING_STATUSES = /^(fermenting|conditioning)$/i;

/**
 * Fetch a batch's graphical stats from Brewfather for the taplist: style, SRM (color),
 * IBU, ABV, FG, OG. Used by the kegging handoff to auto-stamp these onto the keg so the
 * board can render the SRM color glass + chips. Returns {} on any failure (guest/donation
 * beers aren't in Brewfather — the caller falls back to manual entry). batchNoOrName can
 * be a Brewfather batchNo. Never throws.
 */
export async function batchStats(batchNo, { sourceTank = null } = {}) {
  if (batchNo == null) return {};
  const detail = await getJson(`${BREWFATHER_URL}/batch/${encodeURIComponent(batchNo)}`);
  if (!detail) return {};
  const recipe = await getJson(`${BREWFATHER_URL}/recipe/${encodeURIComponent(batchNo)}`);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

  // FG PRIORITY: the LIVE Tilt gravity is the ground truth for a beer that's done
  // fermenting — Brewfather's numbers are the recipe TARGET (estFg) or a manually-logged
  // measurement (measured.fg) that may lag. If we know the tank this batch is on, read its
  // assigned Tilt's current gravity from HA and prefer it. Only trust a plausible SG.
  const liveFg = sourceTank ? await liveTiltGravity(sourceTank) : null;

  return {
    style: detail.style || recipe?.style?.name || recipe?.style || null,
    srm: num(detail.srm) ?? num(recipe?.color),
    ibu: num(detail.ibu) ?? num(recipe?.ibu),
    abv: num(detail.estAbv) ?? num(recipe?.abv),
    // live Tilt → measured → estimated. Live is the actual current gravity the system reads.
    fg: liveFg ?? num(detail.measured?.fg) ?? num(detail.estFg) ?? num(recipe?.fg),
    og: num(detail.og) ?? num(recipe?.og),
  };
}

/**
 * Read the CURRENT gravity from the Tilt assigned to `tank` (e.g. "tank_1"), via HA:
 * input_select.<tank>_tilt gives the color → sensor.tilt_<color>_gravity is the live SG.
 * Returns a plausible SG (0.98–1.20) rounded to 3dp, or null. Never throws.
 */
async function liveTiltGravity(tank) {
  if (!HA_URL || !HA_TOKEN) return null;
  const hdr = { Authorization: `Bearer ${HA_TOKEN}` };
  const sel = await getJson(`${HA_URL}/api/states/input_select.${tank}_tilt`, hdr);
  const color = String(sel?.state || '').toLowerCase();
  if (!color || color === 'none' || color === 'unavailable') return null;
  const g = await getJson(`${HA_URL}/api/states/sensor.tilt_${color}_gravity`, hdr);
  const v = Number(g?.state);
  if (!Number.isFinite(v) || v < 0.98 || v > 1.2) return null;   // implausible/idle → skip
  return +v.toFixed(3);
}

/**
 * Build the coming-soon list for the taplist. Returns [{ name, style, fg, etaDays }].
 * fg = target/estimated final gravity (from Brewfather). etaDays present only when the
 * live HA projected-FG sensor has a real value. Never throws.
 */
export async function comingSoon() {
  const list = await getJson(`${BREWFATHER_URL}/batches`);
  const batches = Array.isArray(list?.batches) ? list.batches : Array.isArray(list) ? list : [];
  const coming = batches.filter((b) => COMING_STATUSES.test(String(b.status || '')));
  if (coming.length === 0) return [];

  // pull the (optional) live ETA once from HA — a single states read, best-effort.
  let etaDays = null;
  if (HA_URL && HA_TOKEN) {
    const s = await getJson(`${HA_URL}/api/states/sensor.days_to_fg`, { Authorization: `Bearer ${HA_TOKEN}` });
    const v = Number(s?.state);
    if (Number.isFinite(v) && v >= 0) etaDays = Math.round(v);
  }

  // enrich each with style + target FG from its recipe (durable, always available).
  const out = [];
  for (const b of coming) {
    const detail = await getJson(`${BREWFATHER_URL}/batch/${b.batchNo}`);
    const recipe = await getJson(`${BREWFATHER_URL}/recipe/${b.batchNo}`);
    const style = detail?.style || recipe?.style?.name || recipe?.style || null;
    const fg = detail?.measured?.fg ?? detail?.estimatedFg ?? recipe?.fg ?? recipe?.target?.fg ?? null;
    out.push({
      name: b.name && b.name !== 'Batch' ? b.name : detail?.name || `Batch ${b.batchNo}`,
      style, fg: fg != null ? Number(fg) : null,
      status: b.status,
      etaDays,   // same live sensor for all (we only have one projected-FG sensor today)
    });
  }
  return out;
}
