/**
 * Direct HA REST state source — the reliable read path.
 *
 * WHY THIS EXISTS
 * ---------------
 * hakit's client-side entity subscription (`useEntity`) has proven unreliable in
 * this app on two separate fronts:
 *   1. WRITES — hakit's `callService` silently produced ZERO outbound HA traffic
 *      (verified in the Network tab). Fixed by writing via HA REST directly.
 *   2. READS — hakit's `useEntity` intermittently DROPPED entities that plainly
 *      exist in HA (e.g. Tank 2's `sensor.tank_2_probe_temp_c` +
 *      `number.tank_2_setpoint_raw` both present server-side, yet the app rendered
 *      "no controller"). We could never see WHICH entity it dropped because that
 *      state lives only in the browser's hakit store.
 *
 * Rather than keep guessing at hakit's client internals, we make HA's REST API the
 * source of truth for entity state — exactly as we did for writes. hakit's
 * `HassConnect` still owns the connection/token; we just stop trusting `useEntity`.
 *
 * A single interval poll of GET /api/states gives an authoritative snapshot of
 * every entity's { state, attributes, last_updated }. One fetch covers the whole
 * estate, so this is one request every POLL_MS, not one per entity. Any component
 * reads via `useHaEntity(id)`, which returns the same minimal shape the old
 * `useEntity` callers relied on ({ state, last_updated, attributes } | null).
 *
 * Same-origin note: in production the fetch goes through the nginx `/ha` proxy
 * (HA_STATES_BASE = '/ha') so there's no CORS; in dev it hits HA directly.
 */

import {
  createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { HA_STATES_BASE, HA_TOKEN } from '../config';

/** The minimal slice of an HA state object the app actually reads. */
export interface HaEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_updated: string;
  last_changed?: string;
}

type Snapshot = Map<string, HaEntityState>;

interface HaStatesValue {
  /** Look up one entity; null if absent from the latest snapshot. */
  get(id: string): HaEntityState | null;
  /** True once at least one poll has completed (avoids "everything missing" flash). */
  ready: boolean;
  /** ISO of the last successful poll, or null. For diagnostics/health. */
  lastFetchIso: string | null;
  /** Last poll error message, or null when healthy. For diagnostics/health. */
  error: string | null;
}

const EMPTY: HaStatesValue = {
  get: () => null,
  ready: false,
  lastFetchIso: null,
  error: null,
};

const HaStatesContext = createContext<HaStatesValue>(EMPTY);

// Poll cadence. HA's ITC-308 / Tilt sensors update on the order of seconds-to-
// minutes; a 5s poll of the full state list is cheap (one gzipped JSON request)
// and keeps the UI within a few seconds of live without hammering HA.
const POLL_MS = 5_000;

/**
 * Fetch the full HA state list once. Returns a fresh Map keyed by entity_id.
 * Throws on any non-2xx / network error so the caller can surface it.
 */
async function fetchStates(signal: AbortSignal): Promise<Snapshot> {
  const r = await fetch(`${HA_STATES_BASE}/api/states`, {
    headers: { Authorization: `Bearer ${HA_TOKEN}`, 'content-type': 'application/json' },
    signal,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`HA ${r.status}: ${body.slice(0, 120)}`);
  }
  const arr = (await r.json()) as HaEntityState[];
  const map: Snapshot = new Map();
  for (const e of arr) map.set(e.entity_id, e);
  return map;
}

/**
 * Provider: polls GET /api/states every POLL_MS and exposes a lookup.
 * Mount this INSIDE <HassConnect> (so the token/connection are established) but
 * ABOVE anything that reads entities.
 */
export function HaStatesProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => new Map());
  const [ready, setReady] = useState(false);
  const [lastFetchIso, setLastFetchIso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Keep the latest snapshot in a ref so `get` is stable and always current
  // without re-subscribing every consumer on each poll.
  const snapRef = useRef<Snapshot>(snapshot);
  snapRef.current = snapshot;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 8_000);
      try {
        const next = await fetchStates(ctrl.signal);
        if (stopped) return;
        setSnapshot(next);
        setReady(true);
        setLastFetchIso(new Date().toISOString());
        setError(null);
      } catch (e) {
        if (stopped) return;
        // Don't blank the snapshot on a transient failure — keep the last good
        // one so the UI stays populated across a blip. Just record the error.
        console.error('HA states poll failed', e);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        clearTimeout(to);
        if (!stopped) timer = setTimeout(tick, POLL_MS);
      }
    };

    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const value = useMemo<HaStatesValue>(() => ({
    get: (id: string) => snapRef.current.get(id) ?? null,
    ready,
    lastFetchIso,
    error,
  }), [ready, lastFetchIso, error, snapshot]);

  return <HaStatesContext.Provider value={value}>{children}</HaStatesContext.Provider>;
}

/** Access the poller's health/lookup directly (for a status widget). */
export function useHaStates(): HaStatesValue {
  return useContext(HaStatesContext);
}

/**
 * Drop-in replacement for hakit's `useEntity(id, {returnNullIfNotFound:true})`.
 * Returns the same minimal shape ({ state, last_updated, attributes }) or null.
 * Backed by the REST poll, NOT hakit's subscription.
 */
export function useHaEntity(id: string): HaEntityState | null {
  const { get } = useContext(HaStatesContext);
  const e = get(id);
  // Depend on the primitive fields so consumers re-render when THIS entity
  // changes, not on every poll of unrelated entities.
  return useMemo(
    () => e,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [e?.state, e?.last_updated, id],
  );
}
