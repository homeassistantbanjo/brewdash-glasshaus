import { test } from 'node:test';
import assert from 'node:assert';
import { computeHealth, tankChecks } from './monitor.mjs';

const NOW = 1_800_000_000_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;

// build a healthy baseline `by` map: every watched entity present, fresh, sane.
function healthyBy() {
  const fresh = iso(1 * MIN);
  return {
    'sensor.glycol_temp': { entity_id: 'sensor.glycol_temp', state: '27.1', last_updated: fresh },
    'sensor.glycol_chiller_temp_temperature': { entity_id: 'sensor.glycol_chiller_temp_temperature', state: '35.2', last_updated: fresh },
    'sensor.glycol_power_current_consumption': { entity_id: 'sensor.glycol_power_current_consumption', state: '447', last_updated: fresh },
    'binary_sensor.glycol_power_cloud_connection': { entity_id: 'binary_sensor.glycol_power_cloud_connection', state: 'on', last_updated: fresh },
    'sensor.kegerator_power_current_consumption': { entity_id: 'sensor.kegerator_power_current_consumption', state: '284', last_updated: fresh },
    'binary_sensor.kegerator_power_cloud_connection': { entity_id: 'binary_sensor.kegerator_power_cloud_connection', state: 'on', last_updated: fresh },
    'binary_sensor.glycol_chiller_running_power': { entity_id: 'binary_sensor.glycol_chiller_running_power', state: 'on', last_updated: fresh },
    'sensor.glycol_compressor_cycles_1h': { entity_id: 'sensor.glycol_compressor_cycles_1h', state: '2', last_updated: fresh },
  };
}

test('healthy plant → no alerts', () => {
  const { alerts } = computeHealth(healthyBy(), NOW, []);
  assert.equal(alerts.length, 0, JSON.stringify(alerts));
});

test('FROZEN feed: glycol temp last_updated 6h ago → critical stale alert (the bug that bit us)', () => {
  const by = healthyBy();
  by['sensor.glycol_temp'].last_updated = iso(6 * 60 * MIN); // 6h, value still looks plausible
  const { alerts } = computeHealth(by, NOW, []);
  const a = alerts.find((x) => x.key === 'sensor.glycol_temp:stale');
  assert.ok(a, 'expected stale alert');
  assert.equal(a.severity, 'critical');
  assert.match(a.detail, /no update in 36[0-9]m/);
});

test('UNAVAILABLE beats stale: unavailable entity fires avail, not stale', () => {
  const by = healthyBy();
  by['sensor.glycol_temp'].state = 'unavailable';
  by['sensor.glycol_temp'].last_updated = iso(6 * 60 * MIN);
  const { alerts } = computeHealth(by, NOW, []);
  assert.ok(alerts.some((x) => x.key === 'sensor.glycol_temp:avail'));
  assert.ok(!alerts.some((x) => x.key === 'sensor.glycol_temp:stale'), 'should not double-fire stale');
});

test('missing entity → avail alert', () => {
  const by = healthyBy();
  delete by['sensor.glycol_chiller_temp_temperature'];
  const { alerts } = computeHealth(by, NOW, []);
  const a = alerts.find((x) => x.key === 'sensor.glycol_chiller_temp_temperature:avail');
  assert.ok(a);
  assert.match(a.detail, /entity missing/);
});

test('Kasa cloud link off → disconnect warning', () => {
  const by = healthyBy();
  by['binary_sensor.glycol_power_cloud_connection'].state = 'off';
  const { alerts } = computeHealth(by, NOW, []);
  assert.ok(alerts.some((x) => x.key === 'binary_sensor.glycol_power_cloud_connection:avail' && /disconnected/.test(x.detail)));
});

test('glycol warm: fresh reading >45F → critical', () => {
  const by = healthyBy();
  by['sensor.glycol_temp'].state = '47.0';
  const { alerts } = computeHealth(by, NOW, []);
  assert.ok(alerts.some((x) => x.key === 'glycol_warm' && x.severity === 'critical'));
});

test('glycol warm does NOT fire on a STALE reading (avoids double-fire w/ staleness)', () => {
  const by = healthyBy();
  by['sensor.glycol_temp'].state = '47.0';
  by['sensor.glycol_temp'].last_updated = iso(90 * MIN); // stale → warm suppressed
  const { alerts } = computeHealth(by, NOW, []);
  assert.ok(!alerts.some((x) => x.key === 'glycol_warm'));
  assert.ok(alerts.some((x) => x.key === 'sensor.glycol_temp:stale'));
});

test('glycol short-cycling: >8 starts/hr → warning', () => {
  const by = healthyBy();
  by['sensor.glycol_compressor_cycles_1h'].state = '12';
  const { alerts } = computeHealth(by, NOW, []);
  assert.ok(alerts.some((x) => x.key === 'glycol_short_cycle'));
});

test('chiller flagged running but ~0W → critical no-draw', () => {
  const by = healthyBy();
  by['binary_sensor.glycol_chiller_running_power'].state = 'on';
  by['sensor.glycol_power_current_consumption'].state = '3';
  const { alerts } = computeHealth(by, NOW, []);
  assert.ok(alerts.some((x) => x.key === 'glycol_no_draw' && x.severity === 'critical'));
});

// ---- per-tank controller (Inkbird plug) ----
test('tank with batch + controller plug unavailable → CRITICAL (temp control lost)', () => {
  const by = healthyBy();
  by['input_text.tank_1_batch'] = { state: '144' };
  by['switch.tank_1_temp_controller_power'] = { entity_id: 'switch.tank_1_temp_controller_power', state: 'unavailable', last_updated: iso(1 * MIN) };
  const checks = tankChecks('tank_1', by);
  const c = checks.find((x) => x.id === 'switch.tank_1_temp_controller_power');
  assert.ok(c && c.severity === 'critical');
  const { alerts } = computeHealth(by, NOW, ['tank_1']);
  assert.ok(alerts.some((x) => x.entityId === 'switch.tank_1_temp_controller_power'));
});

test('empty tank + controller offline → only WARNING, not critical', () => {
  const by = healthyBy();
  // no input_text.tank_2_batch → unassigned
  by['switch.tank_2_temp_controller_power'] = { entity_id: 'switch.tank_2_temp_controller_power', state: 'unavailable', last_updated: iso(1 * MIN) };
  const checks = tankChecks('tank_2', by);
  const c = checks.find((x) => x.id === 'switch.tank_2_temp_controller_power');
  assert.ok(c && c.severity === 'warning');
});

test('tank with batch but NO controller wired → synthetic warning', () => {
  const by = healthyBy();
  by['input_text.tank_2_batch'] = { state: '150' };
  const checks = tankChecks('tank_2', by);
  assert.ok(checks.some((x) => x.synthetic && x.key === 'tank_2_no_controller'));
});

test('empty tank, no controller → silent (no nag)', () => {
  const by = healthyBy();
  const checks = tankChecks('tank_3', by);
  assert.equal(checks.length, 0);
});
