/**
 * Pure derivation logic. No React, no HA — just functions over the domain
 * types. This is where the brewing math lives (ported from the Jinja templates
 * we built in Home Assistant) and where freshness/plausibility get decided.
 *
 * Keeping this pure means every rule here is unit-testable in isolation, which
 * matters because these are the rules that keep a stale/misassigned reading
 * from being shown as truth.
 */

import {
  Reading,
  Staleness,
  CADENCE,
  Tank,
  TiltDevice,
  BrewfatherBatch,
  TankAssignment,
  ActiveBatch,
  AssignmentVerification,
} from '../types/domain';

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/**
 * Classify how fresh a reading is against its source's expected cadence.
 * `live`   — updated within 2× cadence
 * `stale`  — updated within 10× cadence (something's lagging but alive)
 * `dead`   — silent beyond that (source likely offline)
 * `unknown`— never seen
 */
export function classifyStaleness(
  updatedAt: number | null,
  cadenceMs: number,
  now: number = Date.now(),
): Staleness {
  if (updatedAt == null) return 'unknown';
  const age = now - updatedAt;
  if (age <= cadenceMs * 2) return 'live';
  if (age <= cadenceMs * 10) return 'stale';
  return 'dead';
}

/**
 * How to decide a reading's freshness:
 *   'age'          — classify against last_updated + cadence (broadcasting
 *                    devices like the Tilt: silence == a real problem).
 *   'availability' — live as long as HA has a real value; ignore age. For
 *                    change-only-reporting devices like the ITC-308, whose
 *                    last_updated barely moves when the temp is steady, so an
 *                    age-based check would false-alarm OFFLINE on healthy data.
 */
export type FreshnessMode = 'age' | 'availability';

/** Build a Reading from a raw HA state string + last_updated. */
export function toReading<T = number>(
  entityId: string,
  rawState: string | undefined,
  lastUpdatedIso: string | undefined,
  cadenceMs: number,
  parse: (s: string) => T | null = (s) => Number(s) as unknown as T,
  now: number = Date.now(),
  mode: FreshnessMode = 'age',
): Reading<T> {
  const updatedAt = lastUpdatedIso ? Date.parse(lastUpdatedIso) : null;
  const usable =
    rawState != null && rawState !== 'unknown' && rawState !== 'unavailable';
  const value = usable ? parse(rawState) : null;
  const cleanValue =
    value != null && !(typeof value === 'number' && isNaN(value)) ? value : null;

  let staleness: Staleness;
  if (mode === 'availability') {
    // present + parseable ⇒ live; otherwise unknown. Age never marks it stale.
    staleness = cleanValue != null ? 'live' : 'unknown';
  } else {
    staleness = classifyStaleness(updatedAt, cadenceMs, now);
  }

  return { value: cleanValue, updatedAt, staleness, entityId };
}

// ---------------------------------------------------------------------------
// Brewing math (ported from the HA templates)
// ---------------------------------------------------------------------------

/** Standard homebrew ABV approximation. Accurate to ~0.1% under ~8% ABV. */
export function calcAbv(og: number | null, sg: number | null): number | null {
  if (og == null || sg == null) return null;
  return round((og - sg) * 131.25, 2);
}

/** Apparent attenuation — the yeast-spec number. Uses live SG, not FG. */
export function calcAttenuation(
  og: number | null,
  sg: number | null,
): number | null {
  if (og == null || sg == null || og <= 1) return null;
  return round(((og - sg) / (og - 1)) * 100, 1);
}

/**
 * Is the live gravity physically implausible for this batch — i.e. the Tilt is
 * almost certainly NOT reading the beer? Two impossible cases:
 *   - SG below ~0.995 → floating in water/CO₂ head or fully out of liquid.
 *   - Apparent attenuation above ~100.5% → SG dropped below 1.000, which real
 *     wort can't do; the hydrometer has fallen sideways or is stuck in foam.
 * A small tolerance (0.5%) absorbs sensor noise/rounding so a genuine ~100%
 * attenuation lager doesn't false-positive. Returns a reason string when
 * suspect, else null. We flag rather than fake a clamped number — a clamped
 * 100% would hide a broken Tilt and let control/plans act on garbage.
 */
