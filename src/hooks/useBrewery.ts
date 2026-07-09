/**
 * The bridge from hakit's raw entity states into our domain model.
 * Everything above this layer works in Tank/Tilt/ActiveBatch terms and never
 * touches an entity string.
 */

import { useEntity, useHass, type EntityName } from '@hakit/core';
import { useEffect, useMemo, useRef } from 'react';
import {
  Tank, TankStatus, TiltDevice, GlycolLoop, BrewfatherBatch, BatchReading,
  ActiveBatch, TiltColor, CADENCE, Reading, EquipmentPower, PowerState, EnergyUsage,
  TankAlert, isActiveBrew,
} from '../types/domain';
import { toReading, composeBatch, normalizeReading } from '../data/derive';
import {
  TANKS, PLANT, PLANT_DIAG, KEGERATOR, POWER_THRESHOLDS, tankControllerEnergy,
  tiltEntities, tiltStatEntities, derivedEntity, tiltSignalLostEntity,
  ALL_TILT_COLORS, TankConfig,
} from '../data/registry';
import { useBreweryActions } from './useBreweryActions';

// Small helper: pull a hakit entity safely (it throws if the id is unknown,
// so we guard with a try and treat missing as "not present yet").
function safeEntity(id: string) {
  try {
    // This app builds entity IDs at runtime from the registry, so we opt out of
    // hakit's literal-EntityName checking here (cast is intentional, one place).
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useEntity(id as EntityName, { returnNullIfNotFound: true });
  } catch {
    return null;
  }
}

const c2f = (c: number) => c * 9 / 5 + 32;

// ---------------------------------------------------------------------------
// Tank
// ---------------------------------------------------------------------------

export function useTank(cfg: TankConfig): Tank {
  const probe = safeEntity(cfg.probeC);
  const setRaw = safeEntity(cfg.setpointRaw);
  const status = safeEntity(cfg.status);
  const cleaned = safeEntity(cfg.cleaned);

  return useMemo(() => {
    const hasController = probe != null && setRaw != null;

    // ITC-308 reports on-change, so a steady temp has an old last_updated but is
    // NOT offline. Use availability-based freshness (live while HA has a value).
    const probeReading = toReading(
      cfg.probeC, probe?.state, probe?.last_updated, CADENCE.itc308,
      (s) => c2f(Number(s)), undefined, 'availability',
    );
    const setpointReading = toReading(
      cfg.setpointRaw, setRaw?.state, setRaw?.last_updated, CADENCE.itc308,
      (s) => Number(s) / 10, undefined, 'availability',
    );

    const lastCleanedMs = cleaned?.state ? Date.parse(cleaned.state) : null;
    const daysSinceCleaned = lastCleanedMs != null
      ? Math.floor((Date.now() - lastCleanedMs) / 86_400_000)
      : null;

    return {
      id: cfg.id,
      label: cfg.label,
      status: (status?.state as TankStatus) ?? 'Ready',
      statusEntityId: cfg.status,
      lastCleaned: lastCleanedMs,
      cleanedEntityId: cfg.cleaned,
      daysSinceCleaned,
      hasController,
      probeTemp: probeReading,
      setpoint: setpointReading,
      setpointRawEntityId: cfg.setpointRaw,
    };
  }, [cfg, probe?.state, probe?.last_updated, setRaw?.state, setRaw?.last_updated,
      status?.state, cleaned?.state]);
}

export function useAllTanks(): Tank[] {
  // Fixed-length registry → stable hook order.
  return TANKS.map(useTank);
}

// ---------------------------------------------------------------------------
// Tilt — only returns colors currently broadcasting (present + not stale-dead)
// ---------------------------------------------------------------------------

