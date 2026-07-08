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
function conditionMet(cond, s) {
  if (!cond) return false;
  switch (cond.type) {
    case 'attenuation':
      return s.apparentAttenuationPct != null && s.apparentAttenuationPct >= cond.pct;
    case 'progressToFg':
      return s.progressToFgPct != null && s.progressToFgPct >= cond.pct;
    case 'elapsed':
      return s.phaseElapsedHours != null && s.phaseElapsedHours >= cond.hours;
    case 'active':
      // fermentation started: gravity dropping meaningfully OR already well below OG
      return (s.gravity24hDeltaPts != null && s.gravity24hDeltaPts <= -2)
          || (s.og != null && s.gravity != null && (s.og - s.gravity) > 0.004);
    case 'terminal': {
      if (s.gravity == null || s.expectedFg == null || s.gravity24hDeltaPts == null) return false;
      const flat = Math.abs(s.gravity24hDeltaPts) < TERMINAL_FLAT_PTS;
      const nearFg = (s.gravity - s.expectedFg) <= TERMINAL_NEAR_FG_SG;
      // require BOTH flat AND at/near FG, held for a while (phase has run >= 12h)
      return flat && nearFg && (s.phaseElapsedHours ?? 0) >= 12;
    }
    case 'confirm':
      return s.confirmPressed === true;
    default:
      return false;
  }
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
      const dir = phase.targetF >= start ? 1 : -1;
      const stepped = start + dir * step * steps;
      // don't overshoot the target
      return dir > 0 ? Math.min(stepped, phase.targetF) : Math.max(stepped, phase.targetF);
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
  const conditionIsDataDriven = phase.advance
    && ['attenuation', 'progressToFg', 'terminal', 'active'].includes(phase.advance.type);
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
