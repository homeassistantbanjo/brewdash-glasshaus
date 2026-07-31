// programs/decide.mjs
// PURE control decision. Takes resolved inputs + current TankState, returns the
// command + next state + write intents. No I/O. See spec 2026-07-30.
import { tick } from './statemachine.mjs';

export function decideCommand(input) {
  const { program, phaseIndex, phaseElapsedHours, currentSetpointF, tankState, pressMs, control } = input;
  const next = { ...tankState };

  // CONFIRM EDGE-DETECT: a press counts iff strictly newer than the last consumed one.
  // No wall-clock freshness window (that window == tick period caused dropped presses).
  const freshPress = pressMs != null && pressMs > (tankState.lcp ?? 0);
  const alreadyLatched = tankState.cc === phaseIndex;
  const confirmPressed = freshPress || alreadyLatched;
  if (freshPress) { next.lcp = pressMs; next.cc = phaseIndex; }

  const r = tick(program, {
    phaseIndex, phaseElapsedHours, currentSetpointF,
    phaseStartSetpointF: control.phaseStartSetpointF ?? currentSetpointF,
    gravityStale: control.gravityStale, confirmPressed,
    gravity: control.gravity ?? null, expectedFg: control.expectedFg ?? null,
    og: control.og ?? null, apparentAttenuationPct: control.apparentAttenuationPct ?? null,
    progressToFgPct: control.progressToFgPct ?? null, gravity24hDeltaPts: control.gravity24hDeltaPts ?? null,
    expectedAttenuationPct: control.expectedAttenuationPct ?? null,
  });

  return {
    commandF: r.setpointF,
    tiltCtl: 'probe',
    advanceTo: r.advanceTo ?? null,
    awaitingConfirm: !!r.awaitingConfirm,
    done: !!r.done,
    note: r.note,
    nextState: next,
    writes: [],
  };
}
