import { computeDerived } from './derived.mjs';
let pass=0, fail=0;
const ok=(nm,c)=>{ if(c)pass++; else{fail++;console.log('  ✗ FAIL:',nm);} };
const NOW = Date.UTC(2026,6,8,4,0,0); // fixed clock

// Tank 1-like: mid-ferment lager, Black data
let r = computeDerived({ gravity:1.020, og:1.050, expectedFg:1.010, beerTempF:66, probeTempF:66,
  setpointF:66, gravity24hDeltaPts:-8, gravity8hMaxSg:1.025, gravityAgeMin:0 }, NOW);
ok('attenuation (OG1.050 SG1.020) = 60%', r.attenuationPct===60);
ok('progressToFg = 75%', r.progressToFgPct===75);
ok('drop from peak 1.025→1.020 = 5pts, active', r.dropFromPeakPts===5 && r.activelyFermenting===true);
ok('fermentation latched from active', r.fermentationStarted===true);
ok('no alerts mid-ferment on-profile', r.alerts.length===0);

// terminal + near FG → approaching-terminal milestone, projected reached-ish
r = computeDerived({ gravity:1.011, og:1.050, expectedFg:1.010, beerTempF:67, probeTempF:67,
  setpointF:67, gravity24hDeltaPts:-0.3, gravity8hMaxSg:1.012, gravityAgeMin:2 }, NOW);
ok('near-terminal milestone fires', r.alerts.some(a=>a.key==='approaching_terminal'&&a.severity==='milestone'));
ok('no problem alert at terminal', !r.alerts.some(a=>a.severity==='problem'));

// STALL: flat + well above FG
r = computeDerived({ gravity:1.030, og:1.058, expectedFg:1.010, beerTempF:66, probeTempF:66,
  setpointF:66, gravity24hDeltaPts:-0.4, gravity8hMaxSg:1.031, gravityAgeMin:1 }, NOW);
ok('stall fires (flat + above FG)', r.alerts.some(a=>a.key==='stalled'&&a.severity==='problem'));

// TEMP EXCURSION: probe 12F off setpoint
r = computeDerived({ gravity:1.040, og:1.070, expectedFg:1.014, beerTempF:78, probeTempF:78,
  setpointF:66, gravity24hDeltaPts:-18, gravity8hMaxSg:1.045, gravityAgeMin:0 }, NOW);
ok('temp excursion fires', r.alerts.some(a=>a.key==='temp_excursion'));

// ASSIGNMENT SUSPECT: tilt vs probe 6F apart
r = computeDerived({ gravity:1.020, og:1.050, expectedFg:1.010, beerTempF:72, probeTempF:66,
  setpointF:66, gravity24hDeltaPts:-6, gravity8hMaxSg:1.023, gravityAgeMin:0 }, NOW);
ok('assignment suspect fires (>5F delta)', r.alerts.some(a=>a.key==='assignment_suspect'));
ok('tilt-probe delta = +6.0', r.tiltProbeDeltaF===6);

// SIGNAL LOST: gravity age 20 min
r = computeDerived({ gravity:1.028, og:1.062, expectedFg:1.016, beerTempF:68, probeTempF:68,
  setpointF:68, gravity24hDeltaPts:0, gravity8hMaxSg:1.030, gravityAgeMin:20 }, NOW);
ok('signal lost warning fires', r.alerts.some(a=>a.key==='signal_lost'&&a.severity==='warning'));

// TANK 3 NO TILT: gravity/og null → all gravity-derived null, NO crash, no false alerts
r = computeDerived({ gravity:null, og:null, expectedFg:1.010, beerTempF:null, probeTempF:65,
  setpointF:65, gravity24hDeltaPts:null, gravity8hMaxSg:null, gravityAgeMin:null }, NOW);
ok('no-Tilt tank: attenuation null', r.attenuationPct===null);
ok('no-Tilt tank: not active/latched', r.activelyFermenting===false && r.fermentationStarted===false);
ok('no-Tilt tank: no false alerts', r.alerts.length===0);

// BORROWED TILT (Tank 3 real case): another tank's Tilt gravity is visible + near
// FG, but NO batch assigned here (og null) → gravity-based alerts must be SILENT.
r = computeDerived({ gravity:1.011, og:null, expectedFg:1.010, beerTempF:66, probeTempF:66,
  setpointF:66, gravity24hDeltaPts:-0.2, gravity8hMaxSg:1.012, gravityAgeMin:1 }, NOW);
