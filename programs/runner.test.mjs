// programs/runner.test.mjs — seams of tickTank that can be tested without I/O.
// runner.mjs requires HA_URL/HA_TOKEN at load (process.exit(1) if absent) and only
// launches the tick loop when run as main (import.meta.main). Set placeholder env, then
// dynamic-import so the required-env check and any hoisting see the vars first.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HA_URL = process.env.HA_URL || 'http://test.invalid';
process.env.HA_TOKEN = process.env.HA_TOKEN || 'test-token';

const { _buildControlInput, _resolveInitialState } = await import('./runner.mjs');

test('_buildControlInput extracts pressMs from button last_changed', () => {
  const by = {
    'input_button.tank_2_confirm_crash': { state: '2026-07-30T15:00:00Z', last_changed: '2026-07-30T15:00:00Z' },
  };
  const inp = _buildControlInput('tank_2', by, { off: 3, cc: -1, lcp: 0 }, { gravityStale:false });
  assert.equal(inp.pressMs, Date.parse('2026-07-30T15:00:00Z'));
  assert.equal(inp.tankState.off, 3);
});

test('_buildControlInput: no button press → pressMs null', () => {
  const inp = _buildControlInput('tank_2', {}, { off: null, cc: -1, lcp: 0 }, { gravityStale:false });
  assert.equal(inp.pressMs, null);
});

// ── Task 8: boot hydration + graceful degrade ────────────────────────────────
test('_resolveInitialState: existing doc for current batch hydrates', () => {
  const by = { 'input_text.tank_2_control_state': { state: '{"b":"148","cc":0,"off":3,"ad":true,"pa":66,"ss":null,"us":null,"fl":true,"lcp":1000,"u":1}' } };
  const s = _resolveInitialState('tank_2', by, '148');
  assert.equal(s.cc, 0); assert.equal(s.off, 3); assert.equal(s.b, '148');
});

test('_resolveInitialState: doc for a DIFFERENT batch → re-seed (no stale latch)', () => {
  const by = { 'input_text.tank_2_control_state': { state: '{"b":"OLD","cc":2,"off":5,"ad":true}' } };
  const s = _resolveInitialState('tank_2', by, '148');
  assert.equal(s.b, '148');
  assert.equal(s.cc, -1);   // old batch's crash-confirm latch must NOT carry over
  assert.equal(s.ad, false);
});

test('_resolveInitialState: missing doc → seed from helpers', () => {
  const by = {
    'input_text.tank_2_control_state': { state: 'unknown' },
    'input_boolean.tank_2_fermentation_started': { state: 'on' },
    'input_number.tank_2_temp_offset': { state: '4.3' },
  };
  const s = _resolveInitialState('tank_2', by, '148');
  assert.equal(s.b, '148');
  assert.equal(s.fl, true);
  assert.equal(s.off, 4.3);
  assert.equal(s.ad, true);   // fermentation-started → adopted, no re-jump
});

test('_resolveInitialState: EMPTY-STRING crash helper (HA default) → cc=-1, NOT 0 (no phantom crash-confirm)', () => {
  // HA input_text helpers default to state '' when never written. numOr('') === 0 (Number('')===0
  // is finite), which corrupts crashConfirmedPhase to 0 at the CALL SITE — before seedFromHelpers'
  // own null-guard can see it. That seeds cc=0 → decideCommand alreadyLatched (cc===0===phaseIndex)
  // → auto-confirms an UNCONFIRMED phase-0 cold crash with zero button presses. This is the exact
  // real-world path (a generated single-phase crash plan at index 0) — must stay cc=-1.
  const by = {
    'input_text.tank_3_control_state': { state: '' },
    'input_text.tank_3_crash_confirmed_phase': { state: '' },
    'input_number.tank_3_temp_offset': { state: '' },
    'input_number.tank_3_program_phase': { state: '' },
  };
  const s = _resolveInitialState('tank_3', by, '148');
  assert.equal(s.cc, -1);
  assert.equal(s.off, null);
  assert.equal(s.ad, false);   // empty program_phase must NOT read as phaseIndex 0 > 0 (it isn't) nor corrupt
});

test('_resolveInitialState seeds lcp from an OLD confirm-button press (no phantom fresh press on boot)', () => {
  // HAZARD: on the cutover, decideCommand computes freshPress = pressMs > (lcp ?? 0). If the
  // crash-confirm button was pressed long ago (for a PRIOR crash), pressMs is a big positive ms
  // and a freshly-seeded lcp of null→0 would make that OLD press read as fresh → auto-confirm a
  // gated phase with no real press. Seed lcp from the button's last_changed so any pre-existing
  // press is already consumed; only a press AFTER cutover counts.
  const changed = '2026-07-25T12:00:00Z';
  const by = {
    'input_text.tank_2_control_state': { state: 'unknown' },
    'input_button.tank_2_confirm_crash': { state: changed, last_changed: changed },
  };
  const s = _resolveInitialState('tank_2', by, '148');
  assert.equal(s.lcp, Date.parse(changed));
});
