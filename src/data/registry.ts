/**
 * The registry: the ONE place that declares physical tanks and the HA entity
 * IDs behind them. Everything else references tanks by id and never hardcodes
 * an entity string. Adding Tank 2's hardware = its entities start resolving;
 * no code change needed, the empty bay fills in.
 *
 * Edit the entity IDs here if yours differ (check Developer Tools → States).
 */

import { TiltColor } from '../types/domain';

export interface TankConfig {
  id: string;
  label: string;
  // ITC-308 via LocalTuya — may not exist yet (empty bay until then)
  probeC: string;       // sensor.tank_N_probe_temp_c (native °C from DP 104)
  setpointRaw: string;  // number.tank_N_setpoint_raw (writable, ×10)
  // smart-plug wattage on the ITC-308 — reveals cool(pump)/heat/idle. Optional
  // (null until a plug is added); when present, drives the equipment power state.
  controllerPower: string | null; // sensor.tank_N_temp_controller_power_current_consumption
  /**
   * Wattage bands (W) for THIS tank's controller — PER TANK on purpose. Tank 1's
   * pump is small (~25W chill) and its heater modest, but other tanks have
   * beefier pumps and ≥250W heaters, so a single shared band would misclassify
   * them. `cool` = min draw to count as cooling (pump on); `heat` = min draw to
   * count as heating. Below `cool` = idle. Tune each as you observe the unit.
   */
  controllerBands: { cool: number; heat: number };
  // lifecycle helpers (input_select / input_datetime)
  status: string;       // input_select.tank_N_status
  cleaned: string;      // input_datetime.tank_N_last_cleaned
  // assignment helpers
  tiltAssign: string;   // input_select.tank_N_tilt
  batchAssign: string;  // input_select.tank_N_batch
}

export const TANKS: TankConfig[] = [
  {
    id: 'tank_1',
    label: 'Tank 1',
    probeC: 'sensor.tank_1_probe_temp_c',
    setpointRaw: 'number.tank_1_setpoint_raw',
    controllerPower: 'sensor.tank_1_temp_controller_power_current_consumption',
    // Observed 2026-07-07: idle ~0.75W, chilling (glycol pump) ~25W. Tank 1 still
    // has the OLD weak heater at ~22–23W, which OVERLAPS the pump — so wattage
    // alone can't tell heat from cool here. `heat` is set high (60W) so a mid-band
    // draw falls to the probe-vs-setpoint tiebreaker in classifyPower(). Once the
    // new 120W heater is installed, drop `heat` to ~70 like tanks 2/3 and the
    // tiebreaker becomes moot.
    controllerBands: { cool: 10, heat: 60 },
    status: 'input_select.tank_1_status',
    cleaned: 'input_datetime.tank_1_last_cleaned',
    tiltAssign: 'input_select.tank_1_tilt',
    batchAssign: 'input_select.tank_1_batch',
  },
  {
    id: 'tank_2',
    label: 'Tank 2',
    probeC: 'sensor.tank_2_probe_temp_c',
    setpointRaw: 'number.tank_2_setpoint_raw',
    controllerPower: null, // no plug yet
    // Tank 2 already has a 120W heater (and a stronger pump than Tank 1). The
    // 120W heater is WELL separated from pump draw, so wattage classifies cleanly:
    // `heat` ~70W sits between the pump band and the heater. Bump `cool` to ~30W
    // for the bigger pump. Retune once a plug + observations exist.
    controllerBands: { cool: 30, heat: 70 },
    status: 'input_select.tank_2_status',
    cleaned: 'input_datetime.tank_2_last_cleaned',
    tiltAssign: 'input_select.tank_2_tilt',
    batchAssign: 'input_select.tank_2_batch',
  },
  {
    id: 'tank_3',
    label: 'Tank 3',
    probeC: 'sensor.tank_3_probe_temp_c',
    setpointRaw: 'number.tank_3_setpoint_raw',
    controllerPower: null, // no plug yet
    // Same as Tank 2: 120W heater + stronger pump → clean wattage separation.
    // Retune once a plug + observations exist.
    controllerBands: { cool: 30, heat: 70 },
    status: 'input_select.tank_3_status',
    cleaned: 'input_datetime.tank_3_last_cleaned',
    tiltAssign: 'input_select.tank_3_tilt',
    batchAssign: 'input_select.tank_3_batch',
  },
];

/** Shared glycol loop + brewery-wide entities. */
export const PLANT = {
  glycolTemp: 'sensor.glycol_temp',
  glycolCompressor: 'binary_sensor.glycol_compressor_running',
  glycolChillerSwitch: 'switch.glycol_chiller_temp',
  // Smart-plug wattage — the REAL cooling truth. The chiller switch reads 'on'
  // even when the compressor is idle; wattage doesn't lie. ~450W running, <1W idle.
  glycolPlugPower: 'sensor.glycol_power_current_consumption',
  glycolEnergyToday: 'sensor.glycol_power_today_s_consumption',
  glycolEnergyTotal: 'sensor.glycol_power_total_consumption',
  brewfatherAll: 'sensor.brewfather_all_batches_data',
  brewfatherStatus: 'sensor.brewfather_integration_status',
  // LLM insight entity written by the analyzer container (state=headline;
  // attrs: severity, detail, action). Null-safe: absent until the analyzer runs.
  insight: 'sensor.glasshaus_insight',
} as const;

/**
 * Kegerator smart plug — serving/dispense cold storage, independent of the
 * fermentation glycol loop. ~280W compressor draw when cooling, near-zero idle.
 */
