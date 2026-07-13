// GENERIC per-tank derived values + alert conditions + fermentation latch.
// Pure functions (no I/O) so they're testable and identical for every tank —
// this REPLACES the Black-only per-tank sensors in glasshaus_derived.yaml.
// Formulas mirror the app's src/data/derive.ts (parity for a clean cutover) and
// the alert thresholds from the old YAML.
//
// Input `t` (one tank, assembled by the runner from HA):
//   gravity, og, expectedFg (SG); beerTempF (Tilt), probeTempF, setpointF;
//   gravity24hDeltaPts (pts/day, from the tank's Tilt 24h stat OR history slope);
//   gravity8hMaxSg (rolling 8h max for settling-proof drop; runner maintains it);
//   gravityAgeMin (min since last Tilt reading); daysFermenting;
//   prevLatched (bool: was fermentation-started already latched this batch);
//   batchKey (identity to reset the latch when the batch changes).

const round = (n, dp) => { const f = 10 ** dp; return Math.round(n * f) / f; };
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// thresholds (mirror old YAML)
const DROP_ACTIVE_PTS = 4.0;         // gravity ≥4 pts below 8h peak = actively fermenting
const STALL_FLAT_PTS = 1.0;          // |24h delta| < 1 pt = flat
const STALL_ABOVE_FG_SG = 0.003;     // still >3pts above FG = not terminal
const NEAR_TERMINAL_SG = 0.003;      // within 3pts of FG = approaching terminal
const EXCURSION_F = 2.0;             // probe >2°F off setpoint
const EXCURSION_SETTLE_MIN = 120;    // grace after a SETPOINT CHANGE before excursion can fire —
                                     // the beer physically can't track a stepped setpoint instantly
                                     // (a crash step or free-rise takes hours), so don't cry
                                     // "excursion" while it's still converging. 2h normalization.
const SUSPECT_DELTA_F = 5.0;         // |tilt-probe| >5°F = wrong Tilt likely
const SIGNAL_LOST_MIN = 15;          // no Tilt reading in 15 min

