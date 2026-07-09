/**
 * Full-plant Insights: fetches the analyzer container's /insights endpoint (a
 * plant summary + per-tank sections + an equipment-health section, all from one
 * Claude call). Opening the view shows the CACHED result instantly; refresh()
 * forces a live re-analysis (the ~5-10s Claude round-trip).
 *
 * This is a direct browser→analyzer fetch (analyzer sends CORS *). It does NOT go
 * through Home Assistant — the rich structured data lives only in the analyzer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ANALYZER_URL } from '../config';

export type Severity = 'info' | 'watch' | 'problem';

export interface Section {
  severity: Severity;
  headline: string;
  detail: string;
  action: string;
}
export interface TankSection extends Section {
  tank: string;
  batch: string | null;
}
export interface EquipmentFacts {
  glycol?: {
    reservoirTempF: number | null; powerW: number | null; running: boolean | null;
    cyclesPerHour: number | null; shortCycling: boolean | null; runtimeHrs7d: number | null;
  };
  kegerator?: { powerW: number | null; cooling: boolean | null; todayKwh: number | null };
  controllers?: Array<{
    tank: string; controllerW: number | null; probeTempF: number | null;
    setpointF: number | null; tiltSignalAgeMin: number | null; tiltSignalLost: boolean | null;
  }>;
}
export interface PlantAnalysis {
  generatedAt: string;
  trigger?: string;
  plantSummary: Section | null;
  tanks: TankSection[];
  equipment: Section | null;
  equipmentFacts?: EquipmentFacts;
}

interface State {
  data: PlantAnalysis | null;
  loading: boolean;   // a live refresh is in flight
  error: string | null;
}

export function useInsights(enabled: boolean) {
  const [state, setState] = useState<State>({ data: null, loading: false, error: null });
  const inFlight = useRef(false);

  const load = useCallback(async (refresh: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState((s) => ({ ...s, loading: refresh, error: null }));
    try {
      const url = `${ANALYZER_URL}/insights${refresh ? '?refresh=1' : ''}`;
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error(`analyzer HTTP ${res.status}`);
      const data = (await res.json()) as PlantAnalysis;
      setState({ data, loading: false, error: null });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: (e as Error).message }));
    } finally {
      inFlight.current = false;
    }
  }, []);

  // fetch the cached result once when the view is first opened
  useEffect(() => {
    if (enabled && !state.data && !state.error) load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return {
    data: state.data,
    loading: state.loading,
    error: state.error,
    refresh: () => load(true),
  };
}