ok('borrowed-tilt: no near-terminal without a batch', !r.alerts.some(a=>a.key==='approaching_terminal'));
ok('borrowed-tilt: no stall without a batch', !r.alerts.some(a=>a.key==='stalled'));
ok('borrowed-tilt: attenuation null (no og)', r.attenuationPct===null);
// but a temp excursion on a batchless tank STILL fires (controller safety, not gravity)
r = computeDerived({ gravity:null, og:null, expectedFg:1.010, beerTempF:null, probeTempF:75,
  setpointF:66, gravity24hDeltaPts:null, gravity8hMaxSg:null, gravityAgeMin:null }, NOW);
ok('batchless tank still reports temp excursion', r.alerts.some(a=>a.key==='temp_excursion'));

// STABILITY: flat + near FG, stable for 4 days → terminalConfirmed (3d bar)
r = computeDerived({ gravity:1.011, og:1.050, expectedFg:1.010, beerTempF:67, probeTempF:67,
  setpointF:67, gravity24hDeltaPts:-0.3, gravity8hMaxSg:1.012, gravityAgeMin:1,
  stableSinceMs: NOW - 4*86400000 }, NOW);
ok('isStableNow (flat + near FG)', r.isStableNow===true);
ok('stableDays ≈ 4', r.stableDays===4);
ok('terminalConfirmed at 4d (≥3d bar)', r.terminalConfirmed===true);
ok('terminal-confirmed milestone fires', r.alerts.some(a=>a.key==='terminal_confirmed'));

// stable only 1 day → NOT confirmed yet (still near-terminal milestone)
r = computeDerived({ gravity:1.011, og:1.050, expectedFg:1.010, beerTempF:67, probeTempF:67,
  setpointF:67, gravity24hDeltaPts:-0.3, gravity8hMaxSg:1.012, gravityAgeMin:1,
  stableSinceMs: NOW - 1*86400000 }, NOW);
ok('stableDays ≈ 1', r.stableDays===1);
ok('NOT terminalConfirmed at 1d', r.terminalConfirmed===false);
ok('falls back to near-terminal milestone', r.alerts.some(a=>a.key==='approaching_terminal'));

// dry-hopped needs 6d: 4 days stable → NOT confirmed
r = computeDerived({ gravity:1.011, og:1.050, expectedFg:1.010, beerTempF:67, probeTempF:67,
  setpointF:67, gravity24hDeltaPts:-0.3, gravity8hMaxSg:1.012, gravityAgeMin:1,
  stableSinceMs: NOW - 4*86400000, dryHopped:true }, NOW);
ok('dry-hopped: 4d NOT enough (needs 6)', r.terminalConfirmed===false && r.requiredStableDays===6);

// CONDITIONING countdown: terminal confirmed 3d ago, 7d target → mid-conditioning.
// stableSince 5d ago: ferment finished at stableSince+3d (2d ago) → 2d conditioned.
r = computeDerived({ gravity:1.011, og:1.050, expectedFg:1.010, beerTempF:67, probeTempF:67,
  setpointF:67, gravity24hDeltaPts:-0.3, gravity8hMaxSg:1.012, gravityAgeMin:1,
  stableSinceMs: NOW - 5*86400000, conditionDays:7 }, NOW);
ok('conditioning: ~2d elapsed', Math.round(r.conditioningDaysElapsed)===2);
ok('conditioning: NOT ready to keg (2/7d)', r.readyToKeg===false);
ok('conditioning: no ready-to-keg alert yet', !r.alerts.some(a=>a.key==='ready_to_keg'));

// conditioning DONE: stableSince 12d ago, target 7 → ferment ended 9d ago ≥ 7 → ready
r = computeDerived({ gravity:1.011, og:1.050, expectedFg:1.010, beerTempF:67, probeTempF:67,
  setpointF:67, gravity24hDeltaPts:-0.3, gravity8hMaxSg:1.012, gravityAgeMin:1,
  stableSinceMs: NOW - 12*86400000, conditionDays:7 }, NOW);
ok('conditioning done → readyToKeg', r.readyToKeg===true);
ok('ready-to-keg milestone fires', r.alerts.some(a=>a.key==='ready_to_keg'));

