import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition, applyTransition, replaceSeal, kegHealth, nextKegId, haMirror,
  STATUSES, SEAL_TYPES, tapHealth, tapOnto, cleanTapLine, tapMirror, TAP_COUNT,
  suggestKegCount, kegBatch,
} from './kegs.mjs';
import { kegUrl } from './qr.mjs';

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
// a minimal keg fixture at a fixed "now"
const NOW = 1_800_000_000_000;
function keg(overrides = {}) {
  return { id: 'keg-001', label: 'Keg 1', status: 'dirty', tap: null,
    beer_batch: null, beer_style: null, beer_abv: null, filled_at: null,
    lid_seal_at: null, lid_seal_life: 730, post_seal_at: null, post_seal_life: 365,
    dip_seal_at: null, dip_seal_life: 365, cleaned_at: null, clean_type: null, clean_life: 30,
    ...overrides };
}

test('valid transitions follow the lifecycle', () => {
  assert.equal(canTransition('dirty', 'clean').ok, true);
  assert.equal(canTransition('clean', 'filled').ok, true);
  assert.equal(canTransition('filled', 'tapped').ok, true);
  assert.equal(canTransition('tapped', 'empty').ok, true);
  assert.equal(canTransition('empty', 'dirty').ok, true);
});

test('invalid transitions are rejected with a reason', () => {
  assert.equal(canTransition('dirty', 'tapped').ok, false);       // can't tap a dirty keg
  assert.equal(canTransition('clean', 'tapped').ok, false);       // must fill first
  assert.equal(canTransition('clean', 'clean').ok, false);        // no-op
  assert.equal(canTransition('anything', 'bogus').ok, false);     // unknown status
});

test('retire is allowed from anywhere and is terminal', () => {
  for (const s of STATUSES.filter((s) => s !== 'retired')) assert.equal(canTransition(s, 'retired').ok, true);
  assert.equal(canTransition('retired', 'clean').ok, false, 'retired is terminal until unretire');
});

test('applyTransition to tapped records the tap number + logs event', () => {
  const { patch, event } = applyTransition(keg({ status: 'filled', beer_batch: 'Hazy #42' }), 'tapped', { at: iso(NOW), tap: 2 });
  assert.equal(patch.status, 'tapped');
  assert.equal(patch.tap, 2);
  assert.equal(event.action, 'tapped');
  assert.equal(event.detail.tap, 2);
});

test('applyTransition to filled sets beer + clears tap; to dirty clears contents', () => {
  const filled = applyTransition(keg({ status: 'clean' }), 'filled', { at: iso(NOW), beer: { batch: 'Saison #7', style: 'Saison', abv: 6.1 } });
  assert.equal(filled.patch.beer_batch, 'Saison #7');
  assert.equal(filled.patch.beer_abv, 6.1);
  assert.equal(filled.patch.tap, null);

  const dirty = applyTransition(keg({ status: 'empty', beer_batch: 'Saison #7' }), 'dirty', { at: iso(NOW) });
  assert.equal(dirty.patch.beer_batch, null, 'contents cleared when dumped to dirty');
  assert.equal(dirty.patch.filled_at, null);
});

test('applyTransition on illegal move throws', () => {
  assert.throws(() => applyTransition(keg({ status: 'dirty' }), 'tapped', { at: iso(NOW) }), /cannot go dirty → tapped/);
});

test('replaceSeal updates only the chosen seal type', () => {
  const { patch, event } = replaceSeal(keg(), 'lid', { at: iso(NOW) });
  assert.equal(patch.lid_seal_at, iso(NOW));
  assert.equal(patch.post_seal_at, undefined, 'post seal untouched');
  assert.equal(event.detail.sealType, 'lid');
  assert.throws(() => replaceSeal(keg(), 'bogus', { at: iso(NOW) }), /unknown seal type/);
});

test('kegHealth: seal age + due flags computed from replace dates', () => {
  const k = keg({
    lid_seal_at: iso(NOW - 800 * DAY),   // 800d old, life 730 → DUE
    post_seal_at: iso(NOW - 100 * DAY),  // 100d old, life 365 → ok
    dip_seal_at: iso(NOW - 340 * DAY),   // 340d, life 365 → SOON (within 10%)
  });
  const h = kegHealth(k, NOW);
  assert.equal(h.seals.lid.ageDays, 800);
  assert.equal(h.seals.lid.due, true);
  assert.equal(h.seals.post.due, false);
  assert.equal(h.seals.dip.due, false);
  assert.equal(h.seals.dip.soon, true, 'within 10% of life → soon');
  assert.equal(h.anySealDue, true);
  assert.equal(h.severity, 'warning');
});

test('kegHealth: clean expiry only applies while clean/filled', () => {
  const old = iso(NOW - 45 * DAY);   // 45d since clean, life 30
  assert.equal(kegHealth(keg({ status: 'clean', cleaned_at: old }), NOW).cleanExpired, true);
  assert.equal(kegHealth(keg({ status: 'filled', cleaned_at: old }), NOW).cleanExpired, true);
  // a dirty or tapped keg's clean-age isn't actionable → not "expired"
  assert.equal(kegHealth(keg({ status: 'dirty', cleaned_at: old }), NOW).cleanExpired, false);
  assert.equal(kegHealth(keg({ status: 'tapped', cleaned_at: old }), NOW).cleanExpired, false);
});

test('kegHealth: fresh keg → ok, no warnings', () => {
  const h = kegHealth(keg({ status: 'clean', cleaned_at: iso(NOW - 2 * DAY),
    lid_seal_at: iso(NOW - 10 * DAY), post_seal_at: iso(NOW - 10 * DAY), dip_seal_at: iso(NOW - 10 * DAY) }), NOW);
  assert.equal(h.severity, 'ok');
  assert.equal(h.warnings.length, 0);
});

