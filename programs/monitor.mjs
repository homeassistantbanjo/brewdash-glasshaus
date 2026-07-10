// OBSERVABILITY — plant + component health, computed each runner tick.
//
// WHY: the beer alerts (derived.mjs) are all gravity/Tilt-centric and gated on a
// batch being assigned. They said NOTHING when the glycol Zigbee temp sensor
// froze for 6h, when the Z2M feed wedged, or if a Kasa plug powering an Inkbird
// temp controller dropped — the failures that actually threaten a batch. This
// module watches the INFRASTRUCTURE and emits a health alert list that an HA
// automation notifies on.
//
// Three failure classes, each caught differently:
//   1. STALENESS  — a sensor still has a state but stopped updating. `last_updated`
//      age is the truth here: a wedged push feed freezes last_updated even though
//      the value looks plausible. This is the dangerous, invisible case.
//   2. UNAVAILABLE — explicit unavailable/unknown/empty state (hard disconnect).
//   3. GLYCOL HEALTH — plant-wide cooling sanity (reservoir range, short-cycling,
//      chiller drawing no power while it should be cooling).
//
// Pure + deterministic: computeHealth(by, now) → { alerts, checks }. `by` is the
// entity_id → state-object map the runner already builds. No I/O here (testable).

const MIN = 60_000;

// ---- WATCHLIST -------------------------------------------------------------
// Per-entity health contract. kind:
//   'fresh'  → alert if last_updated older than maxAgeMin (staleness/frozen feed)
//   'avail'  → alert if state is unavailable/unknown/'' (hard disconnect)
//   'both'   → both checks
// severity: 'critical' (batch at risk / cooling down) | 'warning' (degraded).
// optional: onlyIf(by) gate so we don't nag about a device that isn't in use
// (e.g. a Tilt/controller for an empty tank).
export const WATCHLIST = [
  // --- GLYCOL LOOP (plant-wide — every batch depends on it) ---
  { id: 'sensor.glycol_temp',                          kind: 'both', maxAgeMin: 30, severity: 'critical',
    label: 'Glycol reservoir temp' },
  { id: 'sensor.glycol_chiller_temp_temperature',      kind: 'both', maxAgeMin: 30, severity: 'critical',
    label: 'Glycol chiller Zigbee temp' },
  { id: 'sensor.glycol_power_current_consumption',     kind: 'both', maxAgeMin: 20, severity: 'warning',
    label: 'Glycol plug power' },
  { id: 'binary_sensor.glycol_power_cloud_connection', kind: 'avail', on: 'off',   severity: 'warning',
    label: 'Glycol Kasa plug cloud link' },

  // --- KEGERATOR ---
  { id: 'sensor.kegerator_power_current_consumption',  kind: 'both', maxAgeMin: 20, severity: 'warning',
    label: 'Kegerator plug power' },
  { id: 'binary_sensor.kegerator_power_cloud_connection', kind: 'avail', on: 'off', severity: 'warning',
    label: 'Kegerator Kasa plug cloud link' },
];

// Per-tank watch: the Inkbird temp-controller plug (switch-only Kasa — availability
// IS the signal; if it drops, the fermenter has NO active heating/cooling), plus
// the tank probe + Tilt when a batch is actively assigned. Built dynamically so we
// only nag about tanks that have a batch (an empty tank's offline controller is
// expected, not an incident).
export function tankChecks(tankId, by) {
  const out = [];
  // controller plug: entity id differs per tank (some are *_temp_controller_power,
  // some *_temperature_controller). Probe both; alert if BOTH missing → we treat
  // the tank as having no controller wired (the known tank_2/3 case) — surfaced as
  // a low-severity note only when a batch is present.
  const ctrlIds = [
    `switch.${tankId}_temp_controller_power`,
    `switch.${tankId}_temperature_controller`,
  ];
  const ctrl = ctrlIds.map((id) => by[id]).find(Boolean);
  const hasBatch = batchAssigned(tankId, by);
  if (ctrl) {
    // controller plug present → its availability is the temp-control liveness
    out.push({
      id: ctrl.entity_id, kind: 'avail', severity: hasBatch ? 'critical' : 'warning',
      label: `${up(tankId)} temp controller (Inkbird plug)`,
    });
  } else if (hasBatch) {
    out.push({
      synthetic: true, key: `${tankId}_no_controller`, severity: 'warning',
      label: `${up(tankId)} has a batch but no temp controller wired`,
    });
  }
  // tank probe (ITC-308 reading) — only meaningful with a batch
  if (hasBatch) {
    out.push({ id: `sensor.${tankId}_probe_temp`, kind: 'both', maxAgeMin: 30,
      severity: 'warning', label: `${up(tankId)} probe temp` });
  }
  return out;
}