// no conditionDays target → never readyToKeg (degrades safely)
r = computeDerived({ gravity:1.011, og:1.050, expectedFg:1.010, beerTempF:67, probeTempF:67,
  setpointF:67, gravity24hDeltaPts:-0.3, gravity8hMaxSg:1.012, gravityAgeMin:1,
  stableSinceMs: NOW - 30*86400000, conditionDays:null }, NOW);
ok('no target → not readyToKeg', r.readyToKeg===false && r.conditionDays===null);

// still dropping → not stable at all
r = computeDerived({ gravity:1.020, og:1.050, expectedFg:1.010, beerTempF:66, probeTempF:66,
  setpointF:66, gravity24hDeltaPts:-8, gravity8hMaxSg:1.025, gravityAgeMin:0, stableSinceMs:null }, NOW);
ok('not stable while attenuating', r.isStableNow===false && r.stableDays===null);

// pace: 75% to FG at day 3 of a 7-day plan → ahead of schedule (positive)
r = computeDerived({ gravity:1.020, og:1.050, expectedFg:1.010, beerTempF:66, probeTempF:66,
  setpointF:66, gravity24hDeltaPts:-8, gravity8hMaxSg:1.025, gravityAgeMin:0,
  daysFermenting:3, plannedFermentDays:7 }, NOW);
ok('pace computed (ahead → positive)', r.paceVsSchedule !== null && r.paceVsSchedule > 0);
ok('pace null without daysFermenting', computeDerived({ gravity:1.02, og:1.05, expectedFg:1.01,
  gravity24hDeltaPts:-8, gravity8hMaxSg:1.025 }, NOW).paceVsSchedule === null);

// GRAVITY SUSPECT (Tilt fallen / in water / lifted out) — flag, don't fake.
// SG below water → suspect
r = computeDerived({ gravity:0.990, og:1.050, expectedFg:1.010, beerTempF:66, probeTempF:66,
  setpointF:66, gravity24hDeltaPts:0, gravity8hMaxSg:1.050, gravityAgeMin:0 }, NOW);
ok('SG 0.990 (below water) → gravitySuspect', r.gravitySuspect===true);
// attenuation > 100.5% (SG dropped below 1.000) → suspect
r = computeDerived({ gravity:0.998, og:1.050, expectedFg:1.010, beerTempF:66, probeTempF:66,
  setpointF:66, gravity24hDeltaPts:0, gravity8hMaxSg:1.050, gravityAgeMin:0 }, NOW);
ok('att >100.5% (SG<1.000) → gravitySuspect', r.gravitySuspect===true);
// genuine ~100% attenuation lager (SG exactly 1.000) → NOT suspect (tolerance)
r = computeDerived({ gravity:1.000, og:1.050, expectedFg:1.010, beerTempF:66, probeTempF:66,
  setpointF:66, gravity24hDeltaPts:-0.2, gravity8hMaxSg:1.001, gravityAgeMin:1 }, NOW);
ok('SG 1.000 (~100% att) → NOT suspect', r.gravitySuspect===false);
// normal mid-ferment → not suspect
r = computeDerived({ gravity:1.020, og:1.050, expectedFg:1.010, beerTempF:66, probeTempF:66,
  setpointF:66, gravity24hDeltaPts:-8, gravity8hMaxSg:1.025, gravityAgeMin:0 }, NOW);
ok('normal ferment → not suspect', r.gravitySuspect===false);
// no gravity (no Tilt) → not "suspect" (it's just missing)
r = computeDerived({ gravity:null, og:1.050, expectedFg:1.010, gravity24hDeltaPts:null,
  gravity8hMaxSg:null, gravityAgeMin:null }, NOW);
ok('null gravity → not suspect (missing, not wrong)', r.gravitySuspect===false);

// TEMP EXCURSION SUPPRESSION — the beer can't track a stepped setpoint instantly, so
// a divergence right after a setpoint change is convergence, not a fault.
// probe 12°F off setpoint but setpoint JUST changed (5 min ago) → NO excursion alert
r = computeDerived({ gravity:1.040, og:1.070, expectedFg:1.014, beerTempF:78, probeTempF:78,
  setpointF:66, gravity24hDeltaPts:-18, gravity8hMaxSg:1.045, gravityAgeMin:0,
  setpointChangedMinAgo:5 }, NOW);
ok('excursion SUPPRESSED within settle window (setpoint changed 5min ago)',
   !r.alerts.some(a=>a.key==='temp_excursion'));
