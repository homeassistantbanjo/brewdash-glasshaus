# GlassHaus Control + State Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give per-tank control state one durable owner and extract a pure, testable decision function from the 290-line `tickTank`, fixing the confirm-race and restart-changes-safety bugs.

**Architecture:** Introduce `TankState` (a per-tank JSON doc persisted in `input_text.tank_N_control_state`; in-memory Maps become a cache hydrated on boot) and `decideCommand` (a pure function taking resolved inputs + current TankState, returning the command + next state + write intents). `tickTank` becomes a thin gather→decide→apply. Confirm detection switches from a wall-clock window to edge-detection (`pressMs > lastConsumedPressMs`).

**Tech Stack:** Node 22 (built-in `node:test`, `fetch`), ES modules, Home Assistant REST API. No new deps.

**Spec:** `docs/superpowers/specs/2026-07-30-control-state-refactor-design.md`

## Global Constraints

- Node ESM (`.mjs`), no new npm dependencies. Node 22 built-in `node:test` + `assert`.
- All new logic modules must be PURE (no I/O) and unit-tested; I/O stays in `runner.mjs`.
- `input_text` state value hard cap: **255 characters**. The serialized TankState MUST fit.
- TankState JSON uses SHORT keys exactly: `b, pa, cc, ad, ss, us, fl, off, lcp, u` (batchKey, phaseAnchorF, crashConfirmedPhase, adopted, stableSinceMs, unstableSinceMs, fermStartedLatch, lastOffset, lastConsumedPressMs, updatedMs).
- Safety-critical helper writes (the control-state doc) must NOT be silently swallowed — log on failure. Metrics writes stay best-effort.
- `DRY_RUN` semantics unchanged: when true, log intended writes, never call HA set-services.
- Preserve existing behavior verbatim where not explicitly changed (tilt-comp regimes, clamp, plan `requiresConfirm` defaulting).
- Out of scope: SEV-1 control-model rethink; do not change the setpoint-shifter strategy.

## File Structure

- **Create** `programs/tankstate.mjs` — pure TankState: `defaultState`, `serialize`, `hydrate`, `seedFromHelpers`, `mergeNext`. No I/O.
- **Create** `programs/tankstate.test.mjs` — `node:test`.
- **Create** `programs/decide.mjs` — pure `decideCommand(input)`. Imports pure fns from `statemachine.mjs`/`tiltcomp.mjs`. No I/O.
- **Create** `programs/decide.test.mjs` — `node:test`.
- **Modify** `programs/runner.mjs` — replace `tickTank`'s inline logic with gather→`decideCommand`→apply; hydrate/persist TankState; boot migration.
- **Modify** `programs/package.json` — `"test": "node --test"` over all `*.test.mjs`.
- **Modify** `ha/glasshaus_runstate.yaml` — register `input_text.tank_N_control_state` (max 255).

---

### Task 1: TankState serialize/hydrate with 255-char guard

**Files:**
- Create: `programs/tankstate.mjs`
- Test: `programs/tankstate.test.mjs`

**Interfaces:**
- Produces:
  - `defaultState(batchKey: string) → State` where `State = { b, pa, cc, ad, ss, us, fl, off, lcp, u }` (pa/ss/us/off/lcp nullable numbers; cc number, -1 = none; ad/fl bool; b string; u number).
  - `serialize(state: State) → string | null` — JSON with short keys; returns null if it cannot fit ≤255 even after dropping `off`.
  - `hydrate(raw: string | null | undefined) → State | null` — parse; null on missing/invalid.

- [ ] **Step 1: Write the failing test**

