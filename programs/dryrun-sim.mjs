// ACCELERATED dry-run: drive a preset through its full lifecycle with SIMULATED
// time + gravity progression. Pure state machine, ZERO HA writes, ZERO tank impact.
import { PRESETS } from './presets.mjs';
import { tick } from './statemachine.mjs';

const preset = process.argv[2] || 'lager_modern';
const program = PRESETS[preset];
if (!program) { console.error('unknown preset', preset); process.exit(1); }

console.log(`\n=== DRY-RUN (accelerated, no HA writes): ${program.label} ===`);
console.log(`clamp ${program.clamp.minF}-${program.clamp.maxF}°F, ${program.phases.length} phases\n`);

// simulated brew: OG 1.050, target FG 1.010. Gravity falls over "days".
const OG = 1.050, FG = 1.010;
let simGravity = OG;
let phaseIndex = 0;
let phaseStartHour = 0;
let currentSetpoint = program.phases[0].kind === 'coldCrash' ? program.clamp.maxF : (program.phases[0].tempF ?? 64);
let phaseStartSetpoint = currentSetpoint;
let confirmPressed = false;
const HOURS_STEP = 6;   // advance sim clock 6h per iteration
let hour = 0, guard = 0;

function attenPct(g){ return (OG-g)/(OG-1)*100; }
function progressPct(g){ return (OG-g)/(OG-FG)*100; }

while (phaseIndex < program.phases.length && guard++ < 200) {
  const phase = program.phases[phaseIndex];
  const phaseElapsed = hour - phaseStartHour;

  // simulate gravity: drops while warm & above FG; ~flat once near FG
  const warm = currentSetpoint >= 60 || preset==='kveik';
  if (simGravity > FG + 0.001) simGravity -= warm ? 0.0035*(HOURS_STEP/6) : 0.0015*(HOURS_STEP/6);
  const grav24 = warm && simGravity>FG+0.002 ? -8 : -0.3;  // pts/day

  // auto-press confirm once we HIT an awaiting-confirm crash (simulate the user tapping it)
  const state = {
    phaseIndex, phaseElapsedHours: phaseElapsed, currentSetpointF: currentSetpoint,
    phaseStartSetpointF: phaseStartSetpoint, gravityStale:false, confirmPressed,
    gravity: simGravity, expectedFg: FG, og: OG,
    apparentAttenuationPct: attenPct(simGravity), progressToFgPct: Math.min(progressPct(simGravity),100),
    gravity24hDeltaPts: grav24,
  };
  const r = tick(program, state);

  const tag = r.awaitingConfirm ? 'AWAIT-CONFIRM' : r.paused ? 'PAUSED' : r.done ? 'DONE' : 'run';
  console.log(`h${String(hour).padStart(3)} | ${phase?.name ?? 'end'} +${phaseElapsed}h | SG ${simGravity.toFixed(4)} atten ${attenPct(simGravity).toFixed(0)}% | ${tag} → setpoint ${r.setpointF}°F ${r.advanceTo!=null?`| ADVANCE→${r.advanceTo}`:''}`);

  if (r.awaitingConfirm && !confirmPressed) {
    console.log(`        ↳ [simulating user CONFIRM crash]`);
    confirmPressed = true;
    continue; // re-tick same hour with confirm now true
  }
  if (r.setpointF != null) currentSetpoint = r.setpointF;
  if (r.advanceTo != null) {
    phaseIndex = r.advanceTo; phaseStartHour = hour; phaseStartSetpoint = currentSetpoint; confirmPressed = false;
  }
  if (r.done) break;
  hour += HOURS_STEP;
}
console.log(`\n=== sim complete in ${hour}h (guard ${guard}) ===`);
