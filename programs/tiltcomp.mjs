// TILT-COMPENSATED SETPOINT smoothing — PURE, testable control math.
//
// THE PROBLEM (measured): the ITC-308 thermowell probe is FAST + noisy (cycles ±1.5°F as the
// compressor kicks); the Tilt floats in the beer, which is slow + thermally damped, and it
// reports that slow value LATE. So a raw per-tick offset = (probe − tilt) subtracts a fast
// noisy signal from a slow lagged one → the offset JITTERS, and writing that jitter straight to
// the setpoint makes the ITC-308 chase its own tail (hunting). The beer itself is stable; the
// COMMANDED setpoint is what oscillates.
//
// THE FIX (two damping stages, both can only stabilize — never run the beer away):
//   1. EMA-smooth the offset: newEma = α·raw + (1−α)·prevEma. Small α = heavy smoothing, so a
//      one-tick probe spike barely moves the applied offset. Tracks the slow beer, ignores the
//      fast noise. A DEADBAND then suppresses tiny wiggles (don't rewrite the setpoint for 0.1°).
//   2. Slew-rate limit the commanded setpoint: cap change to maxSlewF per tick. The beer can't
//      physically track a big instant setpoint jump, so ramping it gently converges without the
//      compressor slamming / overshoot.
//
// All params come from env with sane defaults (see runner). Pure functions here so the control
// behavior is unit-tested independent of HA/I-O.

/** Clamp x into [lo, hi]. */
export function clampRange(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/**
 * EMA-smooth the offset.
 * @param rawOffset  this tick's raw (probe − tilt), already hard-clamped by the caller
 * @param prevEma    the persisted smoothed offset from last tick (null on first ever tick)
 * @param alpha      smoothing factor 0<α≤1 (small = smoother/slower). Default caller ~0.3.
 * @returns the new smoothed offset. First tick (prevEma null) seeds to rawOffset so we don't
 *          ramp up from 0 — we already trust a single reading enough to start there.
 */
export function smoothOffset(rawOffset, prevEma, alpha) {
  if (rawOffset == null) return prevEma ?? null;
  if (prevEma == null || !Number.isFinite(prevEma)) return rawOffset;   // seed
  const a = clampRange(alpha, 0.01, 1);
  return a * rawOffset + (1 - a) * prevEma;
}

/**
 * TARGET DEADBAND — the real cure for lagged-feedback hunting. A tilt-comp loop that
 * CONTINUOUSLY chases the Tilt will oscillate: beer warms toward target → Tilt rises → offset
 * shrinks → setpoint pulled down → beer cools → Tilt drops → offset grows → setpoint up …
 * forever (a limit cycle, because the Tilt reports the beer LATE so every correction is out of
 * phase). Fix: once the beer (Tilt) is within `bandF` of the actual target, FREEZE the offset —
 * stop adjusting the setpoint at all. Only re-engage correction when the beer drifts OUTSIDE
 * the band. Near target it sits still (no chase = no oscillation); far from target it corrects.
 *
 * @param tiltF     current beer temp (Tilt)
 * @param targetF   the ACTUAL target beer temp (the program setpoint before compensation)
 * @param bandF     tolerance; inside ±bandF of target we hold the offset. Default caller ~0.5.
 * @returns true if the beer is within the band (→ caller holds prevOffset, doesn't recompute).
 */
export function beerInBand(tiltF, targetF, bandF) {
  if (tiltF == null || targetF == null) return false;   // can't judge → let normal logic run
  return Math.abs(tiltF - targetF) <= Math.abs(bandF);
}

/**
 * Slew-rate limit the commanded setpoint: don't let it move more than maxSlewF from where it
 * currently is in one tick. The beer's thermal mass can't follow faster; a gentle ramp avoids
 * compressor slam + overshoot.
 * @param desiredF   the setpoint we'd like to command (target + smoothed offset, clamped)
 * @param currentF   the setpoint currently on the controller (null → no limit, first write)
 * @param maxSlewF   max °F change allowed this tick
 * @returns the setpoint to actually command (stepped toward desiredF by at most maxSlewF)
 */
export function slewLimit(desiredF, currentF, maxSlewF) {
  if (desiredF == null) return null;
  if (currentF == null || !Number.isFinite(currentF)) return desiredF;   // first write: no prior to ramp from
  const step = clampRange(desiredF - currentF, -Math.abs(maxSlewF), Math.abs(maxSlewF));
  return currentF + step;
}

/**
 * Should we bother writing the setpoint? Suppress sub-deadband changes so we don't rewrite the
 * ITC-308 for meaningless 0.1° wiggles (each write bumps the controller + logs noise).
 * @param commandF   the setpoint we intend to write
 * @param currentF   what's on the controller now
 * @param deadbandF  minimum change worth writing
 */
export function worthWriting(commandF, currentF, deadbandF) {
  if (commandF == null) return false;
  if (currentF == null || !Number.isFinite(currentF)) return true;
  return Math.abs(commandF - currentF) >= Math.abs(deadbandF);
}
