# GlassHaus

A standalone React dashboard for the brewery — an alternative to the Home
Assistant Lovelace frontend. Glassmorphic, batch-aware, built to scale to
three fermenters.

This is a scaffold: the data model, derivation logic, HA connection layer, and
the first Overview screen (the lifecycle-sorted active-batch stack). It runs
against your live HA and grows from here.

## Run it

```bash
npm install
cp .env.example .env.local     # then edit .env.local
npm run dev
```

`.env.local`:
```
VITE_HA_URL=http://192.168.50.127:8123
VITE_HA_TOKEN=<long-lived access token>
```

Get the token: HA → your profile → Security → Long-lived access tokens →
Create. Paste it into `.env.local`.

Open http://localhost:5173 (or the LAN address Vite prints — it binds to
`host: true` so you can hit it from the tablet).

> If `npm install` ever fights you on peer deps, the hakit team ships an
> official bootstrap wizard: `npm create hakit@latest`. This scaffold targets
> hakit **6.x** (framer-motion was removed as a dep in v6). If you regenerate
> from the wizard, drop `src/` from this repo on top of it.

## HA prerequisites (helpers this app reads/writes)

The app treats HA as the source of truth for assignments and lifecycle. Create
these helpers (Settings → Devices & Services → Helpers). Only Tank 1 needs to
exist today; 2 and 3 render as empty bays until their hardware/helpers exist.

Per tank (N = 1,2,3):
- `input_select.tank_N_status`  → options: Ready, Fermenting, Dirty, Out of Service
- `input_datetime.tank_N_cleaned` (date only)
- `input_select.tank_N_tilt`    → options: None, Black, Purple, Red, Green, Orange, Blue, Yellow, Pink
- `input_select.tank_N_batch`   → options populated from Brewfather (sync automation)
- `input_number.tank_N_expected_fg`

Already built (from the HA side of this project):
- `sensor.tank_1_probe_temp_c`, `number.tank_1_setpoint_raw` (ITC-308 via LocalTuya)
- `sensor.glycol_temp`, `binary_sensor.glycol_compressor_running`
- `sensor.brewfather_all_batches_data`
- `sensor.tilt_<color>_gravity`, `sensor.tilt_<color>_temperature` (TiltPi)

Entity IDs live in one place: `src/data/registry.ts`. Edit there if yours differ.

## Architecture

```
src/
  types/domain.ts     the model: Reading<T>, Tank, TiltDevice, GlycolLoop,
                      BrewfatherBatch, TankAssignment, ActiveBatch.
                      Every reading carries its own freshness.

  data/
    derive.ts         PURE logic (no React/HA). Brewing math, staleness
                      classification, the plausibility validator, the
                      three-source join (composeBatch). Unit-testable.
    registry.ts       the ONE place declaring tanks + HA entity IDs.

  hooks/useBrewery.ts hakit bridge: reads HA entities into domain types.
                      useActiveBatches() is the top-level selector the
                      Overview consumes.

  components/         GlassPanel, StatTile, TankRow (fermenting = full row),
                      TankStrip (idle = thin bay), Overview (the stack).

  theme/tokens.ts     glassmorphic brewery palette; color === state.
```

### Why the app owns the brewing math
ABV, attenuation, phase etc. are computed in `derive.ts`, not read from HA
template sensors. This is what lets it scale to N simultaneous batches without
N sets of Jinja templates — each `ActiveBatch` is composed from its own three
sources via its assignment.

### The join problem
A "batch" = Brewfather recipe data ⋈ a Tilt (by color) ⋈ a Tank (by slug).
Nothing in the data links them; the link is the human-declared `TankAssignment`
(the tank_N_tilt / tank_N_batch helpers). `verifyAssignment` cross-checks it
against physics: if the Tilt's temp and the tank probe disagree by >5°F, the
assignment is flagged suspect. Wrong-tank mistakes get caught, not charted.

## Next
- Assignment board (drag Tilt → Tank), writing back to the helpers
- TankThermostat component (writes number.tank_N_setpoint_raw, ×10 in one place)
- Batch detail view (charts via hakit history / the Tilt long-term stats)
- Brewfather target-temp wiring (primary-batch sensor) + the automation gate
- Deploy as HA addon (hakit ships one) or on the spare Pi
```
