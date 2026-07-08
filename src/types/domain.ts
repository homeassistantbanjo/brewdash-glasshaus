/**
 * GlassHaus domain model
 * ----------------------
 * The hard problem in this app is NOT displaying a sensor. It's that a "batch"
 * of beer is assembled from three independent data sources that don't know
 * about each other:
 *
 *   1. Brewfather  — knows the recipe, OG, name, batch number, fermentation
 *                    schedule. Keyed by batchNo / _id. Polled every 15 min.
 *   2. Tilt        — knows live gravity + beer temp. Keyed by COLOR. No idea
 *                    which tank/batch it's floating in. Broadcasts continuously.
 *   3. ITC-308     — knows the tank's probe temp + setpoint. Keyed by device
 *                    slug (tank_1, tank_2...). No idea what beer is in it.
 *
 * The ONLY thing that ties them together is human knowledge declared on brew
 * day: "batch #144 is in Tank 1, tracked by the Black Tilt." That declaration
 * is the `TankAssignment`. Everything else derives.
 *
 * Design principle: every value carries its own freshness. A dashboard that
 * shows a stale number as if it were live is worse than showing nothing. So
 * raw readings are wrapped in `Reading<T>` which knows when it was last updated.
 */

// ---------------------------------------------------------------------------
// Freshness primitive
// ---------------------------------------------------------------------------

export type Staleness = 'live' | 'stale' | 'dead' | 'unknown';

export interface Reading<T> {
  value: T | null;
  /** epoch ms of the underlying entity's last_updated, or null if never seen */
  updatedAt: number | null;
  /** derived from updatedAt + the source's expected cadence */
  staleness: Staleness;
  /** raw HA entity id this came from, for diagnostics/drill-in */
  entityId: string;
}

/** Expected update cadence per source, used to compute staleness. ms. */
export const CADENCE = {
  tilt: 60_000,        // Tilt gravity broadcasts often; >2min quiet is suspicious
  tiltTemp: 900_000,   // Tilt TEMP changes slowly, so HA's last_updated lags —
                       //   a steady beer temp isn't a dead Tilt. 15min window.
  itc308: 60_000,      // LocalTuya scan_interval is 30s
  brewfather: 900_000, // 15 min poll
  glycol: 60_000,      // zigbee sensor
} as const;

// ---------------------------------------------------------------------------
// The three sources, normalized
// ---------------------------------------------------------------------------

export type TiltColor =
  | 'Black' | 'Purple' | 'Red' | 'Green'
  | 'Orange' | 'Blue' | 'Yellow' | 'Pink';

/** A physically-present, broadcasting Tilt. Absent from the map if silent. */
export interface TiltDevice {
  color: TiltColor;
  gravity: Reading<number>;      // specific gravity, e.g. 1.025
  temperature: Reading<number>;  // °F

  // Long-term stats (from HA statistics sensors). Per-color when those exist;
  // today only the un-namespaced Black-derived sensors exist, so these fall
  // back to Black and read null for other colors. See TiltStats wiring.
  gravity24hChange: Reading<number> | null;  // SG points change over 24h (velocity)
  gravity3hStddev: Reading<number> | null;   // SG noise/activity over 3h
  beerTemp24hMin: Reading<number> | null;    // °F
  beerTemp24hMax: Reading<number> | null;    // °F
}

/**
 * A tank's lifecycle state — intrinsic to the vessel, persists across batches.
 * Drives the Overview stack: Fermenting = full row, Ready/Dirty = thin strip,
 * OutOfService = collapsed/hidden.
 */
export type TankStatus = 'Ready' | 'Fermenting' | 'Cold Crashing' | 'Dirty' | 'Out of Service';

/** True when the tank holds ACTIVE beer worth the full data card — fermenting OR
 *  cold-crashing (Tilt/controller still live, temp being managed). Ready/Dirty/
 *  Out-of-Service render as thin idle bays. Use this instead of === 'Fermenting'
 *  so cold-crash tanks aren't treated as empty. */
export function isActiveBrew(status: TankStatus): boolean {
  return status === 'Fermenting' || status === 'Cold Crashing';
}

/** A physical fermenter + its ITC-308 controller. Exists whether or not it
 *  has beer in it. A tank whose entities don't resolve yet renders as an
 *  empty bay ("no controller"), never an error. */
export interface Tank {
  id: string;            // 'tank_1'
  label: string;         // 'Tank 1' (user-facing, renameable later)

  /** lifecycle — read from input_select.tank_N_status, writable from the app */
  status: TankStatus;
  statusEntityId: string;       // 'input_select.tank_1_status'

