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
