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
  const progressToFgPct = calcProgress(og, gravity, fg);
  const daysToTerminal = calcDaysToTerminal(gravity, fg, velSg);
  const projectedFgReach = projectedFgDate(gravity, fg, velSg, now);

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

  // --- alert conditions (severity: problem | warning | milestone) ---
  const alerts = [];
  const dev = (n(t.probeTempF) != null && n(t.setpointF) != null) ? t.probeTempF - t.setpointF : null;
  const flat = delta != null && Math.abs(delta) < STALL_FLAT_PTS;
  const aboveFg = (gravity != null && fg != null) && (gravity - fg) > STALL_ABOVE_FG_SG;
  if (flat && aboveFg)
    alerts.push({ key: 'stalled', severity: 'problem', label: 'STALLED' });
  if (dev != null && Math.abs(dev) > EXCURSION_F)
    alerts.push({ key: 'temp_excursion', severity: 'problem', label: 'TEMP EXCURSION' });
  if (tiltProbeDeltaF != null && Math.abs(tiltProbeDeltaF) > SUSPECT_DELTA_F)
    alerts.push({ key: 'assignment_suspect', severity: 'problem', label: 'ASSIGNMENT SUSPECT' });
  if (gravityAgeMin != null && gravityAgeMin > SIGNAL_LOST_MIN)
    alerts.push({ key: 'signal_lost', severity: 'warning', label: 'TILT SIGNAL LOST' });
  if (gravity != null && fg != null && (gravity - fg) <= NEAR_TERMINAL_SG)
    alerts.push({ key: 'approaching_terminal', severity: 'milestone', label: 'NEAR TERMINAL' });
  const rank = { problem: 0, warning: 1, milestone: 2 };
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return {
    attenuationPct, progressToFgPct, paceVsSchedule, dropFromPeakPts, daysToTerminal,
    projectedFgReach, tiltProbeDeltaF, gravityAgeMin, fermentationStarted, activelyFermenting, alerts,
  };
}

export const _fmt = { calcAttenuation, calcProgress, calcDaysToTerminal, projectedFgDate };