function batchAssigned(tankId, by) {
  const v = by[`input_text.${tankId}_batch`]?.state;
  return !!(v && !['', 'none', 'None', 'unknown', 'unavailable'].includes(v));
}
const up = (t) => t.replace('tank_', 'Tank ').replace(/^(\w)/, (m) => m.toUpperCase());
const UNAVAIL = new Set(['unavailable', 'unknown', '', null, undefined]);

function ageMin(ent, now) {
  const t = ent?.last_updated ? Date.parse(ent.last_updated) : NaN;
  return Number.isFinite(t) ? (now - t) / MIN : null;
}

// evaluate ONE watch entry against `by`. Returns an alert object or null.
function evalCheck(w, by, now) {
  if (w.synthetic) return { key: w.key, severity: w.severity, label: w.label, detail: 'not configured' };
  const ent = by[w.id];
  if (w.onlyIf && !w.onlyIf(by)) return null;
  // availability check
  if (w.kind === 'avail' || w.kind === 'both') {
    if (!ent || UNAVAIL.has(ent.state)) {
      return { key: `${w.id}:avail`, severity: w.severity, label: w.label,
        detail: ent ? `state ${ent.state}` : 'entity missing', entityId: w.id };
    }
    // for binary cloud-connection sensors, an explicit 'off' means disconnected
    if (w.on && ent.state === w.on) {
      return { key: `${w.id}:avail`, severity: w.severity, label: w.label,
        detail: 'disconnected', entityId: w.id };
    }
  }
  // staleness check (only if it IS available — an unavailable entity already alerted)
  if ((w.kind === 'fresh' || w.kind === 'both') && ent && !UNAVAIL.has(ent.state)) {
    const age = ageMin(ent, now);
    if (age != null && age > w.maxAgeMin) {
      return { key: `${w.id}:stale`, severity: w.severity, label: w.label,
        detail: `no update in ${Math.round(age)}m (>${w.maxAgeMin}m)`, entityId: w.id, ageMin: Math.round(age) };
    }
  }
  return null;
}

// ---- GLYCOL HEALTH (derived, not a single-entity watch) --------------------
const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
function glycolHealth(by, now) {
  const out = [];
  const resF = num(by['sensor.glycol_temp']?.state);
  // reservoir out of a sane glycol range (°F). Only alert when the reading is
  // FRESH — a stale reading is already caught by the watchlist; don't double-fire.
  const resFresh = ageMin(by['sensor.glycol_temp'], now);
  if (resF != null && resFresh != null && resFresh <= 30 && resF > 45) {
    out.push({ key: 'glycol_warm', severity: 'critical', label: 'Glycol reservoir warm',
      detail: `${resF.toFixed(1)}°F (>45°F) — cooling capacity at risk` });
  }
  // short-cycling: many compressor starts per hour
  const cycles = num(by['sensor.glycol_compressor_cycles_1h']?.state);
  if (cycles != null && cycles > 8) {
    out.push({ key: 'glycol_short_cycle', severity: 'warning', label: 'Glycol short-cycling',
      detail: `${cycles} compressor starts in the last hour` });
  }
  // chiller "should be cooling" but drawing ~no power → compressor/plug fault.
  // "should be cooling" ≈ running_power binary says on but wattage is near zero.
  const runOn = by['binary_sensor.glycol_chiller_running_power']?.state === 'on';
  const watts = num(by['sensor.glycol_power_current_consumption']?.state);
  if (runOn && watts != null && watts < 50) {
    out.push({ key: 'glycol_no_draw', severity: 'critical', label: 'Glycol chiller not drawing power',
      detail: `flagged running but ${watts}W — compressor or plug fault` });
  }
  return out;
}

/**
 * computeHealth — the whole plant/component health snapshot for one tick.
 * @param {Record<string,any>} by  entity_id → HA state object
 * @param {number} now  epoch ms
 * @param {string[]} tanks  tank ids to run per-tank checks for
 * @returns {{ alerts: Array, checkedCount: number }}
 */
export function computeHealth(by, now, tanks = []) {
  const checks = [...WATCHLIST];
  for (const t of tanks) checks.push(...tankChecks(t, by));

  const alerts = [];
  for (const w of checks) {
    const a = evalCheck(w, by, now);
    if (a) alerts.push(a);
  }
  alerts.push(...glycolHealth(by, now));

  // sort critical first, then warning; stable within
  const rank = { critical: 0, warning: 1 };
  alerts.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  return { alerts, checkedCount: checks.length };
}