export function useTilt(color: TiltColor): TiltDevice | null {
  const ids = tiltEntities(color);
  const stats = tiltStatEntities(color);
  const grav = safeEntity(ids.gravity);
  const temp = safeEntity(ids.temperature);

  // Stats: read the preferred per-color sensor AND (for Black) the legacy
  // un-namespaced one. Both reads are unconditional to keep hook order stable.
  const g24Pref = safeEntity(stats.gravity24hChange.preferred);
  const g24Fall = safeEntity(stats.gravity24hChange.fallback ?? 'sensor.__none__');
  const sdPref = safeEntity(stats.gravity3hStddev.preferred);
  const sdFall = safeEntity(stats.gravity3hStddev.fallback ?? 'sensor.__none__');
  const tMinPref = safeEntity(stats.beerTemp24hMin.preferred);
  const tMinFall = safeEntity(stats.beerTemp24hMin.fallback ?? 'sensor.__none__');
  const tMaxPref = safeEntity(stats.beerTemp24hMax.preferred);
  const tMaxFall = safeEntity(stats.beerTemp24hMax.fallback ?? 'sensor.__none__');

  return useMemo(() => {
    if (grav == null && temp == null) return null;
    const gravity = toReading(ids.gravity, grav?.state, grav?.last_updated, CADENCE.tilt);
    // Tilt temp uses a longer cadence — it changes slowly so last_updated lags.
    const temperature = toReading(ids.temperature, temp?.state, temp?.last_updated, CADENCE.tiltTemp);
    // a Tilt whose entities exist but read dead for a long time is "not present"
    if (gravity.value == null && temperature.value == null) return null;

    // For each stat, prefer the per-color entity; if it has no value, fall back
    // to the legacy (Black-only) entity. Returns null if neither resolves.
    const stat = (
      prefId: string, pref: typeof grav,
      fallId: string | null, fall: typeof grav,
    ): Reading<number> | null => {
      const p = toReading(prefId, pref?.state, pref?.last_updated, CADENCE.tilt);
      if (p.value != null) return p;
      if (fallId) {
        const f = toReading(fallId, fall?.state, fall?.last_updated, CADENCE.tilt);
        if (f.value != null) return f;
      }
      return null;
    };

    return {
      color,
      gravity,
      temperature,
      gravity24hChange: stat(stats.gravity24hChange.preferred, g24Pref, stats.gravity24hChange.fallback, g24Fall),
      gravity3hStddev: stat(stats.gravity3hStddev.preferred, sdPref, stats.gravity3hStddev.fallback, sdFall),
      beerTemp24hMin: stat(stats.beerTemp24hMin.preferred, tMinPref, stats.beerTemp24hMin.fallback, tMinFall),
      beerTemp24hMax: stat(stats.beerTemp24hMax.preferred, tMaxPref, stats.beerTemp24hMax.fallback, tMaxFall),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color, grav?.state, grav?.last_updated, temp?.state, temp?.last_updated,
      g24Pref?.state, g24Fall?.state, sdPref?.state, sdFall?.state,
      tMinPref?.state, tMinFall?.state, tMaxPref?.state, tMaxFall?.state]);
}

export function useLiveTilts(): TiltDevice[] {
  const tilts = ALL_TILT_COLORS.map(useTilt);
  return tilts.filter((t): t is TiltDevice => t != null);
}

// ---------------------------------------------------------------------------
// Glycol (shared)
// ---------------------------------------------------------------------------

export function useGlycol(): GlycolLoop {
  const temp = safeEntity(PLANT.glycolTemp);
  const comp = safeEntity(PLANT.glycolCompressor);
  const chillerSwitch = safeEntity(PLANT.glycolChillerSwitch);
  const power = safeEntity(PLANT.glycolPlugPower);

  return useMemo(() => {
    // availability mode: a steady wattage (e.g. flat idle draw) reports on-change,
    // so its last_updated lags — that's not "stale", it's just not changing.
    const powerW = power
      ? toReading(PLANT.glycolPlugPower, power.state, power.last_updated,
          CADENCE.glycol, undefined, undefined, 'availability')
      : null;

    // Truth precedence, best → worst:
    //   1) PLUG WATTAGE — the switch reports 'on' even when the compressor is
    //      idle (verified: switch=on while plug drew 0.8W). Wattage is ground truth.
    //   2) compressor binary_sensor — the intended signal, but often 'unavailable'.
    //   3) chiller switch — last resort so the header isn't dark; can over-report.
    let compressorRunning: boolean | null = null;
    let compressorSource: 'plug' | 'binary_sensor' | 'switch' | null = null;
    const compUsable = comp && comp.state !== 'unavailable' && comp.state !== 'unknown';

    if (powerW && powerW.value != null && powerW.staleness !== 'dead') {
      compressorRunning = powerW.value >= POWER_THRESHOLDS.glycol.on;
      compressorSource = 'plug';
    } else if (compUsable) {
      compressorRunning = comp!.state === 'on';
      compressorSource = 'binary_sensor';
    } else if (chillerSwitch && chillerSwitch.state !== 'unavailable') {
      compressorRunning = chillerSwitch.state === 'on';
      compressorSource = 'switch';
    }

    return {
      reservoirTemp: toReading(PLANT.glycolTemp, temp?.state, temp?.last_updated, CADENCE.glycol),
      compressorRunning,
      compressorSource,
      powerW,
      demandingTankIds: [], // filled in by the Overview from live tank readings
    };
  }, [temp?.state, temp?.last_updated, comp?.state, chillerSwitch?.state,
      power?.state, power?.last_updated]);
}

// ---------------------------------------------------------------------------
// Equipment power — wattage-derived state for plugged devices
// ---------------------------------------------------------------------------

/** Temperature context used to disambiguate heat vs cool when wattage can't. */
interface TempContext {
  probeF: number | null;
  setpointF: number | null;
  /** ±°F around setpoint that counts as "holding" (no clear direction). */
  deadbandF: number;
}

/**
 * Classify a wattage reading into a PowerState.
 *
 * Wattage bands are the PRIMARY signal: below `cool` = idle; at/above `heat`
 * (when set) = heating; otherwise cooling. This is clean once the heater and
 * pump draws are well separated (e.g. Tank 1's NEW 120W heater vs ~25W pump).
 *
 * The catch: some setups have OVERLAPPING draws — Tank 1's OLD ~22W heater sits
 * right on top of its ~25W pump, so a mid-band draw could be either. Only in
 * that ambiguous middle zone (between `cool` and `heat`) do we fall back to the
 * temperature TIEBREAKER: probe above setpoint+deadband ⇒ cooling, below
 * setpoint−deadband ⇒ heating, within deadband ⇒ holding. Clear high-wattage
 * heating (≥ `heat`) never needs the tiebreaker. If no temp context is
 * available, the ambiguous zone defaults to cooling (the historical behavior).
 */
function classifyPower(
  r: Reading<number>,
  bands: { cool: number; heat: number | null },
  temp?: TempContext,
): PowerState {
  if (r.value == null || r.staleness === 'dead') return 'unknown';
  const w = r.value;
  if (w < bands.cool) return 'idle';
  // unambiguous heating band (well-separated heater) — trust wattage
  if (bands.heat != null && w >= bands.heat) return 'heating';
  // ambiguous "something is running" zone: use temperature as the tiebreaker
  if (temp && temp.probeF != null && temp.setpointF != null) {
    const delta = temp.probeF - temp.setpointF;
    if (delta > temp.deadbandF) return 'cooling';   // too warm → pulling heat out
    if (delta < -temp.deadbandF) return 'heating';  // too cold → adding heat
    return 'holding';                               // at setpoint, drawing anyway
  }
  return 'cooling'; // no temp context → historical default
}

/**
 * Live power state of the always-on plant equipment (kegerator + glycol chiller)
 * plus any tank whose ITC-308 is on a plug. Returns only the equipment whose
 * plug currently resolves — a missing plug simply doesn't appear.
 */
/** Plant-wide glycol compressor cycles in the last hour (short-cycling signal).
 *  Shared across tanks; read once and passed down. null if sensor absent. */
/** The latest LLM insight (from the analyzer container's sensor.glasshaus_insight).
 *  null when the entity doesn't exist yet / analyzer not deployed. */
export interface Insight {
  severity: 'info' | 'watch' | 'problem';
  headline: string;
  detail: string;
  action: string;
  /** epoch ms the entity last changed — used to detect "new" for auto-popup */
  updatedAt: number | null;
}

export function useInsight(): Insight | null {
  const e = safeEntity(PLANT.insight);
  return useMemo(() => {
    const st = e?.state;
    if (st == null || st === 'unknown' || st === 'unavailable' || st === '') return null;
    const a = (e?.attributes as any) || {};
    const sev = a.severity;
    return {
      severity: (sev === 'problem' || sev === 'watch') ? sev : 'info',
      headline: st,
      detail: a.detail || '',
      action: a.action || '',
      updatedAt: e?.last_changed ? Date.parse(e.last_changed) : null,
    };
  }, [e?.state, e?.last_changed, e?.attributes]);
}

/** Plant-wide glycol chiller diagnostics (shared loop, NOT per-tank): compressor
 *  cycles in the last hour (short-cycling signal) + total runtime over 7 days.
 *  Surfaced in the top strip next to the chiller chip. null when sensor absent. */
export function usePlantDiag(): { cycles1h: number | null; runtime7dH: number | null } {
  const cyc = safeEntity(PLANT_DIAG.compressorCycles1h);
  const run = safeEntity(PLANT_DIAG.chillerRuntime7d);
  return useMemo(() => {
    const num = (s: string | undefined) =>
      s != null && s !== 'unknown' && s !== 'unavailable' ? Number(s) : null;
    return { cycles1h: num(cyc?.state), runtime7dH: num(run?.state) };
  }, [cyc?.state, run?.state]);
}

export function useEquipment(): EquipmentPower[] {
  const keg = safeEntity(KEGERATOR.power);
  const kegToday = safeEntity(KEGERATOR.energyToday);
  const kegTotal = safeEntity(KEGERATOR.energyTotal);
  const glycol = safeEntity(PLANT.glycolPlugPower);
  const glycolToday = safeEntity(PLANT.glycolEnergyToday);
  const glycolTotal = safeEntity(PLANT.glycolEnergyTotal);
  // Per-tank controller plugs — read all at top level (fixed registry length →
  // stable hook order), even when the plug id is null (safeEntity tolerates it).
  const tankPlugs = TANKS.map((cfg) =>
    safeEntity(cfg.controllerPower ?? 'sensor.__none__'),
  );
  const tankEnergy = TANKS.map((cfg) => {
    const ids = tankControllerEnergy(cfg);
    return {
      today: safeEntity(ids?.today ?? 'sensor.__none__'),
      total: safeEntity(ids?.total ?? 'sensor.__none__'),
    };
  });
  // probe (°C) + setpoint (×10) per tank — the temperature tiebreaker for
  // heat-vs-cool when a controller's heater/pump wattage bands overlap.
  const tankProbe = TANKS.map((cfg) => safeEntity(cfg.probeC));
  const tankSetpt = TANKS.map((cfg) => safeEntity(cfg.setpointRaw));

  return useMemo(() => {
    const out: EquipmentPower[] = [];
    // Wattage/energy report on-change, so use availability freshness — a flat
    // draw isn't stale, and a truly gone plug reads 'unknown'.
    const av = (id: string, e: ReturnType<typeof safeEntity>) =>
      toReading(id, e?.state, e?.last_updated, CADENCE.glycol, undefined, undefined, 'availability');

    const energy = (
      todayId: string, today: ReturnType<typeof safeEntity>,
      totalId: string, total: ReturnType<typeof safeEntity>,
    ): EnergyUsage | null =>
      (today || total)
        ? { todayKwh: av(todayId, today), lifetimeKwh: av(totalId, total) }
        : null;

    if (keg) {
      const r = av(KEGERATOR.power, keg);
      out.push({
        id: 'kegerator', label: KEGERATOR.label,
        state: classifyPower(r, { cool: POWER_THRESHOLDS.kegerator.on, heat: null }),
        powerW: r,
        energy: energy(KEGERATOR.energyToday, kegToday, KEGERATOR.energyTotal, kegTotal),
      });
    }

    if (glycol) {
      const r = av(PLANT.glycolPlugPower, glycol);
      out.push({
        id: 'glycol', label: 'Glycol Chiller',
        state: classifyPower(r, { cool: POWER_THRESHOLDS.glycol.on, heat: null }),
        powerW: r,
        energy: energy(PLANT.glycolEnergyToday, glycolToday, PLANT.glycolEnergyTotal, glycolTotal),
      });
    }

    TANKS.forEach((cfg, i) => {
      if (!cfg.controllerPower) return;
      const e = tankPlugs[i];
      if (!e) return;
      const r = av(cfg.controllerPower, e);
      const id = `${cfg.id}_controller`;
      const eids = tankControllerEnergy(cfg);
      // temp tiebreaker context: probe (°C→°F) vs setpoint (raw ÷10)
      const pRaw = tankProbe[i]?.state;
      const sRaw = tankSetpt[i]?.state;
      const usable = (s: string | undefined) => s != null && s !== 'unknown' && s !== 'unavailable';
      const temp: TempContext = {
        probeF: usable(pRaw) ? c2f(Number(pRaw)) : null,
        setpointF: usable(sRaw) ? Number(sRaw) / 10 : null,
        deadbandF: 0.5,
      };
      out.push({
        id, label: `${cfg.label} Controller`,
        state: classifyPower(r, cfg.controllerBands, temp),
        powerW: r,
        energy: eids
          ? energy(eids.today, tankEnergy[i].today, eids.total, tankEnergy[i].total)
          : null,
      });
    });

    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keg?.state, keg?.last_updated, glycol?.state, glycol?.last_updated,
      kegToday?.state, kegTotal?.state, glycolToday?.state, glycolTotal?.state,
      ...tankPlugs.map((p) => p?.state), ...tankPlugs.map((p) => p?.last_updated),
      ...tankEnergy.map((t) => t.today?.state), ...tankEnergy.map((t) => t.total?.state),
      ...tankProbe.map((p) => p?.state), ...tankSetpt.map((s) => s?.state)]);
}

// ---------------------------------------------------------------------------
// Brewfather batches (from the all_batches_data attribute)
// ---------------------------------------------------------------------------

export function useBrewfatherBatches(): BrewfatherBatch[] {
  const all = safeEntity(PLANT.brewfatherAll);
  return useMemo(() => {
    const data = (all?.attributes as any)?.data as any[] | undefined;
    if (!Array.isArray(data)) return [];
    return data.map((b): BrewfatherBatch => {
      const rawReadings = Array.isArray(b.readings) ? b.readings : [];
      const history = rawReadings
        .map((r: any) => normalizeReading(r))
        .filter((r: BatchReading | null): r is BatchReading => r != null)
        .sort((a: BatchReading, z: BatchReading) => a.t - z.t);
      // readings[].id is the Tilt color/id the history came from (e.g. 'BLACK')
      const readingTiltId = rawReadings.length
        ? String(rawReadings[0].id ?? '').toUpperCase() || null
        : null;
      // target_temperature in data[] is °C
      const targetC = b.target_temperature != null ? Number(b.target_temperature) : null;
      return {
        batchNo: Number(b.batchNo ?? 0),
        name: String(b.name ?? 'Unknown'),
        status: String(b.status ?? ''),
        measuredOg: b.measuredOg != null ? Number(b.measuredOg) : null,
        fermentingStart: b.fermentingStart ? Date.parse(b.fermentingStart) : null,
        fermentingEnd: b.fermentingEnd ? Date.parse(b.fermentingEnd) : null,
        fermentingLeft: b.fermentingLeft != null ? Number(b.fermentingLeft) : null,
        targetTemp: targetC != null
          ? { value: c2f(targetC), updatedAt: null, staleness: 'live', entityId: `${PLANT.brewfatherAll}:target` }
          : null,
        readingTiltId,
        history,
      };
    });
  }, [all?.state, all?.attributes]);
}

// ---------------------------------------------------------------------------
// Assignment helpers (the human-declared join key) — read per tank at the top
// level, NOT inside a map callback, so hook order depends only on the fixed
// TANKS registry length and stays valid when tanks/tilts become dynamic.
// ---------------------------------------------------------------------------

interface AssignmentInputs {
  tiltSel: string | undefined;   // raw input_select.tank_N_tilt state
  batchSel: string | undefined;  // raw input_select.tank_N_batch state
  expectedFg: number | null;
  /** epoch ms the assignment was last declared — from the tilt/batch helpers'
   *  last_changed, whichever is newer. This is the real "assignedAt", not now(). */
  assignedAt: number | null;
  // optional HA-derived signals (null when the derived package isn't installed)
  fermentationStarted: boolean | null;
  projectedFgReach: string | null;
  paceVsSchedule: number | null;
  /** active tank-scoped alerts (from HA alert binary_sensors). Signal-lost is
   *  added later in useActiveBatches (it's keyed by the resolved Tilt color). */
  alerts: TankAlert[];
  // extra diagnostics for the card's 3rd metric row (null when unavailable)
  gravityDropFromPeak: number | null;  // pts below 8h peak
  tiltGravityAgeMin: number | null;    // minutes since last Tilt reading
  stableDays: number | null;           // days gravity has held terminal-stable
  terminalConfirmed: boolean;          // stable ≥ required window (3d, 6d dry-hop)
}

function useTankAssignmentInputs(cfg: TankConfig): AssignmentInputs {
  const tilt = safeEntity(cfg.tiltAssign);
  const batch = safeEntity(cfg.batchAssign);
  const fg = safeEntity(`input_number.${cfg.id}_expected_fg`);
  // ONE generic derived entity (written by the programs container's deriveTank).
  // Its attributes carry everything the app used to read from a dozen sensors.
  const derived = safeEntity(derivedEntity(cfg.id));

  return useMemo(() => {
    const changed = [tilt?.last_changed, batch?.last_changed]
      .map((s) => (s ? Date.parse(s) : null))
      .filter((n): n is number => n != null);

    // pull derived values from the entity's attributes; null-safe when absent
    // (container not deployed yet / tank has no data → app degrades gracefully).
    const a = (derived?.attributes as any) || {};
    const numAttr = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const rawAlerts = Array.isArray(a.alerts) ? a.alerts : [];
    const alerts: TankAlert[] = rawAlerts.map((x: any) => ({
      key: String(x.key), severity: x.severity, label: String(x.label),
      entityId: derivedEntity(cfg.id),
    }));

    return {
      tiltSel: tilt?.state,
      batchSel: batch?.state,
      expectedFg: fg?.state ? Number(fg.state) : null,
      assignedAt: changed.length ? Math.max(...changed) : null,
      fermentationStarted: typeof a.fermentationStarted === 'boolean' ? a.fermentationStarted : null,
      projectedFgReach: typeof a.projectedFgReach === 'string' ? a.projectedFgReach : null,
      paceVsSchedule: numAttr(a.paceVsSchedule),
      alerts,
      gravityDropFromPeak: numAttr(a.dropFromPeakPts),
      tiltGravityAgeMin: numAttr(a.gravityAgeMin),
      stableDays: numAttr(a.stableDays),
      terminalConfirmed: a.terminalConfirmed === true,
    };
  }, [tilt?.state, tilt?.last_changed, batch?.state, batch?.last_changed, fg?.state,
      derived?.state, derived?.attributes]);
}

// ---------------------------------------------------------------------------
// The composed view — the array the Overview stack renders
// ---------------------------------------------------------------------------

/** Read the per-color "signal lost" alert sensors for every known Tilt color at
 *  the top level (fixed list → stable hook order), returning color→isOn. Signal-
 *  lost is keyed by Tilt (which floats between tanks), so it's resolved by the
 *  tank's assigned color in useActiveBatches. */
function useSignalLostByColor(): Record<string, boolean> {
  const ents = ALL_TILT_COLORS.map((c) => safeEntity(tiltSignalLostEntity(c)));
  return useMemo(() => {
    const out: Record<string, boolean> = {};
    ALL_TILT_COLORS.forEach((c, i) => { out[c] = ents[i]?.state === 'on'; });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...ents.map((e) => e?.state)]);
}

export function useActiveBatches(): { tanks: Tank[]; batches: (ActiveBatch | null)[] } {
  const tanks = useAllTanks();
  const tilts = useLiveTilts();
  const bfBatches = useBrewfatherBatches();
  // Fixed-length registry → stable hook order (same guarantee as useAllTanks).
  const assignments = TANKS.map(useTankAssignmentInputs);
  const signalLostByColor = useSignalLostByColor();

  // Pure map over already-read values — no hooks in this callback.
  const batches = tanks.map((tank, i) => {
    const { tiltSel, batchSel, expectedFg, assignedAt,
      fermentationStarted, projectedFgReach, paceVsSchedule, alerts: tankAlerts,
      gravityDropFromPeak, tiltGravityAgeMin, stableDays, terminalConfirmed } = assignments[i];

    // "None"/"none" (either casing) both mean "no Tilt assigned" — the HA
    // helper uses 'None', batch helpers use 'none'; tolerate both.
    const tiltColor = tiltSel && tiltSel.toLowerCase() !== 'none' ? (tiltSel as TiltColor) : null;

    // EXPLICIT ONLY: a tank's batch comes from its assignment helper, matched to a
    // Brewfather batch. No inference/guessing — with >1 fermenting batch guessing is
    // useless, and even with one it's better to be explicit. Unassigned → no batch
    // (card shows "⚠ Batch unassigned — Manage to pick"). Assign via ⚙ Manage.
    const bf = bfBatches.find(
      (b) => b.name === batchSel || String(b.batchNo) === batchSel,
    ) ?? null;
    const joinSource: 'assigned' | 'inferred' | 'none' = bf ? 'assigned' : 'none';

    // Tilt comes only from the explicit tilt assignment.
    const resolvedColor = tiltColor;
    const tilt = resolvedColor ? tilts.find((t) => t.color === resolvedColor) ?? null : null;

    const assignment = {
      tankId: tank.id,
      batchNo: bf?.batchNo ?? null,
      tiltColor: resolvedColor,
      assignedAt: assignedAt ?? bf?.fermentingStart ?? 0,
      // placeholder — composeBatch() recomputes this via verifyAssignment()
      // (probe-vs-Tilt temp agreement); this value is never displayed.
      verification: { status: 'unverified' as const },
    };

    const composed = composeBatch(assignment, tank, tilt, bf, expectedFg, joinSource);
    // Attach the optional HA-derived signals (null when the package isn't
    // installed). Kept out of composeBatch() so its pure signature stays lean.
    if (composed) {
      composed.fermentationStarted = fermentationStarted;
      composed.projectedFgReach = projectedFgReach;
      composed.paceVsSchedule = paceVsSchedule;
      composed.gravityDropFromPeak = gravityDropFromPeak;
      composed.tiltGravityAgeMin = tiltGravityAgeMin;
      composed.stableDays = stableDays;
      composed.terminalConfirmed = terminalConfirmed;

      // Assemble alerts: the tank-scoped HA sensors + signal-lost (resolved via
      // the assigned Tilt color) + the app's OWN client-side suspect check (in
      // case the HA sensor is absent). De-dup assignment_suspect by key.
      const alerts: TankAlert[] = [...tankAlerts];
      if (resolvedColor && signalLostByColor[resolvedColor]) {
        alerts.push({
          key: 'signal_lost', severity: 'warning', label: `${resolvedColor.toUpperCase()} TILT SIGNAL LOST`,
          entityId: tiltSignalLostEntity(resolvedColor),
        });
      }
      // client-side plausibility check (works even without the HA package)
      if (composed.verification.status === 'suspect'
          && !alerts.some((x) => x.key === 'assignment_suspect')) {
        alerts.push({
          key: 'assignment_suspect', severity: 'problem', label: 'ASSIGNMENT SUSPECT',
          entityId: 'app:verifyAssignment',
        });
      }
      // most-severe first: problem > warning > milestone
      const rank = { problem: 0, warning: 1, milestone: 2 } as const;
      alerts.sort((x, y) => rank[x.severity] - rank[y.severity]);
      composed.alerts = alerts;
    }
    return composed;
  });

  return { tanks, batches };
}


// ---------------------------------------------------------------------------
// Batch-option sync — keep each tank's batch picker in step with Brewfather
// ---------------------------------------------------------------------------

const BATCH_NONE = 'None';

/**
 * Reconciles every tank's `input_select.tank_N_batch` options to the LIVE set of
 * Fermenting batches from Brewfather (+ 'None'), so the assignment picker always
 * offers the real, current beers with zero manual maintenance — the thing that
 * lets this scale from 1 to 5+ fermenting batches.
 *
 * NON-DESTRUCTIVE by design (this used to disconnect batches from tanks):
 *  - The currently-SELECTED batch is ALWAYS kept in the options, even if Brewfather
 *    momentarily doesn't list it as Fermenting (post-reboot resync, a status flicker,
 *    or Brewfather reordering its array). Pruning the selected value makes HA reset
 *    the selection to 'None' → the tank loses its batch → OG/pace go blank. We refuse.
 *  - Options are compared as a SET and written SORTED, so a mere reorder from
 *    Brewfather never triggers a rewrite (and thus never resets the selection).
 *  - We only write set_options when the option SET genuinely differs.
 *
 * DEPARTURE ("batch came out of the fermenter") is now a deliberate, confirmed
 * signal only: the previously-selected batch must appear in the FULL batch list
 * with a non-Fermenting status (e.g. moved to Conditioning). A batch merely
 * *missing* from a partial/early Brewfather payload is NOT a departure — that was
 * the reboot false-positive that marked tanks Dirty. Fires once per real transition.
 */
export function useSyncBatchOptions(): void {
  const a = useBreweryActions();
  const bfBatches = useBrewfatherBatches();
  // read each tank's batch helper (options + current selection) at top level
  const batchHelpers = TANKS.map((cfg) => safeEntity(cfg.batchAssign));
  // remember the last selection we saw per tank, to detect a real departure
  const lastSel = useRef<Record<string, string | undefined>>({});

  const fermentingNames = useMemo(
    () => bfBatches.filter((b) => b.status === 'Fermenting').map((b) => b.name),
    [bfBatches],
  );
  // full name set (any status) — used to tell "moved to conditioning" (present but
  // not fermenting = real departure) apart from "missing from a partial payload".
  const allNames = useMemo(() => new Set(bfBatches.map((b) => b.name)), [bfBatches]);

  // stable dependency keys (arrays/objects change identity each render)
  const fermentingKey = [...fermentingNames].sort().join('|');
  const helperKey = batchHelpers
    .map((h) => `${h?.state ?? ''}:${(((h?.attributes as any)?.options as string[]) ?? []).slice().sort().join(',')}`)
    .join('||');

  useEffect(() => {
    // wait until Brewfather has actually reported (empty data early in load
    // shouldn't nuke everyone's options to just ['None'])
    if (bfBatches.length === 0) return;

    TANKS.forEach((cfg, i) => {
      const h = batchHelpers[i];
      if (!h) return; // helper not present (tank not configured) — skip
      const curOpts = ((h.attributes as any)?.options as string[]) ?? [];
      const curSel = h.state;

      // desired options = None + fermenting batches, ALWAYS union in the current
      // selection so we never prune what the tank is pointed at. Sorted → stable.
      const keepSelected =
        curSel && curSel !== BATCH_NONE && curSel !== 'none' ? [curSel] : [];
      const desired = [
        BATCH_NONE,
        ...Array.from(new Set([...fermentingNames, ...keepSelected])).sort(),
      ];

      // 1) reconcile only when the SET differs (order-insensitive), so Brewfather
      //    reordering never triggers a rewrite that could reset the selection.
      const curSet = new Set(curOpts);
      const setDiffers =
        curOpts.length !== desired.length || desired.some((o) => !curSet.has(o));
      if (setDiffers) {
        a.setBatchOptions(cfg.id, desired);
      }

      // 2) DEPARTURE — only a CONFIRMED transition: the previously-selected batch
      //    is still known to Brewfather (so this isn't a partial-payload gap) but is
      //    no longer Fermenting (moved to Conditioning/Completed = it came out).
      const prev = lastSel.current[cfg.id];
      const wasReal = prev != null && prev !== BATCH_NONE && prev !== 'none';
      const confirmedDeparture =
        wasReal && allNames.has(prev!) && !fermentingNames.includes(prev!);
      if (confirmedDeparture) {
        a.setBatch(cfg.id, BATCH_NONE); // release the fermenter
        a.setStatus(cfg.id, 'Dirty');   // freed fermenter needs cleaning
      }
      // only advance the remembered selection once Brewfather is fully present, so a
      // transient blip can't be recorded as the new baseline and misread next tick.
      if (allNames.size > 0) lastSel.current[cfg.id] = curSel;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fermentingKey, helperKey, bfBatches.length]);
}

