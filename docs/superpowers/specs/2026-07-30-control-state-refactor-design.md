# GlassHaus Control + State Refactor — Design

**Date:** 2026-07-30
**Status:** Approved (brainstorming complete) → ready for implementation plan
**Scope:** `programs/` (runner.mjs, statemachine.mjs, new modules), `ha/glasshaus_runstate.yaml`

## Problem

An architecture review found the *pure* logic (`tick`, `computeDerived`, tiltcomp math, `computeHealth`) is clean and well-tested, but `runner.mjs`'s `tickTank` (~290-line I/O+control mega-function) owns control decisions, I/O, and three kinds of scattered state, and has **zero tests**. Every recent bug lived in that untested orchestration:

- **Confirm-race (live bug):** crash-confirm detection window (5min) == tick period (5min), so button presses landing near the boundary are silently dropped → "still asking to confirm every 10 min."
- **Restart changes safety behavior:** `adopted`, `crashConfirmed`, stability clock are in-memory Maps; the container is `--restart unless-stopped` and recreated on every deploy. A restart mid-ferment can re-adopt (phantom phase jump) or re-ask crash-confirm; `gravWindow` loss nulls velocity for hours.
- **State has no owner:** spread across in-memory Maps + ~12 HA helpers + VictoriaMetrics; what survives restart is decided ad hoc per field.

These are entangled — all inside `tickTank`, all touching the same Maps — so they must be fixed together or piecemeal edits rewrite the same code repeatedly.

## Out of scope (follow-on specs)

