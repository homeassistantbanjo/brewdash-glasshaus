// Deterministic trace of the SAISON plan through the REAL state machine (tick()).
// Proves the control logic computes the correct setpoint at every phase/step — no HA,
// no timing, no demo. This is the trustworthy check: same tick() the runner calls in
// production. Run: node programs/saison-trace.test.mjs
import { tick } from './statemachine.mjs';

// The real French Saison plan shape (peppery): cool pitch → free-rise ramp to 86 →
// hot hold 86 → conditioning 72 → confirm-gated cold crash to 38.
const program = {
  label: 'French Saison (peppery)',
  clamp: { minF: 40, maxF: 88 },
  phases: [
    { name: 'Cool Pitch', kind: 'hold', tempF: 68, advance: { type: 'attenuationOfExpected', pct: 40 } },
    { name: 'Free-Rise to Peak', kind: 'ramp', tempF: 68, targetF: 86, stepF: 2, everyHours: 12, advance: { type: 'attenuationOfExpected', pct: 85 } },
    { name: 'Hot Diastatic Hold', kind: 'hold', tempF: 86, advance: { type: 'attenuationOfExpected', pct: 95 } },
    { name: 'Conditioning', kind: 'hold', tempF: 72, advance: { type: 'elapsed', hours: 168 } },
    { name: 'Cold Crash', kind: 'coldCrash', targetF: 38, stepF: 2, everyHours: 6, requiresConfirm: true, advance: { type: 'confirm' } },
  ],
};

let pass = 0, fail = 0;
const ok = (nm, cond, got) => { if (cond) { pass++; console.log(`  ✓ ${nm}`); } else { fail++; console.log(`  ✗ ${nm}  (got ${got})`); } };

console.log('SAISON control trace — setpoint the runner would write at each step:\n');

// Phase 0: cool pitch holds at 68 (rate-limited from a 68 start = 68)
let r = tick(program, { phaseIndex: 0, phaseElapsedHours: 1, currentSetpointF: 68, gravityStale: false });
console.log(`  phase 0 Cool Pitch          → setpoint ${r.setpointF}°F  (${r.note})`);
ok('cool pitch holds 68°F', r.setpointF === 68, r.setpointF);
ok('does NOT advance early (28% < 40%)',
   tick(program, { phaseIndex: 0, phaseElapsedHours: 20, currentSetpointF: 68, gravityStale: false, og: 1.051, gravity: 1.037, expectedFg: 1.010, expectedAttenuationPct: 80 }).advanceTo == null, 'advanced');

// Phase 1: free-rise ramp — walk the +2°F/12h steps from 68 toward 86
console.log(`  phase 1 Free-Rise ramp (+2°F/12h):`);
let cur = 68;
for (const h of [0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120]) {
  const t = tick(program, { phaseIndex: 1, phaseElapsedHours: h, currentSetpointF: cur, gravityStale: false });
  console.log(`     @${String(h).padStart(3)}h → ${t.setpointF}°F`);
  cur = t.setpointF;
}
ok('ramp reaches the 86°F peak (not capped below)', cur === 86, cur);
ok('ramp never exceeds clamp max 88', cur <= 88, cur);

// Phase 2: hot diastatic hold stays at 86 (NOT lowered)
r = tick(program, { phaseIndex: 2, phaseElapsedHours: 10, currentSetpointF: 86, gravityStale: false });
console.log(`  phase 2 Hot Diastatic Hold  → setpoint ${r.setpointF}°F  (${r.note})`);
ok('hot hold stays 86°F (does NOT drop to 77)', r.setpointF === 86, r.setpointF);

// diastatic safety: with STALE gravity, an attenuation-gated phase must HOLD, not advance
r = tick(program, { phaseIndex: 2, phaseElapsedHours: 200, currentSetpointF: 86, gravityStale: true });
ok('stale gravity → holds, does NOT advance (diastatic safety)', r.advanceTo == null && r.paused === true, `advanceTo=${r.advanceTo} paused=${r.paused}`);

// Phase 3: conditioning 72
r = tick(program, { phaseIndex: 3, phaseElapsedHours: 1, currentSetpointF: 86, gravityStale: false });
console.log(`  phase 3 Conditioning        → setpoint ${r.setpointF}°F  (rate-limited from 86)`);
ok('conditioning steps DOWN from 86 toward 72 (rate-limited)', r.setpointF < 86 && r.setpointF >= 72, r.setpointF);

// Phase 4: cold crash MUST await confirm before doing anything
r = tick(program, { phaseIndex: 4, phaseElapsedHours: 1, currentSetpointF: 72, gravityStale: false, confirmPressed: false });
console.log(`  phase 4 Cold Crash          → ${r.awaitingConfirm ? 'AWAITING CONFIRM (gated)' : 'setpoint ' + r.setpointF}`);
ok('cold crash AWAITS confirmation (never auto-crashes)', r.awaitingConfirm === true, `awaitingConfirm=${r.awaitingConfirm}`);
// once confirmed, it crashes toward 38 (rate-limited down)
r = tick(program, { phaseIndex: 4, phaseElapsedHours: 1, currentSetpointF: 72, gravityStale: false, confirmPressed: true });
ok('after confirm, crashes DOWN toward 38', r.setpointF < 72, r.setpointF);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
