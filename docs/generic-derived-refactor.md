# GlassHaus — Generic per-tank derived refactor (DESIGN, not built)

## Problem
The HA `glasshaus_derived.yaml` sensors are **Black-Tilt / single-batch / Tank-1 only**
(`sensor.apparent_attenuation`, `gravity_24h_delta`, `binary_sensor.tank_1_*`, etc.).
Adding a tank/batch would mean hand-duplicating ~15 sensors per tank in YAML —
which Jordan (correctly) called out as "fucking dumb": it doesn't scale.

## Principle
Compute derived values ONCE, generically, keyed by the tank↔batch↔Tilt assignment —
N tanks for free, zero per-tank YAML. Split by WHERE each concern must live:

### 1. APP (`src/data/derive.ts`) — per-batch DISPLAY math. Already generic ✅
Already computes for ANY tank via `composeBatch()`: ABV, apparent attenuation,
attenuation-progress, days-fermenting, gravity velocity (Tilt 24h-stat OR history
slope fallback), days-to-terminal. **No change needed for Tank 2/3/N to render.**
CAN also absorb: projected-FG date, pace-vs-schedule, tilt-probe delta,
gravity-drop-from-peak, and the alert CONDITIONS (stalled/excursion/near-terminal/
suspect) — all derivable from inputs the app already has. Downside: app only runs
while OPEN → can't be the source of truth for notifications or a persistent latch.

### 2. GENERIC CONTAINER LOOP — 24/7 evaluation over ALL tanks. NEW, replaces the YAML
A server-side loop (extend the analyzer/programs container, or a sibling) that reads
every tank's assignment + Tilt + sensors from HA, computes the SAME derived values +
alert conditions generically, and writes ONE per-tank entity back
(e.g. `sensor.tank_N_derived` with attrs, or discrete `sensor.tank_N_alerts`). This
is where the things the app can't own live:
- the **fermentation-started one-shot latch** (must persist across restarts),
- **alert evaluation for notifications** (must run with the dashboard closed),
- the rolling 8h-max / settling-proof logic.
Loops over the tank registry → adding a tank needs NO new code/YAML.

### 3. HA — just STATE + NOTIFY
Keeps: the assignment/program/status helpers (input_*), and automations that fire
phone notifications OFF the entities the container writes. Retires: the per-tank
template/binary_sensor derived blocks in glasshaus_derived.yaml (the stateful
history_stats can stay, or move to the container too). rest_command for triggers.

## HOW THIS AFFECTS THE APP (Jordan's question)
- **Display/UI: unchanged.** Same cards, tiles, alerts, popups, graphs. The core
  per-batch math (derive.ts) stays. Tank 2/3/N already render generically.
- **The change is a SIMPLIFICATION:** `derivedEntities(tankId)` currently reads N
  Black-only HA sensors (projected_fg, pace, fermentation_started, 5 alert binaries)
  with Tank-1 fallbacks. After refactor: read ONE generic per-tank entity the
  container writes (or compute inline). The `derivedEntities` map SHRINKS; fewer HA
  reads; no Tank-1-fallback hack. App gets simpler.
- **No feature loss:** every metric/alert/popup keeps working for all tanks.
- **New dependency (explicit trade):** the container becomes the source of truth for
  the fermentation latch + 24/7 alert/notification evaluation. If it's down, those
  specific signals go stale → app degrades to null gracefully (as it already does),
  and phone alerts pause until it's back. The dashboard itself keeps rendering live
  data (it reads HA/Tilt directly).

## Migration order (when built)
1. Container: generic per-tank derived+alert loop → writes `sensor.tank_N_derived`
   (+ latch, + status). Validate it matches the current Black sensors for Tank 1.
2. App: point `derivedEntities()` / alert reads at the generic entity; delete the
   Black-only fallbacks. Verify Tank 1 unchanged, Tank 2 now fully populated.
3. HA: retire the per-tank template/binary_sensor blocks in glasshaus_derived.yaml
   (keep history_stats or move them); keep notify automations (now off the generic
   entity). 4. Confirm N-tank: nothing per-tank remains anywhere.

## Tank 2 RIGHT NOW (no refactor needed)
Tank 2 already works as a first-class tank: probe + setpoint exist, Tilt Red exists
(`sensor.tilt_red_gravity/_temperature`), assignment helpers exist. It just needs:
status → Fermenting, and a batch assigned in ⚙ Manage. The per-batch math renders
generically. It only lacks the OPTIONAL Black-only HA extras (projected-FG/pace/HA
alert binaries) — which this refactor makes generic rather than duplicating.
