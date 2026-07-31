// TankState — pure per-tank control-state doc (serialize/hydrate/255-guard). No I/O.
// Persisted by the runner as JSON in input_text.tank_N_control_state (255-char cap).
// Short keys for headroom; see docs/superpowers/specs/2026-07-30-control-state-refactor-design.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultState, serialize, hydrate, seedFromHelpers } from './tankstate.mjs';

test('defaultState has all short keys + cc=-1 none', () => {
  const s = defaultState('148');
  assert.equal(s.b, '148');
  assert.equal(s.cc, -1);
  assert.equal(s.ad, false);
  assert.deepEqual(Object.keys(s).sort(), ['ad','b','cc','fl','lcp','off','pa','ss','u','us'].sort());
});

test('serialize→hydrate round-trips', () => {
  const s = defaultState('148');
  s.pa = 66; s.cc = 0; s.ad = true; s.ss = 1784476204000; s.fl = true; s.off = 4.3; s.lcp = 1784476200000; s.u = 1784476210000;
  const round = hydrate(serialize(s));
  assert.deepEqual(round, s);
});

test('serialize fits 255 for a normal doc', () => {
  const s = defaultState('148');
  s.pa = 66; s.ss = 1784476204000; s.lcp = 1784476200000; s.off = 4.3; s.u = 1784476210000;
  assert.ok(serialize(s).length <= 255);
});

test('serialize drops off when over 255, still valid', () => {
  const s = defaultState('a-very-long-batch-name-that-eats-headroom-0123456789');
  s.pa = 66.123; s.ss = 1784476204000; s.us = 1784476204999; s.lcp = 1784476200000; s.off = 4.36667; s.u = 1784476210000;
  // force overflow by padding the batch key
  s.b = 'x'.repeat(230);
  const out = serialize(s);
  assert.ok(out === null || out.length <= 255);
});

test('hydrate null/garbage → null', () => {
  assert.equal(hydrate(null), null);
  assert.equal(hydrate('unknown'), null);
  assert.equal(hydrate('{not json'), null);
});

test('seedFromHelpers carries live state across cutover', () => {
  const s = seedFromHelpers({
    batchKey: '148', phaseIndex: 0, stableSinceMs: 1784476204000,
    fermStarted: true, crashConfirmedPhase: 0, tempOffset: 4.3,
  });
  assert.equal(s.b, '148');
  assert.equal(s.fl, true);
  assert.equal(s.cc, 0);
  assert.equal(s.off, 4.3);
  assert.equal(s.ss, 1784476204000);
  assert.equal(s.ad, true);   // a tank already mid-ferment is treated as adopted (no re-jump)
});

test('seedFromHelpers with empty helpers → safe defaults', () => {
  const s = seedFromHelpers({ batchKey: 'none' });
  assert.equal(s.b, 'none');
  assert.equal(s.cc, -1);
  assert.equal(s.fl, false);
  assert.equal(s.ad, false);
});

test('seedFromHelpers: null/empty numeric helpers do NOT coerce to 0 (no phantom crash-confirm)', () => {
  // Number(null)===0 and Number('')===0 — a MISSING crash_confirmed_phase must seed cc=-1,
  // never cc=0 (which would auto-confirm a phase-0 cold crash on the live cutover). Same for
  // stableSince/tempOffset: absent → null, not 0.
  const s = seedFromHelpers({ batchKey: '148', crashConfirmedPhase: null, stableSinceMs: null, tempOffset: '' });
  assert.equal(s.cc, -1);
  assert.equal(s.ss, null);
  assert.equal(s.off, null);
});