```javascript
// programs/tankstate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultState, serialize, hydrate } from './tankstate.mjs';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test programs/tankstate.test.mjs`
Expected: FAIL — `Cannot find module './tankstate.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// programs/tankstate.mjs
// Pure per-tank control state. Persisted by the runner as JSON in
// input_text.tank_N_control_state (255-char cap). Short keys for headroom.
const KEYS = ['b','pa','cc','ad','ss','us','fl','off','lcp','u'];

export function defaultState(batchKey) {
  return { b: String(batchKey ?? 'none'), pa: null, cc: -1, ad: false,
    ss: null, us: null, fl: false, off: null, lcp: null, u: 0 };
}

export function serialize(state) {
  const pick = (s) => { const o = {}; for (const k of KEYS) o[k] = s[k]; return o; };
  let json = JSON.stringify(pick(state));
  if (json.length <= 255) return json;
  // drop `off` (recomputable) and retry
  const trimmed = pick(state); trimmed.off = null;
  json = JSON.stringify(trimmed);
  return json.length <= 255 ? json : null;  // caller keeps last-good + logs
}

export function hydrate(raw) {
  if (raw == null || raw === '' || raw === 'unknown' || raw === 'unavailable') return null;
  try {
    const o = typeof raw === 'object' ? raw : JSON.parse(raw);
    if (!o || typeof o !== 'object' || o.b == null) return null;
    const d = defaultState(o.b);
    for (const k of KEYS) if (o[k] !== undefined) d[k] = o[k];
    return d;
  } catch { return null; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test programs/tankstate.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add programs/tankstate.mjs programs/tankstate.test.mjs
git commit -m "feat(programs): TankState serialize/hydrate with 255-char guard"
```

---

### Task 2: TankState seed-from-helpers (first-boot migration)

**Files:**
- Modify: `programs/tankstate.mjs`
- Test: `programs/tankstate.test.mjs`

**Interfaces:**
- Consumes: `defaultState` (Task 1).
- Produces: `seedFromHelpers(h: HelperValues) → State` where `HelperValues = { batchKey, phaseIndex, stableSinceMs, fermStarted, crashConfirmedPhase, tempOffset }` (all nullable). Builds an initial State so a live mid-ferment tank carries real state across the cutover.

- [ ] **Step 1: Write the failing test**

```javascript
// append to programs/tankstate.test.mjs
import { seedFromHelpers } from './tankstate.mjs';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test programs/tankstate.test.mjs`
Expected: FAIL — `seedFromHelpers is not a function`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// add to programs/tankstate.mjs
export function seedFromHelpers(h) {
  const s = defaultState(h?.batchKey ?? 'none');
  if (h == null) return s;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (Number.isFinite(Number(v)) ? Number(v) : null));
  s.ss = num(h.stableSinceMs);
  s.fl = h.fermStarted === true;
  s.cc = num(h.crashConfirmedPhase) != null ? num(h.crashConfirmedPhase) : -1;
  s.off = num(h.tempOffset);
  // a tank that already has fermentation-started or a running batch is mid-ferment:
  // treat as adopted so the runner does not re-run resolveStartPhase and jump phases.
  s.ad = s.fl === true || num(h.phaseIndex) > 0;
  return s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test programs/tankstate.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add programs/tankstate.mjs programs/tankstate.test.mjs
git commit -m "feat(programs): TankState seedFromHelpers first-boot migration"
```

---

### Task 3: decideCommand — confirm edge-detect + gate

**Files:**
- Create: `programs/decide.mjs`
- Test: `programs/decide.test.mjs`

**Interfaces:**
- Consumes: `tick` from `statemachine.mjs`; `State` from `tankstate.mjs`.
- Produces: `decideCommand(input) → Decision`.
  - `input = { program, phaseIndex, phaseElapsedHours, currentSetpointF, tankState, pressMs, control }` where `control` carries gravity/temps/tilt freshness (same fields `tick` needs), `pressMs` = the crash-confirm button's last_changed epoch ms (or null).
  - `Decision = { commandF, tiltCtl, advanceTo, awaitingConfirm, nextState, writes }`.
  - Confirm rule: a press counts iff `pressMs != null && pressMs > (tankState.lcp ?? 0)`. When it counts for a gated phase, `nextState.lcp = pressMs` and `nextState.cc = phaseIndex`. A phase is confirmed if `tankState.cc === phaseIndex` OR a fresh press counted this tick.

**NOTE for this task:** implement ONLY the confirm decision + `tick` passthrough of setpoint/advance. Tilt-comp regimes come in Task 4. Keep `tiltCtl='probe'` and `commandF = tickResult.setpointF` for now.

- [ ] **Step 1: Write the failing test**

```javascript
// programs/decide.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCommand } from './decide.mjs';
import { defaultState } from './tankstate.mjs';

