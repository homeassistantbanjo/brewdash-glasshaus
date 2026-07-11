import { test } from 'node:test';
import assert from 'node:assert';
import { isDiastaticYeast, parsePlanJson, DIASTATIC_RE } from './planlogic.mjs';

// ── isDiastaticYeast: name/product heuristic (the OFFLINE fallback; the live path
//    uses Claude's strain profile). It must catch the common STA1+ strains and NOT
//    over-match a plain Trappist/Belgian ale. ─────────────────────────────────────
test('flags French/Belgian saison strains', () => {
  assert.equal(isDiastaticYeast({ name: 'French Saison', productId: 'WLP590' }), true);
  assert.equal(isDiastaticYeast({ name: 'Belgian Saison', productId: 'WLP565' }), true);
  assert.equal(isDiastaticYeast({ name: 'Saison Blend' }), true);
});
test('flags Belle Saison + Wyeast saison product IDs', () => {
  assert.equal(isDiastaticYeast({ name: 'Belle Saison' }), true);
  assert.equal(isDiastaticYeast({ name: 'Farmhouse Ale', productId: '3711' }), true);
});
test('flags Brett', () => {
  assert.equal(isDiastaticYeast({ name: 'Brettanomyces Bruxellensis' }), true);
  assert.equal(isDiastaticYeast({ name: 'Brett B' }), true);
});
test('does NOT over-match clean/abbey ale strains', () => {
  assert.equal(isDiastaticYeast({ name: 'Safale US-05', productId: 'US-05' }), false);
  assert.equal(isDiastaticYeast({ name: 'Belgian Abbey Ale', productId: 'WLP530' }), false);
  assert.equal(isDiastaticYeast({ name: 'California Ale' }), false);
});
test('handles missing fields', () => {
  assert.equal(isDiastaticYeast({}), false);
  assert.equal(isDiastaticYeast(null), false);
});

// ── parsePlanJson: tolerant extraction from LLM output ──────────────────────────
test('parses clean JSON', () => {
  assert.deepEqual(parsePlanJson('{"a":1}'), { a: 1 });
});
test('strips ```json fences', () => {
  assert.deepEqual(parsePlanJson('```json\n{"a":1}\n```'), { a: 1 });
});
test('extracts JSON from surrounding prose', () => {
  const r = parsePlanJson('Here is your plan:\n{"phases":[{"name":"Cool"}]}\nHope that helps!');
  assert.equal(r.phases[0].name, 'Cool');
});
test('handles braces inside string values (why text)', () => {
  const r = parsePlanJson('{"why":"warm to {finish} dry","tempF":85}');
  assert.equal(r.tempF, 85);
  assert.equal(r.why, 'warm to {finish} dry');
});
test('handles escaped quotes in strings', () => {
  const r = parsePlanJson('{"note":"call it \\"terminal\\" carefully"}');
  assert.equal(r.note, 'call it "terminal" carefully');
});
test('returns null on genuinely unparseable input', () => {
  assert.equal(parsePlanJson('no json here at all'), null);
  assert.equal(parsePlanJson(''), null);
  assert.equal(parsePlanJson('{ broken '), null);
});

console.log('planlogic tests defined');