export function gravitySuspectReason(
  og: number | null,
  sg: number | null,
): string | null {
  if (sg == null) return null;              // no reading is "missing", not "suspect"
  if (sg < 0.995) return `SG ${sg.toFixed(3)} below water — Tilt likely out of liquid`;
  const att = calcAttenuation(og, sg);
  if (att != null && att > 100.5) {
    return `attenuation ${att}% impossible (SG < 1.000) — Tilt likely fallen or in foam`;
  }
  return null;
}

/** Progress toward the *expected* terminal gravity, 0–100 clamped. */
export function calcAttenuationProgress(
  og: number | null,
  sg: number | null,
  fg: number | null,
): number | null {
  if (og == null || sg == null || fg == null || og <= fg) return null;
  return Math.min(100, round(((og - sg) / (og - fg)) * 100, 0));
}

export function calcDaysFermenting(
  fermentingStart: number | null,
  now: number = Date.now(),
): number | null {
  if (fermentingStart == null) return null;
  return round((now - fermentingStart) / 86_400_000, 1);
}

/**
 * Project days remaining until terminal (expected FG) at the current attenuation
 * velocity. `velocityPerDay` is SG points/day (negative while attenuating).
 *
 * Returns:
 *   - a positive number of days when actively dropping toward FG
 *   - 0 when already at/below FG
 *   - null when stalled (velocity ~0) or data missing — we refuse to project a
 *     misleading ETA rather than divide by ~zero.
 */
export function calcDaysToTerminal(
  sg: number | null,
  fg: number | null,
  velocityPerDay: number | null,
): number | null {
  if (sg == null || fg == null || velocityPerDay == null) return null;
  const remaining = sg - fg;              // SG points still to drop
  if (remaining <= 0) return 0;           // already terminal
  // velocity is negative while attenuating; need meaningful downward motion
  if (velocityPerDay >= -0.0005) return null; // stalled → no honest ETA
  return round(remaining / -velocityPerDay, 1);
}

/**
 * Normalize a Brewfather readings[] entry (temp in °C, sg, time in ms) into a
 * BatchReading. Returns null for malformed rows so callers can filter.
 */
export function normalizeReading(
  r: { temp?: unknown; sg?: unknown; time?: unknown },
): { t: number; sg: number; tempF: number } | null {
  const t = Number(r.time);
  const sg = Number(r.sg);
  const tempC = Number(r.temp);
  if (!isFinite(t) || !isFinite(sg) || !isFinite(tempC)) return null;
  return { t, sg, tempF: round(tempC * 9 / 5 + 32, 1) };
}

// ---------------------------------------------------------------------------
// Plausibility — does the assignment hold up against physics?
// ---------------------------------------------------------------------------

/**
 * The assignment validator. If a Tilt claims to be in Tank 1, its beer temp
 * and Tank 1's probe temp should roughly agree. Large divergence means the
 * mapping is probably wrong (Tilt Black is actually in Tank 2, etc.).
 *
 * Threshold is generous (probe and Tilt read slightly different spots —
 * thermowell vs. free liquid, plus krausen effects), but a 5°F gap is a
 * red flag worth surfacing.
 */
export function verifyAssignment(
  tiltTempF: number | null,
  probeTempF: number | null,
  now: number = Date.now(),
  thresholdF = 5,
): AssignmentVerification {
  if (tiltTempF == null || probeTempF == null) {
    return { status: 'unverified' };
  }
  const delta = Math.abs(tiltTempF - probeTempF);
  if (delta <= thresholdF) {
    return { status: 'verified', checkedAt: now };
  }
  return {
    status: 'suspect',
    reason: `Tilt reads ${tiltTempF.toFixed(1)}°F but probe reads ${probeTempF.toFixed(1)}°F`,
    deltaF: round(delta, 1),
  };
}