const crashPlan = { clamp:{minF:32,maxF:75}, phases:[{ name:'Cold Crash', kind:'coldCrash', targetF:36, stepF:3, everyHours:1, requiresConfirm:true }] };
const baseInput = (over={}) => ({
  program: crashPlan, phaseIndex: 0, phaseElapsedHours: 0, currentSetpointF: 66,
  tankState: defaultState('148'), pressMs: null,
  control: { gravityStale: false, phaseStartSetpointF: 66 }, ...over,
});

test('gated crash with no press + not latched → awaiting', () => {
  const d = decideCommand(baseInput());
  assert.equal(d.awaitingConfirm, true);
});

test('fresh press (pressMs > lcp) → runs + latches cc & lcp', () => {
  const st = defaultState('148'); st.lcp = 1000;
  const d = decideCommand(baseInput({ pressMs: 2000, tankState: st }));
  assert.equal(d.awaitingConfirm, false);
  assert.equal(d.nextState.cc, 0);
  assert.equal(d.nextState.lcp, 2000);
  assert.ok(d.commandF < 66);   // crash steps down
});

test('already-consumed press (pressMs == lcp) does NOT re-latch', () => {
  const st = defaultState('148'); st.lcp = 2000; st.cc = -1;
  const d = decideCommand(baseInput({ pressMs: 2000, tankState: st }));
  assert.equal(d.awaitingConfirm, true);   // not newer than lcp → not a fresh press
});

test('already-latched phase (cc==phaseIndex) runs WITHOUT a press', () => {
  const st = defaultState('148'); st.cc = 0;
  const d = decideCommand(baseInput({ pressMs: null, tankState: st }));
  assert.equal(d.awaitingConfirm, false);
  assert.ok(d.commandF < 66);
});

