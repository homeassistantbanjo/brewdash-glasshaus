// Capture pipeline — turn a fetched Brewfather batch (bfGetBatch shape) into a DB
// record: upsert the measured/process fields + ingest the temp/gravity curve, and
// compute the temp SUMMARY (pitch/peak/avg/min, days) from the curve. Pure mapping +
// arithmetic (the DB writes are the only side effects) — the summary math is tested.

import { upsertBatch, insertReadings, getBatch, addEvent } from './db.mjs';

// fuzzy style → category (mirrors the resolver in the yeast-profiles design; small
// seed map, grow as needed). Keeps profiles/mining groupable across BJCP variants.
export function styleCategory(style) {
  const s = String(style || '').toLowerCase();
  if (/saison|farmhouse|brett|biere de garde/.test(s)) return 'Saison';
  if (/hazy|neipa|ne ipa|new england|juicy/.test(s)) return 'Hazy IPA';
  if (/ipa|pale ale|apa/.test(s)) return 'IPA';
  if (/lager|pils|helles|bock|schwarz|dunkel|marzen|oktoberfest/.test(s)) return 'Lager';
  if (/stout|porter/.test(s)) return 'Dark Ale';
  if (/wheat|weiss|hefe|wit/.test(s)) return 'Wheat';
  if (/sour|gose|lambic|kettle/.test(s)) return 'Sour';
  return style ? 'Other' : null;
}

/** Summarize a temp/gravity curve → {pitchTempF, peakTempF, avgTempF, minTempF,
 *  daysPrimary, daysToTerminal}. Pure. curve: [{t, tempF/temp_f, gravity}] sorted. */
export function summarizeCurve(curve, og, fg) {
  const pts = (curve || [])
    .map((p) => ({ t: p.t, temp: p.tempF ?? p.temp_f ?? null, g: p.gravity ?? null }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  if (!pts.length) return {};
  const temps = pts.map((p) => p.temp).filter((v) => Number.isFinite(v));
  const pitchTempF = temps.length ? temps[0] : null;   // first reading ≈ pitch temp
  const peakTempF = temps.length ? Math.max(...temps) : null;
  const minTempF = temps.length ? Math.min(...temps) : null;
  const avgTempF = temps.length ? +(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : null;
  const spanDays = (pts[pts.length - 1].t - pts[0].t) / 86_400_000;
  // days-to-terminal: first point at/below FG (within 2pts), else full span
  let daysToTerminal = spanDays ? +spanDays.toFixed(1) : null;
  if (fg != null) {
    const hit = pts.find((p) => p.g != null && p.g <= fg + 0.002);
    if (hit) daysToTerminal = +((hit.t - pts[0].t) / 86_400_000).toFixed(1);
  }
  return {
    pitchTempF: round1(pitchTempF), peakTempF: round1(peakTempF),
    minTempF: round1(minTempF), avgTempF,
    daysPrimary: daysToTerminal, daysToTerminal,
  };
}
const round1 = (v) => (v == null ? null : +Number(v).toFixed(1));

/** Map a bfGetBatch result → the batches-table field set. `bf` is what
 *  server.mjs's bfGetBatch returns. `extra` allows profile_id/plan_json/timestamps
 *  the container knows at completion time. */
export function batchFieldsFromBf(bf, extra = {}) {
  const m = bf.measured || {};
  const og = m.og ?? bf.og ?? null;
  const fg = m.fg ?? null;
  const s = summarizeCurve(bf.history, og, fg);
  const atten = (og != null && fg != null && og > 1) ? +(((og - fg) / (og - 1)) * 100).toFixed(1) : null;
  const abv = (og != null && fg != null) ? +(((og - fg) * 131.25)).toFixed(1) : null;
  return {
    batch_no: bf.batchNo,
    bf_id: bf.id ?? null,
    name: bf.name ?? null,
    style: bf.style ?? null,
    style_category: styleCategory(bf.style),
    yeast_name: bf.yeastName ?? extra.yeastName ?? null,
    yeast_product_id: bf.yeastProductId ?? extra.yeastProductId ?? null,
    yeast_type: bf.yeastType ?? null,
    og, fg, abv, attenuation: atten,
    mash_ph: m.mashPh ?? null,
    boil_gravity: m.postBoilGravity ?? m.preBoilGravity ?? null,
    batch_size_gal: m.batchSizeGal ?? null,
    bottling_size_gal: m.bottlingSizeGal ?? null,
    pitch_temp_f: s.pitchTempF ?? null,
    peak_temp_f: s.peakTempF ?? null,
    avg_temp_f: s.avgTempF ?? null,
    min_temp_f: s.minTempF ?? null,
    days_primary: s.daysPrimary ?? null,
    days_to_terminal: s.daysToTerminal ?? null,
    ferment_start: bf.fermentingStart ?? null,
    ...extra,   // completed_at, profile_id, plan_json, days_conditioned, etc.
  };
}

/** Ingest a bfGetBatch result into the DB: upsert the batch row + its readings.
 *  Returns { batchId, fields, readingsInserted }. Side-effecting (DB writes). */
export function captureBatch(bf, extra = {}) {
  const fields = batchFieldsFromBf(bf, extra);
  const batchId = upsertBatch(fields);
  let readingsInserted = 0;
  if (Array.isArray(bf.history) && bf.history.length) {
    readingsInserted = insertReadings(batchId,
      bf.history.map((p) => ({ t: p.t, temp_f: p.tempF ?? null, gravity: p.gravity ?? null, source: p.source ?? p.id ?? 'tilt' })));
  }
  return { batchId, fields, readingsInserted };
}

export { captureBatch as default };