// ---------------------------------------------------------------------------
// The join — assemble an ActiveBatch from the three sources + assignment
// ---------------------------------------------------------------------------

export function composeBatch(
  assignment: TankAssignment,
  tank: Tank,
  tilt: TiltDevice | null,
  bf: BrewfatherBatch | null,
  expectedFg: number | null,
  joinSource: 'assigned' | 'inferred' | 'none' = 'assigned',
  now: number = Date.now(),
): ActiveBatch | null {
  // No batch resolved for this tank → nothing to compose.
  if (assignment.batchNo == null || bf == null) return null;

  const gravity: Reading<number> = tilt?.gravity ?? emptyReading('tilt:gravity');
  const beerTemp: Reading<number> = tilt?.temperature ?? emptyReading('tilt:temp');

  const og = bf.measuredOg;
  const sg = gravity.value;

  // velocity: prefer the live Tilt 24h-change stat; fall back to slope of the
  // Brewfather reading history if the stat sensor isn't present.
  const gravityVelocityPerDay =
    tilt?.gravity24hChange?.value ?? historyVelocityPerDay(bf.history, now);
  const gravityNoise = tilt?.gravity3hStddev?.value ?? null;

  const attenuationProgress = calcAttenuationProgress(og, sg, expectedFg);
  const daysToTerminal = calcDaysToTerminal(sg, expectedFg, gravityVelocityPerDay);

  return {
    batchNo: bf.batchNo,
    name: bf.name,
    tank,
    tiltColor: assignment.tiltColor,

    gravity,
    beerTemp,
    probeTemp: tank.probeTemp,
    setpoint: tank.setpoint,
    targetTemp: bf.targetTemp,

    og,
    expectedFg,
    fermentingStart: bf.fermentingStart,

    abv: calcAbv(og, sg),
    attenuation: calcAttenuation(og, sg),
    daysFermenting: calcDaysFermenting(bf.fermentingStart, now),

    gravityVelocityPerDay,
    gravityNoise,
    attenuationProgress,
    daysToTerminal,
    beerTemp24h: {
      min: tilt?.beerTemp24hMin?.value ?? null,
      max: tilt?.beerTemp24hMax?.value ?? null,
    },
    joinSource,
    history: bf.history,

    // optional HA-derived signals — populated by the hook after compose; default
    // null so the app works without the derived-sensor package installed.
    fermentationStarted: null,
    projectedFgReach: null,
    paceVsSchedule: null,
    alerts: [],   // populated by the hook after compose (needs resolved Tilt color)
    gravityDropFromPeak: null,
    tiltGravityAgeMin: null,
    stableDays: null,
    terminalConfirmed: false,
    dryHop: false,
    bfConditioned: false,
    conditionDays: null,
    conditioningDaysElapsed: null,
    readyToKeg: false,

    verification: verifyAssignment(beerTemp.value, tank.probeTemp.value, now),
  };
}

/**
 * Fallback velocity: least-effort slope of the last 24h of reading history,
 * in SG points/day (negative while attenuating). Used only when the Tilt's
 * 24h-change stat sensor isn't available.
 */
export function historyVelocityPerDay(
  history: { t: number; sg: number }[],
  now: number = Date.now(),
): number | null {
  if (!history || history.length < 2) return null;
  const cutoff = now - 86_400_000;
  const recent = history.filter((r) => r.t >= cutoff);
  const pts = recent.length >= 2 ? recent : history.slice(-2);
  const first = pts[0];
  const last = pts[pts.length - 1];
  const days = (last.t - first.t) / 86_400_000;
  if (days <= 0) return null;
  return round((last.sg - first.sg) / days, 4);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function emptyReading(entityId: string): Reading<number> {
  return { value: null, updatedAt: null, staleness: 'unknown', entityId };
}