export const KEGERATOR = {
  power: 'sensor.kegerator_power_current_consumption',
  energyToday: 'sensor.kegerator_power_today_s_consumption',
  energyTotal: 'sensor.kegerator_power_total_consumption',
  label: 'Kegerator',
} as const;

/** Per-tank controller kWh entity ids, by convention. null when no plug. */
export function tankControllerEnergy(cfg: TankConfig) {
  if (!cfg.controllerPower) return null;
  const base = cfg.controllerPower.replace('_current_consumption', '');
  return {
    today: `${base}_today_s_consumption`,
    total: `${base}_total_consumption`,
  };
}

/**
 * Wattage thresholds (W) for the single-instance plants (glycol, kegerator).
 * Per-tank controller bands live on each TankConfig.controllerBands instead,
 * because tanks differ (bigger pumps, ≥250W heaters on tanks 2/3).
 * Observed live on 2026-07-07 — tune as you learn each unit's profile.
 *
 *   glycol:     ~450W chilling (spikes higher on start), <1W idle → 200W is a
 *               safe "definitely running" line above the standby draw.
 *   kegerator:  ~280W cooling, near-0 idle → anything above 10W = compressor on.
 */
export const POWER_THRESHOLDS = {
  glycol: { on: 200 },
  kegerator: { on: 10 },
} as const;

/** Tilt entity IDs follow TiltPi's color convention. */
export function tiltEntities(color: TiltColor) {
  const c = color.toLowerCase();
  return {
    gravity: `sensor.tilt_${c}_gravity`,
    temperature: `sensor.tilt_${c}_temperature`,
  };
}

/**
 * Long-term statistics sensors for a Tilt. These derive from ONE Tilt's history.
 * Today only un-namespaced, Black-derived sensors exist (`sensor.tilt_gravity_
 * 24h_stat` etc). When more Tilts are added they should get per-color siblings
 * (`sensor.tilt_purple_gravity_24h_stat`). We return BOTH the preferred per-color
 * id and the legacy fallback; the hook tries per-color first, then falls back to
 * the legacy id ONLY for Black (so a Purple batch never shows Black's velocity).
 */
export function tiltStatEntities(color: TiltColor) {
  const c = color.toLowerCase();
  const isBlack = color === 'Black';
  const pick = (perColor: string, legacy: string) => ({
    preferred: perColor,
    fallback: isBlack ? legacy : null,
  });
  return {
    gravity24hChange: pick(`sensor.tilt_${c}_gravity_24h_stat`, 'sensor.tilt_gravity_24h_stat'),
    gravity3hStddev: pick(`sensor.tilt_${c}_gravity_3h_stddev`, 'sensor.tilt_gravity_3h_stddev'),
    beerTemp24hMin: pick(`sensor.tilt_${c}_beer_temp_24h_min`, 'sensor.beer_temp_24h_min'),
    beerTemp24hMax: pick(`sensor.tilt_${c}_beer_temp_24h_max`, 'sensor.beer_temp_24h_max'),
  };
}

export const ALL_TILT_COLORS: TiltColor[] = [
  'Black', 'Purple', 'Red', 'Green', 'Orange', 'Blue', 'Yellow', 'Pink',
];

/**
 * Optional HA-side DERIVED sensors (from ha/glasshaus_derived.yaml) that the app
 * surfaces when present. These are stateful/time-integrated things HA does
 * better than a per-render app calc (projected date, pace vs schedule, and the
 * settling-proof fermentation-start latch). All are optional — the app degrades
 * gracefully if the package isn't installed.
 *
 * Per-tank by convention; today only the Tank-1 / global variants exist, so we
 * return the preferred per-tank id plus a legacy fallback (same pattern as the
 * Tilt stat sensors). Add per-tank YAML later and the fallback drops away.
 */
/**
 * The ONE generic per-tank derived entity, written by the programs container's
 * deriveTank() loop. Its ATTRIBUTES carry everything the app used to read from a
 * dozen Black-only sensors: attenuationPct, progressToFgPct, dropFromPeakPts,
 * daysToTerminal, projectedFgReach, tiltProbeDeltaF, gravityAgeMin,
 * fermentationStarted (latched), activelyFermenting, alerts[]. Generic for every
 * tank — no per-tank YAML, no Tank-1 fallback hack. (Replaced derivedEntities().)
 */
export function derivedEntity(tankId: string): string {
  return `sensor.${tankId}_derived`;
}

/** Plant-wide diagnostic sensors (not per-tank). NOTE: there's deliberately no
 *  "Tilt vs Brewfather gap" — the Tilt IS Brewfather's gravity source, so that
 *  comparison only measures Brewfather's polling lag, not a real discrepancy. */
export const PLANT_DIAG = {
  compressorCycles1h: 'sensor.glycol_compressor_cycles_1h',
  // "Tank 1 Cooling Runtime" is actually the SHARED glycol chiller's runtime
  // (it keys off binary_sensor.glycol_chiller_running_power), so it's plant-wide,
  // not per-tank — surfaced in the top strip next to the chiller, not on cards.
  chillerRuntime7d: 'sensor.tank_1_cooling_runtime_7d',
} as const;

/**
 * Tilt "signal lost" alert — keyed by TILT COLOR, not tank (the sensor lives with
 * the Tilt, which floats between tanks). Resolved through the tank's assigned
 * color. Today only Black exists; per-color when more Tilts are added.
 */
export function tiltSignalLostEntity(color: TiltColor): string {
  return `binary_sensor.tilt_${color.toLowerCase()}_signal_lost`;
}