test('stale-but-newer press still latches (no wall-clock window)', () => {
  const st = defaultState('148'); st.lcp = 0;
  const d = decideCommand(baseInput({ pressMs: 1, tankState: st }));  // pressMs tiny but > lcp
  assert.equal(d.awaitingConfirm, false);
  assert.equal(d.nextState.lcp, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test programs/decide.test.mjs`
Expected: FAIL — `Cannot find module './decide.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// programs/decide.mjs
// PURE control decision. Takes resolved inputs + current TankState, returns the
// command + next state + write intents. No I/O. See spec 2026-07-30.
import { tick } from './statemachine.mjs';

export function decideCommand(input) {
  const { program, phaseIndex, phaseElapsedHours, currentSetpointF, tankState, pressMs, control } = input;
  const next = { ...tankState };

  // CONFIRM EDGE-DETECT: a press counts iff strictly newer than the last consumed one.
  // No wall-clock freshness window (that window == tick period caused dropped presses).
  const freshPress = pressMs != null && pressMs > (tankState.lcp ?? 0);
  const alreadyLatched = tankState.cc === phaseIndex;
  const confirmPressed = freshPress || alreadyLatched;
  if (freshPress) { next.lcp = pressMs; next.cc = phaseIndex; }

  const r = tick(program, {
    phaseIndex, phaseElapsedHours, currentSetpointF,
    phaseStartSetpointF: control.phaseStartSetpointF ?? currentSetpointF,
    gravityStale: control.gravityStale, confirmPressed,
    gravity: control.gravity ?? null, expectedFg: control.expectedFg ?? null,
    og: control.og ?? null, apparentAttenuationPct: control.apparentAttenuationPct ?? null,
    progressToFgPct: control.progressToFgPct ?? null, gravity24hDeltaPts: control.gravity24hDeltaPts ?? null,
    expectedAttenuationPct: control.expectedAttenuationPct ?? null,
  });

  return {
    commandF: r.setpointF,
    tiltCtl: 'probe',
    advanceTo: r.advanceTo ?? null,
    awaitingConfirm: !!r.awaitingConfirm,
    done: !!r.done,
    note: r.note,
    nextState: next,
    writes: [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test programs/decide.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add programs/decide.mjs programs/decide.test.mjs
git commit -m "feat(programs): decideCommand confirm edge-detect (pure)"
```

---

### Task 4: decideCommand — tilt-comp regimes

**Files:**
- Modify: `programs/decide.mjs`
- Test: `programs/decide.test.mjs`

**Interfaces:**
- Consumes: `beerInBand, smoothOffset, slewLimit` from `tiltcomp.mjs`; `clampPhaseIndex` via `statemachine.mjs` `_internals`.
- Produces: extends `decideCommand`: when `input.control.tempSource` matches `/tilt/i` and a fresh Tilt reading exists, apply the three-regime tilt-comp (freeze in-band / EMA+slew near / raw-no-slew far) to `commandF`, set `tiltCtl` to `'tilt'|'held'|'decaying'|'probe'`, and put the persisted offset into `nextState.off`. Config values (`EMA_ALPHA, MAX_SLEW_F, BAND_F, FAR_OFF_F, OFFSET_CAP_F, GRACE_MIN, DECAY_H`) arrive on `input.cfg`.

- [ ] **Step 1: Write the failing test**

```javascript
// append to programs/decide.test.mjs
import { defaultState as ds } from './tankstate.mjs';
const cfg = { EMA_ALPHA:0.3, MAX_SLEW_F:0.5, BAND_F:0.6, FAR_OFF_F:1.5, OFFSET_CAP_F:7, GRACE_MIN:45, DECAY_H:4 };
const holdPlan = { clamp:{minF:32,maxF:75}, phases:[{ name:'Hold', kind:'hold', tempF:66 }] };
const tiltInput = (over={}) => ({
  program: holdPlan, phaseIndex:0, phaseElapsedHours:0, currentSetpointF:66,
  tankState: ds('148'), pressMs:null, cfg,
  control: { gravityStale:false, phaseStartSetpointF:66, tempSource:'Tilt',
    beerTempF:64, beerTempAgeMin:1, probeTempF:67.5 }, ...over,
});

test('far off target → full raw offset, no slew throttle', () => {
  // beer 64, target 66 → err 2 > FAR_OFF 1.5 → offset = probe-tilt = 3.5, command ~69.5
  const d = decideCommand(tiltInput());
  assert.equal(d.tiltCtl, 'tilt');
  assert.ok(d.commandF >= 69 && d.commandF <= 70);
  assert.ok(Math.abs(d.nextState.off - 3.5) < 0.01);
});

test('in-band → freeze offset (no chase)', () => {
  const st = ds('148'); st.off = 3;
  const d = decideCommand(tiltInput({ control: { gravityStale:false, phaseStartSetpointF:66, tempSource:'Tilt', beerTempF:66.2, beerTempAgeMin:1, probeTempF:69 }, tankState: st }));
  assert.equal(d.nextState.off, 3);   // held, unchanged
});

test('probe mode → no tilt-comp, command = plan setpoint', () => {
  const d = decideCommand(tiltInput({ control: { gravityStale:false, phaseStartSetpointF:66, tempSource:'Probe' } }));
  assert.equal(d.tiltCtl, 'probe');
  assert.equal(d.commandF, 66);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test programs/decide.test.mjs`
Expected: FAIL — tilt regime not implemented (tiltCtl stays 'probe', commandF stays 66).

- [ ] **Step 3: Write minimal implementation**

Port the tilt-comp block from `runner.mjs:259-335` into `decideCommand`, reading tunables from `input.cfg` instead of module env, and reading/writing the offset via `tankState.off`/`nextState.off` instead of the HA helper. Structure:

```javascript
// in decide.mjs — add imports
import { beerInBand, smoothOffset, slewLimit } from './tiltcomp.mjs';
import { _internals } from './statemachine.mjs';
const { clampPhaseIndex } = _internals;

// inside decideCommand, AFTER computing r (tick result), BEFORE return:
let commandF = r.setpointF;
let tiltCtl = 'probe';
const cfg = input.cfg ?? {};
const c = input.control;
if (commandF != null && /tilt/i.test(c.tempSource || 'Probe')) {
  const probeF = c.probeTempF ?? null;
  const tiltF = c.beerTempF ?? null;
  const tiltAgeMin = c.beerTempAgeMin ?? null;
  const tiltFresh = tiltF != null && (tiltAgeMin == null || tiltAgeMin <= 30);
  const prevOffset = tankState.off;
  const cap = cfg.OFFSET_CAP_F ?? 7;
  const clamp = (o) => Math.max(-cap, Math.min(cap, o));
  let offset = null, farOff = false;
  const targetF = r.setpointF;
  if (probeF != null && tiltF != null && tiltFresh) {
    const err = Math.abs(tiltF - targetF);
    const raw = clamp(probeF - tiltF);
    if (beerInBand(tiltF, targetF, cfg.BAND_F ?? 0.6) && prevOffset != null) {
      offset = clamp(prevOffset); tiltCtl = 'tilt';
    } else if (err > (cfg.FAR_OFF_F ?? 1.5) || prevOffset == null) {
      offset = raw; farOff = true; tiltCtl = 'tilt';
    } else {
      offset = clamp(smoothOffset(raw, prevOffset, cfg.EMA_ALPHA ?? 0.3)); tiltCtl = 'tilt';
    }
    next.off = offset;
  } else if (prevOffset != null) {
    // held/decaying (Tilt lost) — port the GRACE_MIN/DECAY_H logic from runner.mjs:305-320
    const gapMin = tiltAgeMin ?? 9999;
    if (gapMin <= (cfg.GRACE_MIN ?? 45)) { offset = clamp(prevOffset); tiltCtl = 'held'; }
    else {
      const past = (gapMin - (cfg.GRACE_MIN ?? 45)) / 60;
      const f = Math.max(0, 1 - past / (cfg.DECAY_H ?? 4));
      offset = clamp(prevOffset * f); tiltCtl = 'decaying';
      if (Math.abs(offset) < 0.1) next.off = 0;
    }
  }
  if (offset != null && Math.abs(offset) >= 0.05) {
    const compensated = r.setpointF + offset;
    const clamped = program.clamp
      ? Math.max(program.clamp.minF, Math.min(program.clamp.maxF, compensated)) : compensated;
    commandF = farOff ? clamped : slewLimit(clamped, currentSetpointF, cfg.MAX_SLEW_F ?? 0.5);
  }
}
// then in the returned object: commandF, tiltCtl (replacing the Task 3 placeholders)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test programs/decide.test.mjs`
Expected: PASS (8 tests). Also run `node --test programs/tiltcomp.test.mjs` — still green.

- [ ] **Step 5: Commit**

```bash
git add programs/decide.mjs programs/decide.test.mjs
git commit -m "feat(programs): decideCommand tilt-comp regimes (pure)"
```

---

### Task 5: package.json test script over all suites

**Files:**
- Modify: `programs/package.json`

**Interfaces:** none (tooling).

- [ ] **Step 1: Change the test script**

In `programs/package.json`, change:
```json
    "test": "node statemachine.test.mjs"
```
to:
```json
    "test": "node --test"
```
(`node --test` auto-discovers all `*.test.mjs` in the dir.)

- [ ] **Step 2: Run the whole suite**

Run: `cd programs && node --test`
Expected: PASS — all of tankstate, decide, statemachine, derived, tiltcomp, monitor suites run. Note: `statemachine.test.mjs`/`tiltcomp.test.mjs` use a hand-rolled `ok()` + `process.exit`; under `node --test` they still run as a file and their `process.exit(fail?1:0)` reports pass/fail. Verify exit code 0.

- [ ] **Step 3: Commit**

```bash
git add programs/package.json
git commit -m "chore(programs): run all test suites via node --test"
```

---

### Task 6: Register the control-state HA helper

**Files:**
- Modify: `ha/glasshaus_runstate.yaml`

**Interfaces:** produces `input_text.tank_N_control_state` (max 255) for tanks 1-3.

- [ ] **Step 1: Add the helper block**

In `ha/glasshaus_runstate.yaml`, under the existing `input_text:` map (after the `crash_confirmed_phase` entries), add:
```yaml
  # Durable per-tank control state (JSON, short keys). Single source of truth for
  # phase anchor, crash-confirm, adopt flag, stability clock, tilt offset,
  # last-consumed confirm press. Runner hydrates on boot, persists on change.
  tank_1_control_state: &ctlstate
    name: Tank 1 Control State
    max: 255
  tank_2_control_state:
    <<: *ctlstate
    name: Tank 2 Control State
  tank_3_control_state:
    <<: *ctlstate
    name: Tank 3 Control State
```

- [ ] **Step 2: Validate YAML parses**

Run: `node -e "const y=require('fs').readFileSync('ha/glasshaus_runstate.yaml','utf8'); if(!/tank_3_control_state/.test(y)) throw new Error('missing'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add ha/glasshaus_runstate.yaml
git commit -m "feat(ha): register tank_N_control_state helper (max 255)"
```

**NOTE (user action, not a code step):** this helper only exists in HA after a config reload / restart. Until then the runner's control-state write is caught + logged and it degrades to in-memory (Task 8 handles this gracefully). Flag to the user at rollout.

---

### Task 7: Wire TankState hydrate + decideCommand into the runner tick

**Files:**
- Modify: `programs/runner.mjs` (import decide/tankstate; replace the inline decision block in `tickTank`; add hydrate-on-first-touch + persist-on-change)

**Interfaces:**
- Consumes: `decideCommand` (Task 3/4), `hydrate`, `serialize`, `seedFromHelpers`, `defaultState` (Task 1/2).
- Produces: `tickTank` now: read state doc (hydrate; if null → `seedFromHelpers` from existing helpers → persist) → build `control` input + `pressMs` (from `input_button.${tankId}_confirm_crash` `last_changed`) + `cfg` (env tunables) → `decideCommand` → write setpoint / advance / persist changed state.
- Add module-level `const tankStateCache = new Map()` (tankId → State) as the hydrated cache.

- [ ] **Step 1: Write the failing test (runner integration seam)**

Because `tickTank` is I/O-coupled, test the seam via a thin exported helper. Add to `runner.mjs` an exported pure builder and test it:

```javascript
// programs/runner.test.mjs  (new)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _buildControlInput } from './runner.mjs';

test('_buildControlInput extracts pressMs from button last_changed', () => {
  const by = {
    'input_button.tank_2_confirm_crash': { state: '2026-07-30T15:00:00Z', last_changed: '2026-07-30T15:00:00Z' },
  };
  const inp = _buildControlInput('tank_2', by, { off: 3, cc: -1, lcp: 0 }, { gravityStale:false });
  assert.equal(inp.pressMs, Date.parse('2026-07-30T15:00:00Z'));
  assert.equal(inp.tankState.off, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test programs/runner.test.mjs`
Expected: FAIL — `_buildControlInput is not a function`.

- [ ] **Step 3: Implement + wire**

Add `export function _buildControlInput(tankId, by, tankState, control)` that assembles `{ program?, phaseIndex, phaseElapsedHours, currentSetpointF, tankState, pressMs, cfg, control }`, deriving `pressMs = by[`input_button.${tankId}_confirm_crash`]?.last_changed ? Date.parse(...) : null`. Then in `tickTank`: hydrate `tankStateCache` from `input_text.${tankId}_control_state` (seed-from-helpers + persist if absent), call `decideCommand(_buildControlInput(...))`, and replace the inline confirm-latch + tilt-comp + advance blocks with the returned `commandF`/`tiltCtl`/`advanceTo`/`nextState`. Persist `nextState` via `serialize` → `input_text` write **only when changed**; on serialize→null or write failure, log (do NOT swallow) + keep cache. Remove the now-dead `crashConfirmed`/`adopted`/inline-tilt-comp code paths they replace.

- [ ] **Step 4: Run tests**

Run: `cd programs && node --test`
Expected: PASS — runner.test + all pure suites green. Also `node --check runner.mjs`.

- [ ] **Step 5: Commit**

```bash
git add programs/runner.mjs programs/runner.test.mjs
git commit -m "feat(programs): wire TankState + decideCommand into tickTank"
```

---

### Task 8: Boot hydration + graceful-degrade when helper absent

**Files:**
- Modify: `programs/runner.mjs`
- Test: `programs/runner.test.mjs`

**Interfaces:**
- Produces: on first touch of a tank with no `_control_state` doc (helper missing OR empty), the runner seeds from existing helpers, attempts to persist, and if the write fails (helper not yet registered in HA) logs a warning + continues with the in-memory cache. No crash, no lost tick.

- [ ] **Step 1: Write the failing test**

```javascript
// append to programs/runner.test.mjs
import { _resolveInitialState } from './runner.mjs';

test('_resolveInitialState: existing doc hydrates', () => {
  const by = { 'input_text.tank_2_control_state': { state: '{"b":"148","cc":0,"off":3,"ad":true,"pa":66,"ss":null,"us":null,"fl":true,"lcp":1000,"u":1}' } };
  const s = _resolveInitialState('tank_2', by, '148');
  assert.equal(s.cc, 0); assert.equal(s.off, 3);
});

test('_resolveInitialState: missing doc → seed from helpers', () => {
  const by = {
    'input_text.tank_2_control_state': { state: 'unknown' },
    'input_boolean.tank_2_fermentation_started': { state: 'on' },
    'input_number.tank_2_temp_offset': { state: '4.3' },
  };
  const s = _resolveInitialState('tank_2', by, '148');
  assert.equal(s.b, '148');
  assert.equal(s.fl, true);
  assert.equal(s.off, 4.3);
  assert.equal(s.ad, true);   // fermentation-started → adopted, no re-jump
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test programs/runner.test.mjs`
Expected: FAIL — `_resolveInitialState is not a function`.

- [ ] **Step 3: Implement**

Add `export function _resolveInitialState(tankId, by, batchKey)`: read `input_text.${tankId}_control_state` → `hydrate`; if non-null and `.b === batchKey` return it; else `seedFromHelpers({ batchKey, phaseIndex: numOr(by[`input_number.${tankId}_program_phase`]?.state), stableSinceMs: parse(by[`input_datetime.${tankId}_stable_since`]?.state), fermStarted: by[`input_boolean.${tankId}_fermentation_started`]?.state === 'on', crashConfirmedPhase: numOr(by[`input_text.${tankId}_crash_confirmed_phase`]?.state), tempOffset: numOr(by[`input_number.${tankId}_temp_offset`]?.state) })`. In `tickTank`, use it to populate `tankStateCache` on first touch; wrap the persist write in try/catch that logs `[tankId] control-state write failed (helper registered?)` and continues.

- [ ] **Step 4: Run tests**

Run: `cd programs && node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add programs/runner.mjs programs/runner.test.mjs
git commit -m "feat(programs): boot hydration + graceful degrade when helper absent"
```

---

### Task 9: Deploy + live verification

**Files:** none (operational). Uses the established `/tmp/_programs_deploy.sh` (DRY_RUN=false + token + env + mounts + ports preserved).

- [ ] **Step 1:** Confirm full suite green: `cd programs && node --test` → exit 0.
- [ ] **Step 2:** Tar `programs` (exclude node_modules + `*.test.mjs`), scp, run `_programs_deploy.sh`. Expect `DRY_RUN=false confirmed ✓ / BUILD OK / HEALTHY`.
- [ ] **Step 3:** Verify live: tank_2 + tank_3 each wrote a `_control_state` doc seeded from helpers (query the entity); confirm tank_3's crash did NOT pause (still `Cold Crash: N°F`, not `awaiting`), tank_2 stable clock preserved. Read runner logs for a `seed`/hydrate line and no `control-state write failed` (if failed → user must load `glasshaus_runstate.yaml` in HA).
- [ ] **Step 4:** Press the crash-confirm button once; verify next tick latches (`cc` in the doc = phase index) and it does NOT re-ask 10 min later.
- [ ] **Step 5:** Commit any deploy-script tweaks if needed; ensure branch pushed to `main`.

---

## Self-Review

**Spec coverage:** decideCommand extraction → Tasks 3-4,7. TankState doc + short keys + 255 guard → Task 1. seed-from-helpers migration → Tasks 2,8. confirm edge-detect → Task 3. re-adopt fix → Task 2 (`ad`), Task 8. don't-swallow doc write → Tasks 7-8. test runner → Task 5. HA helper → Task 6. live verification → Task 9. gravWindow left in-memory (spec) → unchanged, no task needed. SEV-1 excluded → no task. **All spec sections covered.**

**Placeholder scan:** Task 4 and Task 7-8 reference "port the block from runner.mjs:LINES" rather than inlining the full 80-line block — this is deliberate (the code exists verbatim in the repo and the plan cites exact line ranges), but a fresh implementer must read those lines. Acceptable since the source is in-repo and cited precisely; NOT a vague "add error handling."

**Type consistency:** `State` short keys `{b,pa,cc,ad,ss,us,fl,off,lcp,u}` used identically across Tasks 1,2,3,4,7,8. `decideCommand` input/Decision shape consistent Tasks 3→4→7. `seedFromHelpers`/`hydrate`/`serialize`/`_resolveInitialState`/`_buildControlInput` names consistent across tasks.
