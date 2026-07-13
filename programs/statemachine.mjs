// Fermentation program STATE MACHINE — pure logic, no I/O (so it's testable).
// Given the running program, current phase index, phase-start time, last setpoint,
// and live sensor readings, decide: the setpoint to command now + whether/how to
// advance the phase. ALL setpoint outputs are clamped to the program's bounds.
import { CUSTOM_MAX_CEILING_F } from './presets.mjs';

const MAX_STEP_F = 5;      // hard cap on any single setpoint change
const TERMINAL_FLAT_PTS = 1.0;   // |gravity_24h_delta| < this = "flat"
const TERMINAL_NEAR_FG_SG = 0.003; // within this of expected FG = "at terminal"

function clampTemp(f, clamp) {
  const min = clamp?.minF ?? 32;
  const max = Math.min(clamp?.maxF ?? 75, CUSTOM_MAX_CEILING_F);
  return Math.max(min, Math.min(max, f));
}

// limit how far a single write can move from the current setpoint (belt & suspenders
// on top of ramp step sizing — never jump more than MAX_STEP_F at once)
function rateLimit(target, currentSetpointF) {
  if (currentSetpointF == null) return target;
  const delta = target - currentSetpointF;
  if (Math.abs(delta) <= MAX_STEP_F) return target;
  return currentSetpointF + Math.sign(delta) * MAX_STEP_F;
}

// --- advance-condition evaluation ---------------------------------------------
// `adopting` = we're deciding the START phase for an already-in-progress ferment,
// so time-in-phase requirements don't apply (the beer's been going, this phase hasn't).
function conditionMet(cond, s, adopting = false) {
  if (!cond) return false;
  // COMPOUND conditions: { all: [...] } → every sub-condition true (AND);
  // { any: [...] } → at least one true (OR / timeout-safety). Recurses, so sub-
  // conditions can themselves be compound. Enables strain-specific hold logic like
  // "advance when elapsed ≥ 18h AND attenuation ≥ 20%" (time floor + gravity), or
  // "elapsed ≥ 36h OR 75% attenuation" (whichever first). Single-condition advances
  // (a plain {type,...}) fall through unchanged — full backward compatibility.
  if (Array.isArray(cond.all)) return cond.all.every((c) => conditionMet(c, s, adopting));
  if (Array.isArray(cond.any)) return cond.any.some((c) => conditionMet(c, s, adopting));
  switch (cond.type) {
    case 'attenuation':
      return s.apparentAttenuationPct != null && s.apparentAttenuationPct >= cond.pct;
    case 'attenuationOfExpected': {
      // advance when apparent attenuation reaches cond.pct% OF THIS STRAIN'S expected
      // attenuation (from the Brewfather yeast spec) — self-adjusting per strain, so
      // "80%" means 80% of US-05's 81% (≈65% AA), not an absolute 80%. Falls back to
      // treating cond.pct as absolute if the strain's expected attenuation is unknown.
      if (s.apparentAttenuationPct == null) return false;
      const exp = s.expectedAttenuationPct;
      const threshold = (exp != null && exp > 0) ? (cond.pct / 100) * exp : cond.pct;
      return s.apparentAttenuationPct >= threshold;
    }
    case 'progressToFg':
      return s.progressToFgPct != null && s.progressToFgPct >= cond.pct;
    case 'elapsed':
      // when adopting, we can't know past phase time → treat as NOT satisfied (don't skip a
      // timed hold blindly); during a run, use the phase clock.
      return !adopting && s.phaseElapsedHours != null && s.phaseElapsedHours >= cond.hours;
    case 'active':
      // fermentation started: gravity dropping meaningfully OR already well below OG
      return (s.gravity24hDeltaPts != null && s.gravity24hDeltaPts <= -2)
          || (s.og != null && s.gravity != null && (s.og - s.gravity) > 0.004);
    case 'terminal': {
      if (s.gravity == null || s.expectedFg == null || s.gravity24hDeltaPts == null) return false;
      const flat = Math.abs(s.gravity24hDeltaPts) < TERMINAL_FLAT_PTS;
      const nearFg = (s.gravity - s.expectedFg) <= TERMINAL_NEAR_FG_SG;
      // during a run require it held ≥12h; when adopting, current flat+nearFG is enough.
      return flat && nearFg && (adopting || (s.phaseElapsedHours ?? 0) >= 12);
    }
    case 'confirm':
      return s.confirmPressed === true;
    default:
      return false;
  }
}

/**
 * ADOPT an in-progress ferment: pick the phase the beer is currently "in" by
 * walking phases and skipping any whose advance condition is ALREADY satisfied
 * — but NEVER auto-skip a gated (requiresConfirm) phase like cold crash. Returns
 * the phase index to start at. For a fresh pitch this returns 0 (nothing skipped).
 */
export function resolveStartPhase(program, state) {
  let i = 0;
  for (; i < program.phases.length; i++) {
    const phase = program.phases[i];
    // never skip INTO/PAST a gated phase automatically — stop here and let it await confirm
    if (phase.requiresConfirm) break;
    // if this phase's exit condition is already met, the beer is past it → skip
    if (phase.advance && conditionMet(phase.advance, { ...state, phaseElapsedHours: 999 }, true)) {
      continue;
    }
    break; // this is the phase we're in
  }
  return Math.min(i, program.phases.length - 1);
}

