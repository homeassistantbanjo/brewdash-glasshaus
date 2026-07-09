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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