  /** last cleaned date (epoch ms, date-only) from input_datetime.tank_N_last_cleaned */
  lastCleaned: number | null;
  cleanedEntityId: string;      // 'input_datetime.tank_1_last_cleaned'
  /** derived: whole days since cleaned, null if never/unknown */
  daysSinceCleaned: number | null;

  /** true when the ITC-308 entities resolve; false = empty bay, no hardware */
  hasController: boolean;
  probeTemp: Reading<number>;   // °F, from the ITC-308 probe
  setpoint: Reading<number>;    // °F, the target the controller holds
  /** the writable raw entity, ×10. Components write here; never shown raw. */
  setpointRawEntityId: string;  // 'number.tank_1_setpoint_raw'
}

/**
 * The glycol loop is a SHARED resource feeding all tanks — not a per-tank
 * sensor. Modeled separately so the plant view can show one reservoir/chiller
 * serving N tanks, and (later) reason about contention when multiple tanks
 * demand cooling at once.
 */
export interface GlycolLoop {
  reservoirTemp: Reading<number>;  // °F
  /** true = actively chilling. Prefers the plug's WATTAGE (real truth) over the
   *  chiller switch, which reports 'on' even when the compressor is idle. */
  compressorRunning: boolean | null;
  /** which entity the running-state came from, for diagnostics/UI honesty.
   *  'plug' = derived from wattage (preferred), else the switch/binary_sensor. */
  compressorSource: 'plug' | 'binary_sensor' | 'switch' | null;
  /** power draw once a plug exists; null until then */
  powerW: Reading<number> | null;
  /** tank ids currently demanding cooling (probe above setpoint + margin).
   *  Populated by the Overview from the tank readings — contention when >1. */
  demandingTankIds: string[];
}

// ---------------------------------------------------------------------------
// Equipment power states — derived from smart-plug wattage
// ---------------------------------------------------------------------------

/**
 * What a piece of temperature-control equipment is doing, inferred from its
 * smart-plug wattage. A switch says "powered"; wattage says "actually working".
 *
 *   idle    — plugged in, standby draw only
 *   cooling — chiller/pump/compressor running
 *   heating — heat element engaged (tank controller only)
 *   holding — drawing power but at setpoint (±deadband); direction ambiguous.
 *             Used when wattage says "active" but heater/pump watts overlap and
 *             probe≈setpoint, so we won't claim a direction.
 *   off     — plug reports off / no draw at all
 *   unknown — plug not present or reading unavailable
 */
export type PowerState = 'idle' | 'cooling' | 'heating' | 'holding' | 'off' | 'unknown';

/**
 * A piece of equipment on a monitored smart plug (kegerator, glycol chiller,
 * a tank's ITC-308). `state` is the wattage-derived verdict; `powerW` is the
 * live draw so the UI can show the number behind the verdict; `energy` carries
 * the plug's own kWh counters when present.
 */
export interface EquipmentPower {
  id: string;          // 'kegerator' | 'glycol' | 'tank_1_controller'
  label: string;       // 'Kegerator'
  state: PowerState;
  powerW: Reading<number>;
  /** plug kWh counters, null when the plug doesn't expose them */
  energy: EnergyUsage | null;
}

/** kWh counters straight off a smart plug (Tuya/local energy metering). */
export interface EnergyUsage {
  todayKwh: Reading<number>;     // resets at local midnight (total_increasing)
  lifetimeKwh: Reading<number>;  // cumulative since the plug started metering
}

/** A batch as Brewfather knows it. Pulled from all_batches_data / other_batches. */
export interface BrewfatherBatch {
  batchNo: number;
  name: string;              // 'Echoes of the Void 732026'
  status: string;            // 'Fermenting' | 'Conditioning' | ...
  measuredOg: number | null; // 1.0452
  fermentingStart: number | null; // epoch ms
  fermentingEnd: number | null;   // epoch ms — scheduled end from the profile
  /** days of fermentation remaining per the Brewfather schedule, null if unknown */
  fermentingLeft: number | null;
  /** target temp from the fermentation profile (data[].target_temperature, °C→°F).
   *  null when unknown. */
  targetTemp: Reading<number> | null;
  /** the Tilt color this batch's readings came from (readings[].id), if any */
  readingTiltId: string | null;
  /** full reading history, oldest→newest, normalized to app units */
  history: BatchReading[];
}

// ---------------------------------------------------------------------------
// The assignment — the human-declared join key
// ---------------------------------------------------------------------------