- **SEV-1 control-model rethink** (software setpoint-shifter riding the ITC-308's black-box loop vs. taking the loop / demoting offset to a slow calibration). This refactor makes that answerable with tests; it does NOT change the control strategy.
- HausWatch findings (separate repo, separate cluster).
- Heater-smart-plug gate (separate future project).

## Architecture

`tickTank` splits into three layers with a **pure decision layer** in the middle:

```
tickAll (I/O: read HA states)
  └─ per tank:
       gatherInputs(tankId, by, tankState)  → plain ControlInput object (I/O read)
       decideCommand(input)      [PURE]     → { commandF, tiltCtl, advanceTo,
                                                awaitingConfirm, nextState, writes[] }
       applyDecision(decision)   [I/O]      → executes writes (setpoint, helpers, state doc)
```

- **`decideCommand` is pure** (like `tick`/`computeDerived`): takes resolved inputs + current `TankState`, returns what to do and the next state, touches no HA. This is the testability fix.
- **`TankState` is the single source of truth per tank**, persisted as JSON in `input_text.tank_N_control_state`. In-memory Maps become a cache hydrated from the doc on boot — never the source of truth. Restart behavior becomes designed, not accidental.
- `gravWindow` stays in-memory (it's a rolling buffer, not durable state — wrong shape for the doc); documented "null-for-a-bit after restart, VM-slope fallback covers it."

## Components

### TankState (new module, e.g. `programs/tankstate.mjs`)

Per-tank durable state, JSON in `input_text.tank_N_control_state`. Short keys for headroom under the 255-char `input_text` cap (measured: full-key version = 231 chars; short keys buy ~80 more):

| key | field | purpose |
|-----|-------|---------|
| `b`  | batchKey            | current batch identity (stale-reset trigger) |
| `pa` | phaseAnchorF        | setpoint anchor for current phase (ramp/crash step-from) |
| `cc` | crashConfirmedPhase | which phase index has crash-confirmed (−1/absent = none) |
| `ad` | adopted             | adopt-once guard (mid-ferment start jumped to right phase) |
| `ss` | stableSinceMs       | stability clock start |
| `us` | unstableSinceMs     | stability-clock noise-tolerance timer |
| `fl` | fermStartedLatch    | one-shot fermentation-started latch |
| `off`| lastOffset          | persisted tilt-comp offset (recomputable) |
| `lcp`| lastConsumedPressMs | last crash-confirm press timestamp consumed (edge-detect) |
| `u`  | updatedMs           | last write time |

Pure functions (testable, no I/O):
- `defaultState(batchKey)` → fresh doc.
- `serialize(state)` → JSON string; **255-guard**: if over, drop `off` (recomputable) and retry; if still over, return null (caller keeps last-good doc + logs error — never writes truncated/invalid JSON).
- `hydrate(rawJson)` → state | null (null on missing/unparseable).
- `seedFromHelpers(helperValues)` → state built from existing scattered helpers, for first-boot migration.
- `applyDecisionState(state, decisionNextState)` → merged next state (pure).

### decideCommand (new pure fn, e.g. in `programs/decide.mjs`)

Input: resolved control inputs (gravity/temps/setpoint/program-phase/tilt freshness) + current `TankState` + config. Output: `{ commandF, tiltCtl, advanceTo, awaitingConfirm, nextState, writes[] }`.

Absorbs from `tickTank`, as pure logic:
- phase-index clamp (already `clampPhaseIndex` in statemachine).
- adopt-once decision (reads/sets `ad`).
- **crash-confirm edge-detect:** a press counts iff `pressMs > state.lcp` (no wall-clock window). On consume: `nextState.lcp = pressMs`, `nextState.cc = phaseIndex`. Gate honors plan `requiresConfirm` (default true only when unspecified, per existing fix). Survives restart (both fields durable).
- tilt-comp regimes (freeze/near-ema-slew/far-raw) — calls existing `tiltcomp.mjs` pure fns.
- stability-clock update (existing `updateStableClock`).
- advance decision (existing `tick`).

`tickTank` becomes: `gatherInputs` → `decideCommand` → `applyDecision`.

## Data flow

1. **Boot:** for each tank, read `input_text.tank_N_control_state`. If present+parseable → hydrate cache. If missing/unparseable → `seedFromHelpers()` (read existing stable_since / fermentation_started / crash_confirmed_phase / temp_offset / program_phase helpers) → build initial doc → write it. This is the **first-boot migration** so live mid-ferment tanks carry real state across the cutover (no re-adopt, no re-confirm, no lost clock).
2. **Per tick:** gatherInputs → decideCommand(inputs, state) → applyDecision writes setpoint + advances phase + persists the doc **only if changed**.
3. **Batch change** (`b` != current): reset doc to `defaultState(newBatchKey)` — carries no old-batch latches.

## Error handling

- **Doc write failure: NOT swallowed.** In-memory cache still holds truth for this process, but log loudly + set a health flag (persistent failure → restart loses state, operator must know). Fixes the `.catch(()=>{})`-on-safety-helpers smell.
- **Unparseable doc** → treat as missing → seed from helpers, log.
- **Serialize > 255** → drop `off`, retry; still over → skip write, keep last-good doc, log error (never write invalid JSON).
- Metrics writes stay best-effort (unchanged).

## Testing (TDD, RED→GREEN)

- **`decideCommand` full suite** — the layer that had zero tests and caused every recent bug:
  - confirm edge-detect: fresh press latches; stale-but-unconsumed press still latches; already-consumed press does NOT re-latch; restart (rehydrated doc) does not re-ask.
  - three tilt-comp regimes + interaction with slew/farOff.
  - adopt-once; phase clamp; plan `requiresConfirm` honored (explicit false runs, undefined gates).
  - batch-change reset.
- **`TankState`** — serialize/hydrate round-trip; 255-guard (drop `off`; skip-on-still-over); missing→seed-from-helpers; unparseable→default.
- **Add `"test": "node --test programs/"` to `package.json`** so one command runs all suites (also unifies the mixed `ok()`/`node:test` harnesses under one runner and removes the accidental `process.exit`-ordering trap in `derived.test.mjs`).

## Rollout

1. Register `input_text.tank_N_control_state` (max 255) in `ha/glasshaus_runstate.yaml`; user loads config / reloads HA so the helper exists (else the doc write is caught + degrades to in-memory only).
2. Deploy via the established script (DRY_RUN=false + token preserved; env + mounts + published ports preserved).
3. **Verify on live mid-ferment tanks:** tank_2 (active) and tank_3 (mid-crash) seed their docs from existing helpers — confirm no re-adopt, tank_3 crash did NOT pause, stability clocks intact. Then confirm a crash-confirm button press latches durably (survives a restart).
4. Commit + push to `main` (standing rule).

## Success criteria

- A crash-confirm button press is caught on the next tick regardless of timing, latches durably, and never re-asks for the same phase (kills the confirm-race + the every-10-min re-ask).
- A container restart mid-ferment does not re-adopt (no phantom phase jump) and does not re-ask an already-confirmed crash.
- `decideCommand` is pure and unit-tested; `tickTank` is a thin gather→decide→apply.
- `node --test programs/` runs all suites green.
- Live tanks unaffected across the deploy (state seeded from existing helpers).
