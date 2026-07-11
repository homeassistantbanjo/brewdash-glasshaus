// Run against an in-memory DB (no /data needed). Sets DB_PATH before importing db.mjs.
process.env.DB_PATH = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert';
import { db, upsertBatch, getBatch, listBatches, insertReadings, getReadings,
         addTasting, getTastings } from './db.mjs';

test('upsert creates then merges (no clobber of untouched fields)', () => {
  const id = upsertBatch({ batch_no: 144, name: 'Echoes of the Void', yeast_name: 'Belle Saison', og: 1.054 });
  assert.ok(id > 0);
  // second upsert updates FG but must NOT wipe name/og
  upsertBatch({ batch_no: 144, fg: 1.008, abv: 6.1 });
  const b = getBatch(144);
  assert.equal(b.name, 'Echoes of the Void');   // preserved
  assert.equal(b.og, 1.054);                     // preserved
  assert.equal(b.fg, 1.008);                     // updated
  assert.equal(b.abv, 6.1);
});

test('readings insert + dedupe via unique index', () => {
  const id = upsertBatch({ batch_no: 200, name: 'Test' });
  const n1 = insertReadings(id, [
    { t: 1000, temp_f: 68, gravity: 1.054, source: 'tilt_black' },
    { t: 2000, temp_f: 70, gravity: 1.050, source: 'tilt_black' },
  ]);
  assert.equal(n1, 2);
  // re-inserting the same points → 0 new (deduped), plus 1 genuinely new
  const n2 = insertReadings(id, [
    { t: 1000, temp_f: 68, gravity: 1.054, source: 'tilt_black' },   // dupe
    { t: 3000, temp_f: 72, gravity: 1.045, source: 'tilt_black' },   // new
  ]);
  assert.equal(n2, 1);
  const rows = getReadings(id);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].t, 1000);   // ordered by t
  assert.equal(rows[2].gravity, 1.045);
});

test('tastings + best-of rollup onto batch', () => {
  const id = upsertBatch({ batch_no: 300, name: 'Saison', yeast_name: 'Belle Saison' });
  addTasting(id, { tasted_at: 1000, age_days: 14, rating: 6.5, descriptor: 'green/hot', context: 'home' });
  addTasting(id, { tasted_at: 2000, age_days: 42, rating: 8.5, peaked: true, descriptor: 'peaked, dry', context: 'home' });
  addTasting(id, { tasted_at: 3000, age_days: 70, rating: 7.0, descriptor: 'fading' });
  const ts = getTastings(id);
  assert.equal(ts.length, 3);
  const b = getBatch(300);
  assert.equal(b.best_rating, 8.5);        // rolled up
  assert.equal(b.best_at_age_days, 42);    // the peaked one
});

test('listBatches returns rows, newest-ish first', () => {
  const rows = listBatches(10);
  assert.ok(rows.length >= 3);
  assert.ok(rows.every((r) => r.batch_no != null));
});

test('the payoff query shape works (process→outcome correlation)', () => {
  // give #300 a peak temp + conditioning to prove the correlation query runs
  upsertBatch({ batch_no: 300, peak_temp_f: 87, days_conditioned: 42 });
  const rows = db().prepare(`
    SELECT b.batch_no, b.peak_temp_f, MAX(t.rating) AS best
    FROM batches b JOIN tastings t ON t.batch_id=b.id
    WHERE b.yeast_name='Belle Saison'
    GROUP BY b.id ORDER BY best DESC
  `).all();
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].peak_temp_f, 87);
  assert.equal(rows[0].best, 8.5);
});