test('kegUrl builds the tailnet sticker URL', () => {
  assert.equal(kegUrl('https://unraid.tail229434.ts.net', 'keg-007'), 'https://unraid.tail229434.ts.net/kegs/keg-007');
  assert.equal(kegUrl('https://x/', 'keg-1'), 'https://x/kegs/keg-1', 'trailing slash trimmed');
});

test('nextKegId is sequential + zero-padded, tolerant of gaps', () => {
  assert.equal(nextKegId([]), 'keg-001');
  assert.equal(nextKegId(['keg-001', 'keg-002', 'keg-010']), 'keg-011');
  assert.equal(nextKegId(['keg-003', 'keg-001']), 'keg-004', 'uses max, not count');
});

test('tapHealth: line-clean age + due flag', () => {
  const now = NOW;
  assert.equal(tapHealth({ cleaned_at: iso(now - 20 * DAY), clean_life: 14 }, now).due, true, '20d > 14d → due');
  assert.equal(tapHealth({ cleaned_at: iso(now - 5 * DAY), clean_life: 14 }, now).due, false);
  assert.equal(tapHealth({ cleaned_at: iso(now - 13 * DAY), clean_life: 14 }, now).soon, true, 'within 85% → soon');
  assert.equal(tapHealth({ cleaned_at: null }, now).cleanAgeDays, null, 'never-cleaned → null age');
});

test('tapOnto warns when the line is overdue but still allows the tap', () => {
  const k = keg({ id: 'keg-003', status: 'filled', beer_batch: 'Stout #5' });
  const dirtyLine = { tap: 3, cleaned_at: iso(NOW - 18 * DAY), clean_life: 14 };
  const r = tapOnto(k, 3, dirtyLine, { at: iso(NOW) });
  assert.match(r.warn, /Tap 3 line cleaned 18d ago/);
  assert.equal(r.tapPatch.current_keg, 'keg-003');
  assert.equal(r.tapEvent.action, 'keg-connected');
  assert.equal(r.tapEvent.detail.keg, 'keg-003');

  const cleanLine = { tap: 3, cleaned_at: iso(NOW - 2 * DAY), clean_life: 14 };
  assert.equal(tapOnto(k, 3, cleanLine, { at: iso(NOW) }).warn, null, 'fresh line → no warning');
});

test('cleanTapLine records the clean date + event', () => {
  const { patch, event } = cleanTapLine({ tap: 1 }, { at: iso(NOW) });
  assert.equal(patch.cleaned_at, iso(NOW));
  assert.equal(event.action, 'line-cleaned');
});

test('tapMirror emits line age + due sensors', () => {
  const m = tapMirror({ tap: 5, cleaned_at: iso(NOW - 20 * DAY), clean_life: 14, current_keg: 'keg-002' }, NOW);
  const byId = Object.fromEntries(m.map((s) => [s.entityId, s]));
  assert.equal(byId['sensor.tap_5_line_due'].state, 'on');
  assert.equal(byId['sensor.tap_5_line_clean_age_days'].attrs.current_keg, 'keg-002');
});

test('TAP_COUNT is 8', () => assert.equal(TAP_COUNT, 8));

test('suggestKegCount uses floor (kegs it can FILL, not round) — real-world cases', () => {
  assert.equal(suggestKegCount(5), 1, '5gal → 1 keg');
  assert.equal(suggestKegCount(10), 2, '10gal → 2 kegs');
  assert.equal(suggestKegCount(13.5), 2, '13.5gal → 2 (remainder is leftover, not a 3rd keg)');
  assert.equal(suggestKegCount(7), 1, '7gal → 1 (not 2)');
  assert.equal(suggestKegCount(8), 1, '8gal → 1 (not 2)');
  assert.equal(suggestKegCount(0), 1, 'unknown volume → at least 1');
  assert.equal(suggestKegCount(2.5), 1, 'small batch → 1');
});

test('kegBatch fills a clean keg from a tank batch, links source', () => {
  const clean = keg({ id: 'keg-004', status: 'clean' });
  const { patch, event } = kegBatch(clean, { name: 'Hazy IPA #42', style: 'NEIPA', abv: 6.8 },
    { at: iso(NOW), sourceTank: 'tank_2' });
  assert.equal(patch.status, 'filled');
  assert.equal(patch.beer_batch, 'Hazy IPA #42');
  assert.equal(patch.beer_abv, 6.8);
  assert.equal(event.action, 'filled');
  assert.equal(event.detail.sourceTank, 'tank_2');
  assert.equal(event.detail.batch, 'Hazy IPA #42');
});

test('kegBatch refuses a keg that is not clean', () => {
  assert.throws(() => kegBatch(keg({ status: 'dirty' }), { name: 'X' }, { at: iso(NOW) }), /can't keg into/);
  assert.throws(() => kegBatch(keg({ status: 'tapped' }), { name: 'X' }, { at: iso(NOW) }), /can't keg into/);
});

test('haMirror emits status/seal/clean sensors with a valid entity id', () => {
  const m = haMirror(keg({ id: 'keg-007', status: 'tapped', tap: 1, beer_batch: 'IPA #9',
    lid_seal_at: iso(NOW - 800 * DAY), lid_seal_life: 730 }), NOW);
  const byId = Object.fromEntries(m.map((s) => [s.entityId, s]));
  assert.equal(byId['sensor.keg_keg_007_status'].state, 'tapped');
  assert.equal(byId['sensor.keg_keg_007_status'].attrs.beer, 'IPA #9');
  assert.equal(byId['sensor.keg_keg_007_seal_due'].state, 'on', 'lid overdue → seal_due on');
});
