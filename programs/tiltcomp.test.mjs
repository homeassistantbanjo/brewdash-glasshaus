import { smoothOffset, slewLimit, worthWriting, clampRange, beerInBand } from './tiltcomp.mjs';
let pass = 0, fail = 0;
const ok = (nm, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', nm); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

// ── smoothOffset: EMA ──────────────────────────────────────────────
ok('first tick (no prev) seeds to raw', smoothOffset(4.0, null, 0.3) === 4.0);
ok('EMA blends: α0.3 of 6 onto prev 4 = 4.6', near(smoothOffset(6, 4, 0.3), 4.6));
ok('small α = heavy smoothing: α0.1 barely moves', near(smoothOffset(10, 4, 0.1), 4.6));
ok('α clamped ≥0.01 (0 would freeze)', smoothOffset(10, 4, 0) !== 4);   // clamps up, so it moves a hair
ok('a one-tick spike barely moves a smoothed offset', smoothOffset(20, 4, 0.3) < 9);  // 4.8+... not 20
ok('null raw keeps prev', smoothOffset(null, 4.2, 0.3) === 4.2);
ok('null raw + null prev = null', smoothOffset(null, null, 0.3) === null);
// repeated same raw converges toward it
let e = 4; for (let i = 0; i < 40; i++) e = smoothOffset(6, e, 0.3);
ok('repeated raw=6 converges to ~6', near(e, 6, 0.01));

// ── slewLimit: setpoint ramp ───────────────────────────────────────
ok('first write (no current) applies fully', slewLimit(70, null, 0.5) === 70);
ok('caps a big jump up to +0.5', slewLimit(70, 62, 0.5) === 62.5);
ok('caps a big drop to -0.5', slewLimit(50, 62, 0.5) === 61.5);
ok('small move passes through unchanged', slewLimit(62.3, 62, 0.5) === 62.3);
ok('exact-cap move passes', near(slewLimit(62.5, 62, 0.5), 62.5));
ok('null desired = null', slewLimit(null, 62, 0.5) === null);
// a stepped setpoint converges over several ticks, never overshoots
let sp = 62; for (let i = 0; i < 20; i++) sp = slewLimit(70, sp, 0.5);
ok('ramps 62→70 over ticks, no overshoot', sp === 70);

// ── worthWriting: deadband ─────────────────────────────────────────
ok('first write always worth it', worthWriting(62, null, 0.1) === true);
ok('sub-deadband change skipped', worthWriting(62.05, 62, 0.1) === false);
ok('at-deadband change written', worthWriting(62.1, 62, 0.1) === true);

// ── clampRange ─────────────────────────────────────────────────────
ok('clampRange lo', clampRange(-9, -7, 7) === -7);
ok('clampRange hi', clampRange(9, -7, 7) === 7);
ok('clampRange mid', clampRange(3, -7, 7) === 3);

// ── beerInBand: the anti-hunting deadband (freeze offset near target) ──
ok('beer exactly on target → in band', beerInBand(66, 66, 0.6) === true);
ok('beer +0.5 of target, band 0.6 → in band (freeze)', beerInBand(66.5, 66, 0.6) === true);
ok('beer +1.0 of target, band 0.6 → OUT of band (correct)', beerInBand(67, 66, 0.6) === false);
ok('beer -0.6 exactly at edge → in band', beerInBand(65.4, 66, 0.6) === true);
ok('null tilt → not in band (let normal logic run)', beerInBand(null, 66, 0.6) === false);
ok('null target → not in band', beerInBand(66, null, 0.6) === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