function calcAttenuation(og, sg) {
  if (og == null || sg == null || og <= 1) return null;
  return round(((og - sg) / (og - 1)) * 100, 1);
}
function calcProgress(og, sg, fg) {
  if (og == null || sg == null || fg == null || og <= fg) return null;
  return Math.min(100, round(((og - sg) / (og - fg)) * 100, 0));
}
function calcDaysToTerminal(sg, fg, velPerDaySg) {
  if (sg == null || fg == null || velPerDaySg == null) return null;
  const remaining = sg - fg;
  if (remaining <= 0) return 0;
  if (velPerDaySg >= -0.0005) return null; // stalled
  return round(remaining / -velPerDaySg, 1);
}
function projectedFgDate(sg, fg, velPerDaySg, now) {
  if (sg == null || fg == null || velPerDaySg == null) return null;
  if (sg <= fg) return 'reached';
  if (velPerDaySg >= -0.0005) return 'stalled';
  const days = (sg - fg) / Math.abs(velPerDaySg);
  const d = new Date(now + days * 86_400_000);
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`;
}

/**
 * Compute the full derived object for one tank. Pure. `now` injected for testability.
 * Returns { attenuationPct, progressToFgPct, dropFromPeakPts, daysToTerminal,
 *   projectedFgReach, tiltProbeDeltaF, gravityAgeMin, controllerState?,
 *   fermentationStarted (latched), activelyFermenting, alerts[] }.
 */
export function computeDerived(t, now = 0) {
  const gravity = n(t.gravity), og = n(t.og), fg = n(t.expectedFg);
  const delta = n(t.gravity24hDeltaPts);
  const velSg = delta != null ? delta / 1000 : null; // pts/day → SG/day

  const attenuationPct = calcAttenuation(og, gravity);
  // Physically implausible gravity → the Tilt isn't in the beer (fallen sideways,
  // in foam/CO₂, or lifted out): SG below water, or apparent attenuation over
  // ~100.5% (SG < 1.000, impossible for real wort). The 0.5% tolerance absorbs
  // noise so a genuine ~100%-attenuation lager doesn't false-positive. Callers
  // should treat gravity/attenuation as untrustworthy while this is true.
  const gravitySuspect = gravity != null
    && (gravity < 0.995 || (attenuationPct != null && attenuationPct > 100.5));
  const progressToFgPct = calcProgress(og, gravity, fg);
  const daysToTerminal = calcDaysToTerminal(gravity, fg, velSg);
  // During a cold crash, fermentation is intentionally halted → velocity ~0 → the
  // projection would read "stalled", which is misleading (it's crashing, not stuck).
  // Report 'crashing' instead so the UI shows the real situation, not a false stall.
  const projectedFgReach = (t.inCrash === true)
    ? 'crashing'
    : projectedFgDate(gravity, fg, velSg, now);

  // Pace vs schedule: days ahead(+)/behind(-) the planned ferment window, by
  // attenuation progress vs elapsed fraction. Mirrors the old YAML gh_ferment_pace.
  // planned_days from Brewfather fermentation window if given, else 7 (TODO expose).
  const daysFermenting = n(t.daysFermenting);
  const plannedDays = n(t.plannedFermentDays) ?? 7;
  const paceVsSchedule = (progressToFgPct != null && daysFermenting != null && plannedDays > 0)
    ? round(((progressToFgPct / 100) - Math.min(daysFermenting / plannedDays, 1)) * plannedDays, 1)
    : null;

  // settling-proof cumulative drop from the rolling 8h peak (pts)
  const peak = n(t.gravity8hMaxSg);
  const dropFromPeakPts = (peak != null && gravity != null)
    ? round((peak - gravity) * 1000, 1) : null;
  const activelyFermenting = dropFromPeakPts != null && dropFromPeakPts >= DROP_ACTIVE_PTS;

  // one-shot fermentation-started LATCH: true once sustained active detected, held
  // until the batch changes. Runner passes prevLatched + resets on batchKey change.
  const fermentationStarted = !!t.prevLatched || activelyFermenting;

  const tiltProbeDeltaF = (n(t.beerTempF) != null && n(t.probeTempF) != null)
    ? round(t.beerTempF - t.probeTempF, 1) : null;
  const gravityAgeMin = n(t.gravityAgeMin);

  // --- gravity STABILITY: how long has gravity held terminal? -----------------
  // "stable" = within NEAR_TERMINAL_SG of expected FG AND flat (|24h delta| < 1pt).
  // The runner persists `stableSinceMs` (the epoch it FIRST became stable this run,
  // reset whenever it stops being stable); here we just turn that into days +
  // a readiness flag. Confirmed-terminal threshold is 3 days (5–7 if dry-hopped,
  // for hop creep). isStableNow is what the runner uses to maintain the timestamp.
  const nearFg = (gravity != null && fg != null) && (gravity - fg) <= NEAR_TERMINAL_SG && (gravity - fg) >= -0.006;
  const flatNow = delta != null && Math.abs(delta) < STALL_FLAT_PTS;
  const isStableNow = !!(og != null && nearFg && flatNow);
  const stableSinceMs = n(t.stableSinceMs);
  const stableDays = (isStableNow && stableSinceMs != null)
    ? round((now - stableSinceMs) / 86_400_000, 1) : (isStableNow ? 0 : null);
  const requiredStableDays = t.dryHopped ? 6 : 3;
  const terminalConfirmed = stableDays != null && stableDays >= requiredStableDays;

  // --- CONDITIONING countdown (time-based, NOT gravity) -----------------------
  // Once fermentation confirms terminal, the beer conditions before it's ready to
  // keg. The clock starts when fermentation FINISHED = stableSinceMs + the required
  // window (the instant terminalConfirmed flipped). conditionDays is resolved by
  // the brewfather container from BF profile steps / yeast type / style; we just
  // count down. Deliberately independent of setpoints, so no clash with the ferm
  // program. readyToKeg is the honest "packaging-readiness" milestone.
  const conditionDays = n(t.conditionDays);        // target, from Brewfather facts
  const fermentEndedMs = stableSinceMs != null ? stableSinceMs + requiredStableDays * 86_400_000 : null;
  const conditioningDaysElapsed = (terminalConfirmed && fermentEndedMs != null)
    ? round((now - fermentEndedMs) / 86_400_000, 1) : null;
  const readyToKeg = (terminalConfirmed && conditionDays != null && conditioningDaysElapsed != null)
    ? conditioningDaysElapsed >= conditionDays : false;

  // --- alert conditions (severity: problem | warning | milestone) ---
  // GRAVITY-based alerts require a batch actually ASSIGNED to this tank (OG present).
  // Without that, any Tilt reading is either absent or BORROWED from another tank's
  // Tilt (e.g. two tanks both pointed at "Black") — computing stall/near-terminal off
  // it is meaningless and produces false alerts on empty/unassigned tanks.
  const hasBatch = og != null;
  const alerts = [];
  const dev = (n(t.probeTempF) != null && n(t.setpointF) != null) ? t.probeTempF - t.setpointF : null;
  // Is the program actively DRIVING the temp toward a new target? During a cold crash
  // (or any ramp step) the beer intentionally lags the setpoint for hours, and a crash
  // deliberately halts fermentation — so the "stalled"/"excursion" heuristics would
  // false-fire. `inCrash` (cold-crash phase) and `setpointChangedMinAgo` (how long since
  // the setpoint last stepped) let us hold those alerts until things normalize.
  const inCrash = t.inCrash === true;
  const setpointSettling = n(t.setpointChangedMinAgo) != null && t.setpointChangedMinAgo < EXCURSION_SETTLE_MIN;
  const flat = delta != null && Math.abs(delta) < STALL_FLAT_PTS;
  const aboveFg = (gravity != null && fg != null) && (gravity - fg) > STALL_ABOVE_FG_SG;
  // STALLED: a beer that's flat + still well above FG is a real problem — UNLESS it's
  // being cold-crashed (cold stops fermentation ON PURPOSE, so flat-above-FG is expected).
  if (hasBatch && flat && aboveFg && !inCrash)
    alerts.push({ key: 'stalled', severity: 'problem', label: 'STALLED' });
  // TEMP EXCURSION: probe off setpoint. NOT gravity-based (matters even with no batch),
  // but suppressed for EXCURSION_SETTLE_MIN after the setpoint last changed — the beer
  // can't teleport to a new target, so a divergence right after a crash/ramp step is
  // expected convergence, not a fault. Only fires once the temp has had time to catch up.
  if (dev != null && Math.abs(dev) > EXCURSION_F && !setpointSettling)
    alerts.push({ key: 'temp_excursion', severity: 'problem', label: 'TEMP EXCURSION' });
  if (hasBatch && tiltProbeDeltaF != null && Math.abs(tiltProbeDeltaF) > SUSPECT_DELTA_F)
    alerts.push({ key: 'assignment_suspect', severity: 'problem', label: 'ASSIGNMENT SUSPECT' });
  if (hasBatch && gravityAgeMin != null && gravityAgeMin > SIGNAL_LOST_MIN)
    alerts.push({ key: 'signal_lost', severity: 'warning', label: 'TILT SIGNAL LOST' });
  // confirmed-terminal is a stronger, better milestone than bare near-terminal:
  // gravity has HELD stable for the required window (3d, or 6d dry-hopped).
  if (hasBatch && readyToKeg)
    alerts.push({ key: 'ready_to_keg', severity: 'milestone', label: 'READY TO KEG' });
  else if (hasBatch && terminalConfirmed)
    alerts.push({ key: 'terminal_confirmed', severity: 'milestone', label: `TERMINAL ${stableDays}d STABLE` });
  else if (hasBatch && gravity != null && fg != null && (gravity - fg) <= NEAR_TERMINAL_SG)
    alerts.push({ key: 'approaching_terminal', severity: 'milestone', label: 'NEAR TERMINAL' });
  const rank = { problem: 0, warning: 1, milestone: 2 };
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return {
    attenuationPct, gravitySuspect, progressToFgPct, paceVsSchedule, dropFromPeakPts, daysToTerminal,
    projectedFgReach, tiltProbeDeltaF, gravityAgeMin, fermentationStarted, activelyFermenting, alerts,
    // gravity stability (readiness signal)
    isStableNow, stableDays, terminalConfirmed, requiredStableDays,
    // conditioning countdown (time-based; target resolved from Brewfather facts)
    conditionDays, conditioningDaysElapsed, readyToKeg,
  };
}

export const _fmt = { calcAttenuation, calcProgress, calcDaysToTerminal, projectedFgDate };
