import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { db, _resetForTest, createKeg, getKeg, listKegs, listIds, patchKeg, addEvent, kegEvents, deleteKeg,
  listTaps, getTap, ensureTaps, patchTap, addTapEvent, tapEventsFor } = await import('./db.mjs');

const NOW = '2026-07-14T00:00:00.000Z';
beforeEach(() => { _resetForTest(); db(); });   // fresh in-memory DB each test

test('createKeg inserts + logs a created event', () => {
  const k = createKeg({ id: 'keg-001', label: 'Keg 1', at: NOW });
  assert.equal(k.id, 'keg-001');
  assert.equal(k.status, 'dirty');
  assert.equal(k.size_l, 19);
  const ev = kegEvents('keg-001');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].action, 'created');
});

test('listKegs / listIds return the fleet sorted', () => {
  createKeg({ id: 'keg-002', at: NOW });
  createKeg({ id: 'keg-001', at: NOW });
  assert.deepEqual(listIds(), ['keg-001', 'keg-002']);
  assert.equal(listKegs().length, 2);
});

test('patchKeg merges known columns, ignores unknown, bumps updated_at', () => {
  createKeg({ id: 'keg-001', at: NOW });
  const later = '2026-07-15T00:00:00.000Z';
  const k = patchKeg('keg-001', { status: 'clean', cleaned_at: later, bogus_col: 'x' }, later);
  assert.equal(k.status, 'clean');
  assert.equal(k.cleaned_at, later);
  assert.equal(k.updated_at, later);
  assert.equal(k.bogus_col, undefined, 'unknown column not written');
});

test('addEvent + kegEvents preserve order (newest first) and parse detail JSON', () => {
  createKeg({ id: 'keg-001', at: NOW });
  addEvent('keg-001', { action: 'cleaned', at: '2026-07-14T01:00:00Z', detail: { cleanType: 'caustic' } });
  addEvent('keg-001', { action: 'filled', at: '2026-07-14T02:00:00Z', detail: { batch: 'IPA #9' } });
  const ev = kegEvents('keg-001');
  assert.equal(ev[0].action, 'filled', 'newest first');
  assert.equal(ev[0].detail.batch, 'IPA #9', 'detail parsed from JSON');
  assert.equal(ev.length, 3, 'created + cleaned + filled');   // includes the create event
});

test('deleteKeg cascades to its events', () => {
  createKeg({ id: 'keg-001', at: NOW });
  addEvent('keg-001', { action: 'note', at: NOW, detail: {} });
  deleteKeg('keg-001');
  assert.equal(getKeg('keg-001'), null);
  assert.equal(kegEvents('keg-001').length, 0, 'events cascade-deleted');
});

test('ensureTaps seeds 1..8 idempotently', () => {
  ensureTaps(8, NOW);
  ensureTaps(8, NOW);                       // second call is a no-op (INSERT OR IGNORE)
  const taps = listTaps();
  assert.equal(taps.length, 8);
  assert.equal(taps[0].tap, 1);
  assert.equal(taps[7].tap, 8);
  assert.equal(taps[0].clean_life, 14);
});

test('patchTap updates line clean + current keg; tap events log', () => {
  ensureTaps(8, NOW);
  const later = '2026-07-20T00:00:00.000Z';
  const t = patchTap(3, { cleaned_at: later, current_keg: 'keg-002' }, later);
  assert.equal(t.cleaned_at, later);
  assert.equal(t.current_keg, 'keg-002');
  addTapEvent(3, { action: 'line-cleaned', at: later, detail: {} });
  assert.equal(tapEventsFor(3)[0].action, 'line-cleaned');
});

test('seal lifespans default correctly on create', () => {
  const k = createKeg({ id: 'keg-001', at: NOW });
  assert.equal(k.lid_seal_life, 730);
  assert.equal(k.post_seal_life, 365);
  assert.equal(k.dip_seal_life, 365);
  assert.equal(k.clean_life, 30);
});
