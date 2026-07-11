process.env.DB_PATH = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert';
import { summarizeCurve, styleCategory, batchFieldsFromBf, captureBatch } from './capture.mjs';
import { getBatch, getReadings } from './db.mjs';

const DAY = 86_400_000;
// a fake Belle Saison curve: pitch 68, free-rise, peak ~87, terminal by day 5
const curve = [
  { t: 0,        tempF: 68, gravity: 1.054, source: 'tilt_red' },
  { t: 1*DAY,    tempF: 74, gravity: 1.040, source: 'tilt_red' },
  { t: 2*DAY,    tempF: 82, gravity: 1.022, source: 'tilt_red' },
  { t: 3*DAY,    tempF: 87, gravity: 1.012, source: 'tilt_red' },
  { t: 5*DAY,    tempF: 85, gravity: 1.008, source: 'tilt_red' },
];

test('summarizeCurve: pitch/peak/avg/min + days', () => {
  const s = summarizeCurve(curve, 1.054, 1.008);
  assert.equal(s.pitchTempF, 68);   // first reading
  assert.equal(s.peakTempF, 87);
  assert.equal(s.minTempF, 68);
  assert.ok(s.avgTempF > 68 && s.avgTempF < 87);
  assert.equal(s.daysToTerminal, 5); // first point ≤ fg+0.002 is day 5 (1.008)
});

test('summarizeCurve: empty → {}', () => {
  assert.deepEqual(summarizeCurve([], 1.05, 1.01), {});
});

test('styleCategory fuzzy match', () => {
  assert.equal(styleCategory('Belgian Saison'), 'Saison');
  assert.equal(styleCategory('Farmhouse Ale'), 'Saison');
  assert.equal(styleCategory('Czech Dark Lager'), 'Lager');
  assert.equal(styleCategory('New England IPA'), 'Hazy IPA');
  assert.equal(styleCategory('American Stout'), 'Dark Ale');
  assert.equal(styleCategory(null), null);
});

test('batchFieldsFromBf maps measured + computes abv/attenuation', () => {
  const bf = {
    id: 'abc', name: 'Echoes', batchNo: 144, style: 'Czech Dark Lager', yeastType: 'Lager',
    og: 1.054, fermentingStart: 1000, history: curve,
    measured: { og: 1.054, fg: 1.010, mashPh: 5.4, batchSizeGal: 5.5 },
  };
  const f = batchFieldsFromBf(bf);
  assert.equal(f.batch_no, 144);
  assert.equal(f.style_category, 'Lager');
  assert.equal(f.og, 1.054);
  assert.equal(f.fg, 1.010);
  assert.ok(Math.abs(f.abv - 5.8) < 0.2);           // (1.054-1.010)*131.25 ≈ 5.8
  assert.ok(Math.abs(f.attenuation - 81.5) < 1);    // (0.044/0.054)*100 ≈ 81.5
  assert.equal(f.peak_temp_f, 87);
  assert.equal(f.pitch_temp_f, 68);
});

test('captureBatch: end-to-end into DB (batch row + readings)', () => {
  const bf = {
    id: 'xyz', name: 'Saison Test', batchNo: 500, style: 'Saison', yeastType: 'Ale',
    yeastName: 'Belle Saison', og: 1.052, fermentingStart: 2000, history: curve,
    measured: { og: 1.052, fg: 1.004 },
  };
  const { batchId, readingsInserted } = captureBatch(bf, { completed_at: 9999, days_conditioned: 30 });
  assert.ok(batchId > 0);
  assert.equal(readingsInserted, 5);
  const row = getBatch(500);
  assert.equal(row.yeast_name, 'Belle Saison');
  assert.equal(row.style_category, 'Saison');
  assert.equal(row.completed_at, 9999);
  assert.equal(row.days_conditioned, 30);
  assert.equal(getReadings(batchId).length, 5);
  // re-capture is idempotent on readings (dedupe) — same 5, 0 new
  const again = captureBatch(bf);
  assert.equal(again.readingsInserted, 0);
});