export interface TankAssignment {
  tankId: string;            // 'tank_1'
  batchNo: number | null;    // which Brewfather batch, or null if empty
  tiltColor: TiltColor | null; // which Tilt is floating in it, or null
  /** when this assignment was declared, for audit/expiry */
  assignedAt: number;
  /** result of the plausibility check (probe vs tilt temp agreement) */
  verification: AssignmentVerification;
}

export type AssignmentVerification =
  | { status: 'unverified' }                 // just declared, not yet checked
  | { status: 'verified'; checkedAt: number }// probe ≈ tilt temp
  | { status: 'suspect'; reason: string; deltaF: number }; // they disagree

// ---------------------------------------------------------------------------
// Alerts — active conditions surfaced from HA alert binary_sensors, routed to
// the tank/area they concern. Severity drives color; a 'milestone' is GOOD news
// (e.g. approaching terminal gravity = time to cold-crash), not a fault.
// ---------------------------------------------------------------------------

export type AlertSeverity = 'problem' | 'warning' | 'milestone';

export interface TankAlert {
  /** stable key, e.g. 'stalled' | 'temp_excursion' | 'approaching_terminal' */
  key: string;
  severity: AlertSeverity;
  /** short label shown on the card/bar, e.g. 'FERMENTATION STALLED' */
  label: string;
  /** which HA binary_sensor raised it (diagnostics/drill-in) */
  entityId: string;
}

// ---------------------------------------------------------------------------
// The composed object the UI actually consumes
// ---------------------------------------------------------------------------

/**
 * An ActiveBatch is the fully-joined view: everything the UI needs about one
 * fermenting beer, assembled from the three sources via its TankAssignment.
 * Derived metrics (ABV, attenuation, phase) are computed here, NOT read from
 * HA template sensors — the app owns the brewing math so it scales to N batches
 * without N sets of Jinja templates.
 */
export interface ActiveBatch {
  batchNo: number;
  name: string;
  tank: Tank;
  tiltColor: TiltColor | null;

  // live readings, freshness-wrapped, sourced via the assignment
  gravity: Reading<number>;
  beerTemp: Reading<number>;     // from the Tilt
  probeTemp: Reading<number>;    // from the ITC-308
  setpoint: Reading<number>;
  targetTemp: Reading<number> | null; // from Brewfather profile

  // recipe facts
  og: number | null;
  expectedFg: number | null;     // still user-declared per tank
  fermentingStart: number | null;

  // derived (computed in a selector, see data/deriveBatch.ts)
  abv: number | null;
  attenuation: number | null;
  daysFermenting: number | null;

  // --- velocity / trend / projection (the "sexy data") ---
  /** SG points/day, negative = attenuating. From Tilt 24h stat, +sign convention. */
  gravityVelocityPerDay: number | null;
  /** SG noise over 3h — high = active fermentation, ~0 = still */
  gravityNoise: number | null;
  /** progress toward expected FG, 0–100 */
  attenuationProgress: number | null;
  /** projected days until terminal gravity at current velocity, null if stalled */
  daysToTerminal: number | null;
  /** beer temp swing over last 24h [min,max] °F */
  beerTemp24h: { min: number | null; max: number | null };
  /** how the batch was joined — explicit assignment vs. inferred fallback */
  joinSource: 'assigned' | 'inferred' | 'none';

  // --- optional HA-derived signals (from ha/glasshaus_derived.yaml) ---
  /** settling-proof "fermentation has really started" latch; null if package
   *  not installed. When known, drives the vessel's active state. */
  fermentationStarted: boolean | null;
  /** projected calendar date reaching expected FG, e.g. 'Jul 8' / 'reached' /
   *  'stalled'; null if unavailable */
  projectedFgReach: string | null;
  /** days ahead(+)/behind(-) the Brewfather schedule; null if unavailable */
  paceVsSchedule: number | null;

  /** active alerts from HA alert binary_sensors, most-severe first. Empty when
   *  clear or the derived package isn't installed. Rendered on the tank card +
   *  counted in the top alert bar. */
  alerts: TankAlert[];

  // --- extra diagnostics (3rd card row); null when the package isn't installed ---
  /** SG points current gravity sits below its rolling 8h peak (settling-proof
   *  attenuation signal) */
  gravityDropFromPeak: number | null;
  /** minutes since the Tilt last pushed a gravity reading (freshness) */
  tiltGravityAgeMin: number | null;

  /** raw gravity/temp readings for inline sparklines, oldest→newest.
   *  Sourced from all_batches_data.readings[] (per-Tilt). */
  history: BatchReading[];

  verification: AssignmentVerification;
}

/** One historical Tilt reading, normalized to app units (°F, SG). */
export interface BatchReading {
  t: number;        // epoch ms
  sg: number;       // specific gravity
  tempF: number;    // °F
}
