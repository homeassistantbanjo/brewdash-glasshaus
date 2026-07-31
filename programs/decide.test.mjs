// programs/decide.test.mjs — pure decideCommand: confirm edge-detect + gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCommand } from './decide.mjs';
import { defaultState } from './tankstate.mjs';

const crashPlan = { clamp:{minF:32,maxF:75}, phases:[{ name:'Cold Crash', kind:'coldCrash', targetF:36, stepF:3, everyHours:1, requiresConfirm:true }] };
const baseInput = (over={}) => ({
  program: crashPlan, phaseIndex: 0, phaseElapsedHours: 0, currentSetpointF: 66,
  tankState: defaultState('148'), pressMs: null,
  control: { gravityStale: false, phaseStartSetpointF: 66 }, ...over,
});

test('gated crash with no press + not latched → awaiting', () => {
  const d = decideCommand(baseInput());
  assert.equal(d.awaitingConfirm, true);
});

test('fresh press (pressMs > lcp) → runs + latches cc & lcp', () => {
  const st = defaultState('148'); st.lcp = 1000;
  const d = decideCommand(baseInput({ pressMs: 2000, tankState: st }));
  assert.equal(d.awaitingConfirm, false);
  assert.equal(d.nextState.cc, 0);
  assert.equal(d.nextState.lcp, 2000);
  assert.ok(d.commandF < 66);   // crash steps down
});

test('already-consumed press (pressMs == lcp) does NOT re-latch', () => {
  const st = defaultState('148'); st.lcp = 2000; st.cc = -1;
  const d = decideCommand(baseInput({ pressMs: 2000, tankState: st }));
  assert.equal(d.awaitingConfirm, true);   // not newer than lcp → not a fresh press
});

test('already-latched phase (cc==phaseIndex) runs WITHOUT a press', () => {
  const st = defaultState('148'); st.cc = 0;
  const d = decideCommand(baseInput({ pressMs: null, tankState: st }));
  assert.equal(d.awaitingConfirm, false);
  assert.ok(d.commandF < 66);
});

test('stale-but-newer press still latches (no wall-clock window)', () => {
  const st = defaultState('148'); st.lcp = 0;
  const d = decideCommand(baseInput({ pressMs: 1, tankState: st }));  // pressMs tiny but > lcp
  assert.equal(d.awaitingConfirm, false);
  assert.equal(d.nextState.lcp, 1);
});

// ── Task 4: tilt-comp regimes ────────────────────────────────────────────────
import { defaultState as ds } from './tankstate.mjs';
const cfg = { EMA_ALPHA:0.3, MAX_SLEW_F:0.5, BAND_F:0.6, FAR_OFF_F:1.5, OFFSET_CAP_F:7, GRACE_MIN:45, DECAY_H:4 };
const holdPlan = { clamp:{minF:32,maxF:75}, phases:[{ name:'Hold', kind:'hold', tempF:66 }] };
const tiltInput = (over={}) => ({
  program: holdPlan, phaseIndex:0, phaseElapsedHours:0, currentSetpointF:66,
  tankState: ds('148'), pressMs:null, cfg,
  control: { gravityStale:false, phaseStartSetpointF:66, tempSource:'Tilt',
    beerTempF:64, beerTempAgeMin:1, probeTempF:67.5 }, ...over,
});

test('far off target → full raw offset, no slew throttle', () => {
  // beer 64, target 66 → err 2 > FAR_OFF 1.5 → offset = probe-tilt = 3.5, command ~69.5
  const d = decideCommand(tiltInput());
  assert.equal(d.tiltCtl, 'tilt');
  assert.ok(d.commandF >= 69 && d.commandF <= 70);
  assert.ok(Math.abs(d.nextState.off - 3.5) < 0.01);
});

test('in-band → freeze offset (no chase)', () => {
  const st = ds('148'); st.off = 3;
  const d = decideCommand(tiltInput({ control: { gravityStale:false, phaseStartSetpointF:66, tempSource:'Tilt', beerTempF:66.2, beerTempAgeMin:1, probeTempF:69 }, tankState: st }));
  assert.equal(d.nextState.off, 3);   // held, unchanged
});

test('probe mode → no tilt-comp, command = plan setpoint', () => {
  const d = decideCommand(tiltInput({ control: { gravityStale:false, phaseStartSetpointF:66, tempSource:'Probe' } }));
  assert.equal(d.tiltCtl, 'probe');
  assert.equal(d.commandF, 66);
});

test('paused (gravity stale, data-driven advance gated) is forwarded to the decision', () => {
  // tick() returns paused:true when gravity is stale and the phase has a data-driven advance —
  // the "holding, not advancing" safety state. decideCommand MUST forward it so the status entity
  // and health automation can distinguish "actively controlling" from "holding on untrusted data".
  const dataDrivenPlan = { clamp:{minF:32,maxF:75}, phases:[{ name:'Primary', kind:'hold', tempF:66, advance:{ type:'attenuation', pct:75 } }] };
  const d = decideCommand({
    program: dataDrivenPlan, phaseIndex:0, phaseElapsedHours:0, currentSetpointF:66,
    tankState: defaultState('148'), pressMs:null,
    control: { gravityStale:true, phaseStartSetpointF:66, tempSource:'Probe' },
  });
  assert.equal(d.paused, true);
  assert.match(d.note, /stale/);
});