// target temp for the current phase (before clamp/rate-limit)
function phaseTargetTemp(phase, currentSetpointF, s) {
  switch (phase.kind) {
    case 'hold':
      return phase.tempF;
    case 'wait':
      // hold whatever we were at (end of ramp temp)
      return currentSetpointF ?? phase.tempF ?? null;
    case 'ramp':
    case 'coldCrash': {
      // step toward targetF by stepF each everyHours interval, based on phase elapsed
      const step = phase.stepF ?? MAX_STEP_F;
      const every = phase.everyHours ?? 12;
      const elapsed = s.phaseElapsedHours ?? 0;
      const steps = Math.floor(elapsed / every) + 1; // include an initial step at phase start
      const start = s.phaseStartSetpointF ?? currentSetpointF ?? phase.targetF;
      // direction is toward the target FROM THE ANCHOR for a ramp; but a COLD CRASH
      // must never warm the beer — it always steps DOWN toward its (lower) target, no
      // matter what the anchor says. This makes the crash robust even if a stale anchor
      // leaks in (the bug that made a 65→34 crash compute 70 going UP).
      const dir = phase.kind === 'coldCrash' ? -1 : (phase.targetF >= start ? 1 : -1);
      const stepped = start + dir * step * steps;
      // don't overshoot the target
      const bounded = dir > 0 ? Math.min(stepped, phase.targetF) : Math.max(stepped, phase.targetF);
      // extra safety for a crash: never command ABOVE the current setpoint (no warming)
      if (phase.kind === 'coldCrash' && currentSetpointF != null) return Math.min(bounded, currentSetpointF);
      return bounded;
    }
    default:
      return currentSetpointF ?? null;
  }
}

/**
 * Decide the next action for a running program.
 * @param program {clamp, phases[]}
 * @param state { phaseIndex, phaseElapsedHours, phaseStartSetpointF, currentSetpointF,
 *                gravityStale, confirmPressed, ...sensors(gravity, expectedFg, og,
 *                apparentAttenuationPct, progressToFgPct, gravity24hDeltaPts) }
 * @returns { setpointF|null, advanceTo|null, awaitingConfirm, paused, note }
 */
export function tick(program, state) {
  const phase = program.phases[state.phaseIndex];
  if (!phase) return { setpointF: null, advanceTo: null, done: true, note: 'program complete' };

  // SAFETY: if gravity data is stale/lost, HOLD current setpoint and do NOT advance
  // condition-gated phases (don't act on bad data). Time-only phases may still advance.
  // NOTE: 'attenuationOfExpected' MUST be here — it's the diastatic-aware advance type
  // the saison/Brett plans use; without it a bad Tilt could advance a phase (e.g. call
  // a diastatic beer "done") on garbage attenuation. This was the gap the saison trace
  // surfaced.
  const conditionIsDataDriven = phase.advance
    && ['attenuation', 'attenuationOfExpected', 'progressToFg', 'terminal', 'active'].includes(phase.advance.type);
  if (state.gravityStale && conditionIsDataDriven) {
    return { setpointF: clampTemp(state.currentSetpointF ?? phase.tempF ?? 34, program.clamp),
      advanceTo: null, paused: true, note: 'gravity data stale — holding, not advancing' };
  }

  // GATED phase (e.g. cold crash): do not run until confirmed.
  if (phase.requiresConfirm && !state.confirmPressed) {
    return { setpointF: clampTemp(state.currentSetpointF ?? 34, program.clamp),
      advanceTo: null, awaitingConfirm: true,
      note: `awaiting confirmation to start "${phase.name}"` };
  }

  // compute + clamp + rate-limit this phase's setpoint
  const rawTarget = phaseTargetTemp(phase, state.currentSetpointF, state);
  let setpointF = rawTarget == null ? null
    : rateLimit(clampTemp(rawTarget, program.clamp), state.currentSetpointF);
  if (setpointF != null) setpointF = clampTemp(setpointF, program.clamp);

  // should we advance to the next phase?
  let advanceTo = null;
  // a coldCrash/ramp phase is "complete" when it has reached target AND (for crash) held;
  // otherwise use the phase's advance condition.
  if (phase.advance && conditionMet(phase.advance, state)) {
    advanceTo = state.phaseIndex + 1;
  } else if ((phase.kind === 'ramp' || phase.kind === 'coldCrash') && !phase.advance) {
    // ramp/crash with no explicit condition: advance once target reached
    if (setpointF != null && Math.abs(setpointF - phase.targetF) < 0.05) advanceTo = state.phaseIndex + 1;
  } else if (phase.kind === 'wait' && (state.phaseElapsedHours ?? 0) >= (phase.hours ?? 0)) {
    advanceTo = state.phaseIndex + 1;
  }

  return { setpointF, advanceTo, note: `${phase.name}: target ${setpointF}°F` };
}

export const _internals = { clampTemp, rateLimit, conditionMet, phaseTargetTemp };