// same divergence but setpoint changed 3h ago (past the 2h settle) → excursion FIRES
r = computeDerived({ gravity:1.040, og:1.070, expectedFg:1.014, beerTempF:78, probeTempF:78,
  setpointF:66, gravity24hDeltaPts:-18, gravity8hMaxSg:1.045, gravityAgeMin:0,
  setpointChangedMinAgo:180 }, NOW);
ok('excursion FIRES once settled (setpoint changed 3h ago)',
   r.alerts.some(a=>a.key==='temp_excursion'));
// no setpointChangedMinAgo provided → behaves as before (fires) — backward compatible
r = computeDerived({ gravity:1.040, og:1.070, expectedFg:1.014, beerTempF:78, probeTempF:78,
  setpointF:66, gravity24hDeltaPts:-18, gravity8hMaxSg:1.045, gravityAgeMin:0 }, NOW);
ok('excursion still fires when no setpoint-age given (back-compat)',
   r.alerts.some(a=>a.key==='temp_excursion'));

// CRASH SUPPRESSION — cold halts fermentation on purpose; flat+above-FG is expected.
// flat + well above FG (would normally STALL) but inCrash → NO stall, projected='crashing'
r = computeDerived({ gravity:1.030, og:1.058, expectedFg:1.010, beerTempF:40, probeTempF:40,
  setpointF:40, gravity24hDeltaPts:-0.4, gravity8hMaxSg:1.031, gravityAgeMin:1, inCrash:true }, NOW);
ok('stall SUPPRESSED during cold crash', !r.alerts.some(a=>a.key==='stalled'));
ok('projectedFgReach = "crashing" during crash (not "stalled")', r.projectedFgReach==='crashing');
// same flat+above-FG NOT in crash → stall still fires (unchanged)
r = computeDerived({ gravity:1.030, og:1.058, expectedFg:1.010, beerTempF:66, probeTempF:66,
  setpointF:66, gravity24hDeltaPts:-0.4, gravity8hMaxSg:1.031, gravityAgeMin:1 }, NOW);
ok('stall still fires when NOT crashing', r.alerts.some(a=>a.key==='stalled'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);

// ── updateStableClock: noise-tolerant 3-day-stable timer (the bug where a Tilt blip
//    kept zeroing the multi-day clock) ──
import { updateStableClock, STABLE_RESET_GRACE_MS } from './derived.mjs';
{
  const H = 3600_000, T0 = 1_000_000_000_000;
  test('stable clock: starts on first stable tick', () => {
    const r = updateStableClock(true, { stableSinceMs: null, unstableSinceMs: null }, T0);
    assert.equal(r.stableSinceMs, T0);
  });
  test('stable clock: keeps the SAME start across continued stability', () => {
    const r = updateStableClock(true, { stableSinceMs: T0, unstableSinceMs: null }, T0 + 48 * H);
    assert.equal(r.stableSinceMs, T0, 'clock not restarted while staying stable');
  });
  test('stable clock: a BLIP does NOT reset a running multi-day clock', () => {
    // 2.5 days into stability, one non-stable tick
    let st = { stableSinceMs: T0, unstableSinceMs: null };
    st = updateStableClock(false, st, T0 + 60 * H);       // blip at +60h
    assert.equal(st.stableSinceMs, T0, 'clock preserved through the blip');
    assert.ok(st.unstableSinceMs, 'unstable timer started');
    // stable again shortly after → clock intact, unstable timer cleared
    st = updateStableClock(true, st, T0 + 60 * H + 60_000);
    assert.equal(st.stableSinceMs, T0, 'clock still intact after brief blip recovered');
    assert.equal(st.unstableSinceMs, null);
  });
  test('stable clock: SUSTAINED instability past the grace window DOES reset', () => {
    let st = { stableSinceMs: T0, unstableSinceMs: null };
    st = updateStableClock(false, st, T0 + 60 * H);                         // goes unstable
    st = updateStableClock(false, st, T0 + 60 * H + STABLE_RESET_GRACE_MS + 1); // still unstable past grace
    assert.equal(st.stableSinceMs, null, 'real sustained drop resets the clock');
  });
  test('stable clock: not-stable with no running clock is a no-op', () => {
    const r = updateStableClock(false, { stableSinceMs: null, unstableSinceMs: null }, T0);
    assert.equal(r.stableSinceMs, null);
  });
}
