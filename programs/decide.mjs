// programs/decide.mjs
// PURE control decision. Takes resolved inputs + current TankState, returns the
// command + next state + write intents. No I/O. See spec 2026-07-30.
import { tick } from './statemachine.mjs';
import { beerInBand, smoothOffset, slewLimit } from './tiltcomp.mjs';

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

  // ── TILT-COMP (pure port of runner.mjs tilt-comp block) ────────────────────
  // Shift the commanded setpoint by (probe − tilt) so the ITC-308's own loop holds
  // the BEER, not the thermowell. Asymmetric regimes kill the lagged-feedback swing:
  //   IN-BAND freeze · NEAR ema+slew · FAR raw-no-slew · Tilt-lost held/decaying.
  // Writes are pure state mutations (next.off); the runner persists them (Task 7).
  let commandF = r.setpointF;
  let tiltCtl = 'probe';
  const cfg = input.cfg ?? {};
  const c = control;
  if (commandF != null && /tilt/i.test(c.tempSource || 'Probe')) {
    const probeF = c.probeTempF ?? null;
    const tiltF = c.beerTempF ?? null;
    const tiltAgeMin = c.beerTempAgeMin ?? null;
    const tiltFresh = tiltF != null && (tiltAgeMin == null || tiltAgeMin <= 30);
    const prevOffset = tankState.off;
    const cap = cfg.OFFSET_CAP_F ?? 7;
    const clamp = (o) => Math.max(-cap, Math.min(cap, o));

    let offset = null;
    let farOff = false;
    const targetF = r.setpointF;
    if (probeF != null && tiltF != null && tiltFresh) {
      const err = Math.abs(tiltF - targetF);
      const raw = clamp(probeF - tiltF);
      if (beerInBand(tiltF, targetF, cfg.BAND_F ?? 0.6) && prevOffset != null) {
        offset = clamp(prevOffset); tiltCtl = 'tilt';          // IN-BAND: hold, no chase
      } else if (err > (cfg.FAR_OFF_F ?? 1.5) || prevOffset == null) {
        offset = raw; farOff = true; tiltCtl = 'tilt';         // FAR: full raw, no throttle
      } else {
        offset = clamp(smoothOffset(raw, prevOffset, cfg.EMA_ALPHA ?? 0.3)); tiltCtl = 'tilt';  // NEAR
      }
      next.off = offset;                                       // persist last-good (runner writes)
    } else if (prevOffset != null) {
      // Tilt not usable → HOLD within grace, else DECAY toward 0 over DECAY_H.
      const gapMin = tiltAgeMin ?? 9999;
      if (gapMin <= (cfg.GRACE_MIN ?? 45)) {
        offset = clamp(prevOffset); tiltCtl = 'held';
      } else {
        const past = (gapMin - (cfg.GRACE_MIN ?? 45)) / 60;    // hours past grace
        const f = Math.max(0, 1 - past / (cfg.DECAY_H ?? 4));
        offset = clamp(prevOffset * f); tiltCtl = 'decaying';
        if (Math.abs(offset) < 0.1) next.off = 0;
      }
    }

    if (offset != null && Math.abs(offset) >= 0.05) {
      const compensated = r.setpointF + offset;
      const clamped = program.clamp
        ? Math.max(program.clamp.minF, Math.min(program.clamp.maxF, compensated)) : compensated;
      // FAR → command the full correction now; NEAR/held → slew-limit per tick.
      commandF = farOff ? clamped : slewLimit(clamped, currentSetpointF, cfg.MAX_SLEW_F ?? 0.5);
    }
  }

  return {
    commandF,
    tiltCtl,
    advanceTo: r.advanceTo ?? null,
    awaitingConfirm: !!r.awaitingConfirm,
    done: !!r.done,
    note: r.note,
    nextState: next,
    writes: [],
  };
}
