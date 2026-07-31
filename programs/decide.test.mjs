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
