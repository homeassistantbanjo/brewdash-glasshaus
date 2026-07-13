import { PRESETS } from './presets.mjs';
import { tick, resolveStartPhase, _internals } from './statemachine.mjs';
let pass=0, fail=0;
const ok=(n,c)=>{ if(c)pass++; else {fail++;console.log('  ✗ FAIL:',n);} };

ok('kveik allows 90F', _internals.clampTemp(90, PRESETS.kveik.clamp)===90);
ok('ale caps 90F→72', _internals.clampTemp(90, PRESETS.ale.clamp)===72);
ok('lager NEVER exceeds 70F', _internals.clampTemp(75, PRESETS.lager_modern.clamp)===70 && _internals.clampTemp(75, PRESETS.lager_fast.clamp)===70);
ok('clamp floor 32', _internals.clampTemp(20, PRESETS.ale.clamp)===32);
ok('custom hard ceiling 100', _internals.clampTemp(120, {minF:32,maxF:150})===100);
ok('rate limit +12→+5', _internals.rateLimit(78,66)===71);
ok('rate limit small ok', _internals.rateLimit(68,66)===68);
ok('rate limit down cap', _internals.rateLimit(50,66)===61);

const lm=PRESETS.lager_modern;
let r=tick(lm,{phaseIndex:0,phaseElapsedHours:20,currentSetpointF:64,apparentAttenuationPct:40,gravity:1.030,expectedFg:1.010,gravity24hDeltaPts:-8});
// --- attenuationOfExpected (strain-relative advance for Claude-generated plans) ---
const cm = _internals.conditionMet;
// US-05 expected 81%; "advance at 80% of expected" = 64.8% absolute AA
ok('attnOfExpected: 60% AA of exp81 → not yet (needs 64.8)',
   cm({type:'attenuationOfExpected',pct:80},{apparentAttenuationPct:60,expectedAttenuationPct:81})===false);
ok('attnOfExpected: 66% AA of exp81 → advance (past 64.8)',
   cm({type:'attenuationOfExpected',pct:80},{apparentAttenuationPct:66,expectedAttenuationPct:81})===true);
// low-attenuating strain (say 68%): 80% of 68 = 54.4 — SAME pct, different absolute (the point)
ok('attnOfExpected self-adjusts: 55% AA of exp68 → advance',
   cm({type:'attenuationOfExpected',pct:80},{apparentAttenuationPct:55,expectedAttenuationPct:68})===true);
ok('attnOfExpected: null expected → treat pct as absolute (55<80 no)',
   cm({type:'attenuationOfExpected',pct:80},{apparentAttenuationPct:55,expectedAttenuationPct:null})===false);
ok('attnOfExpected: null AA → false', cm({type:'attenuationOfExpected',pct:80},{apparentAttenuationPct:null,expectedAttenuationPct:81})===false);

// --- COMPOUND advance conditions (all/any) — strain-specific hold logic ---
// AND: both sub-conditions must be true
const ANDcond = {all:[{type:'elapsed',hours:18},{type:'attenuation',pct:20}]};
ok('AND: time met but atten not → false',
   cm(ANDcond,{phaseElapsedHours:20,apparentAttenuationPct:10})===false);
ok('AND: atten met but time not → false',
   cm(ANDcond,{phaseElapsedHours:10,apparentAttenuationPct:30})===false);
ok('AND: both met → true',
   cm(ANDcond,{phaseElapsedHours:20,apparentAttenuationPct:30})===true);
// OR: either triggers (timeout-safety pattern)
const ORcond = {any:[{type:'elapsed',hours:36},{type:'attenuation',pct:75}]};
ok('OR: neither met → false',
   cm(ORcond,{phaseElapsedHours:10,apparentAttenuationPct:40})===false);
ok('OR: only time met → true (timeout fired)',
   cm(ORcond,{phaseElapsedHours:40,apparentAttenuationPct:40})===true);
ok('OR: only atten met → true (advanced early)',
   cm(ORcond,{phaseElapsedHours:10,apparentAttenuationPct:80})===true);
// Belle Saison step 1 EXACT: hold @68 until fermentation active AND ≥18h floor.
// "time floor + gravity is the real trigger" — active detects the ferment start.
const belle1 = {all:[{type:'elapsed',hours:18},{type:'active'}]};
ok('BelleSaison hold: 20h but not active yet → hold',
   cm(belle1,{phaseElapsedHours:20,gravity24hDeltaPts:0,og:1.060,gravity:1.059})===false);
ok('BelleSaison hold: active but only 6h (floor not met) → hold',
   cm(belle1,{phaseElapsedHours:6,gravity24hDeltaPts:-8,og:1.060,gravity:1.050})===false);
ok('BelleSaison hold: 20h AND active → advance to free-rise',
   cm(belle1,{phaseElapsedHours:20,gravity24hDeltaPts:-8,og:1.060,gravity:1.050})===true);
// nesting: any[ elapsed, all[atten, progress] ]
const nested = {any:[{type:'elapsed',hours:48},{all:[{type:'attenuation',pct:70},{type:'progressToFg',pct:90}]}]};
ok('nested any/all: inner AND satisfied → true',
   cm(nested,{phaseElapsedHours:5,apparentAttenuationPct:72,progressToFgPct:95})===true);
ok('nested any/all: inner AND partial, time not up → false',
   cm(nested,{phaseElapsedHours:5,apparentAttenuationPct:72,progressToFgPct:50})===false);
// backward-compat: a plain single condition still works untouched
ok('single condition unaffected by compound branch',
   cm({type:'attenuation',pct:50},{apparentAttenuationPct:60})===true);

ok('lager hold 64 while <50% atten', r.setpointF===64 && r.advanceTo===null);
r=tick(lm,{phaseIndex:0,phaseElapsedHours:20,currentSetpointF:64,apparentAttenuationPct:52,gravity:1.028,expectedFg:1.010,gravity24hDeltaPts:-8});
ok('lager advances at 50% atten', r.advanceTo===1);
r=tick(lm,{phaseIndex:1,phaseElapsedHours:0,phaseStartSetpointF:64,currentSetpointF:64,apparentAttenuationPct:55,gravity:1.025,expectedFg:1.010,gravity24hDeltaPts:-6});
ok('ramp first step to 69 (5F ok)', r.setpointF===69);

// "Cold crash only" is a MANUAL selection = the decision to crash → NO confirm gate,
// starts ramping down immediately from the current setpoint. (The confirm gate applies
// only to a coldCrash the MACHINE auto-reaches inside a multi-phase generated plan.)
const cc=PRESETS.coldcrash;
r=tick(cc,{phaseIndex:0,phaseElapsedHours:0,phaseStartSetpointF:66,currentSetpointF:66,confirmPressed:false});
ok('cold-crash-only NOT gated (manual = confirmed)', r.awaitingConfirm!==true);
ok('cold-crash-only steps DOWN immediately at t=0', r.setpointF<66);
// REGRESSION: a STALE HIGH anchor must NOT make a crash step UP (the 65→70 bug). Even
// if phaseStartSetpointF leaked in as 75, a crash from a 65°F beer goes DOWN, never up.
r=tick(cc,{phaseIndex:0,phaseElapsedHours:0.1,phaseStartSetpointF:75,currentSetpointF:65,confirmPressed:false});
ok('crash with stale-high anchor still steps DOWN (never warms)', r.setpointF<=65);
ok('crash never commands above current setpoint', r.setpointF<=65);
// a GENERATED/custom coldCrash phase (requiresConfirm:true) STILL gates
const genCrash={label:'g',clamp:{minF:32,maxF:88},phases:[{name:'crash',kind:'coldCrash',targetF:38,stepF:2,everyHours:6,requiresConfirm:true,advance:{type:'confirm'}}]};
r=tick(genCrash,{phaseIndex:0,phaseElapsedHours:0,currentSetpointF:70,confirmPressed:false});
ok('generated coldCrash STILL gated', r.awaitingConfirm===true);
r=tick(genCrash,{phaseIndex:0,phaseElapsedHours:0,phaseStartSetpointF:70,currentSetpointF:70,confirmPressed:true});
ok('generated coldCrash runs after confirm', r.awaitingConfirm!==true && r.setpointF<70);

r=tick(lm,{phaseIndex:0,phaseElapsedHours:20,currentSetpointF:64,apparentAttenuationPct:52,gravityStale:true,gravity:1.028,expectedFg:1.010,gravity24hDeltaPts:-8});
ok('stale gravity pauses advance', r.paused===true && r.advanceTo===null && r.setpointF===64);

r=tick(lm,{phaseIndex:1,phaseElapsedHours:15,phaseStartSetpointF:69,currentSetpointF:69,gravity:1.011,expectedFg:1.010,gravity24hDeltaPts:-0.3,apparentAttenuationPct:78});
ok('terminal met', r.advanceTo===2);
r=tick(lm,{phaseIndex:1,phaseElapsedHours:15,phaseStartSetpointF:69,currentSetpointF:69,gravity:1.020,expectedFg:1.010,gravity24hDeltaPts:-0.3,apparentAttenuationPct:70});
ok('terminal NOT met above FG', r.advanceTo===null);

// --- adoption: starting a program mid-ferment jumps to the right phase ---
ok('adopt fresh pitch → phase 0', resolveStartPhase(lm,{apparentAttenuationPct:2,gravity:1.049,expectedFg:1.010,gravity24hDeltaPts:-1})===0);
ok('adopt 60% atten → ramp phase 1', resolveStartPhase(lm,{apparentAttenuationPct:60,gravity:1.020,expectedFg:1.010,gravity24hDeltaPts:-6})===1);
ok('adopt terminal → cleanup phase 2', resolveStartPhase(lm,{apparentAttenuationPct:80,gravity:1.011,expectedFg:1.010,gravity24hDeltaPts:-0.3})===2);
ok('adopt never skips gated crash', resolveStartPhase(PRESETS.coldcrash,{apparentAttenuationPct:99,gravity:1.008,expectedFg:1.010,gravity24hDeltaPts:0})===0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
