import { useEffect, useState, useCallback } from 'react';
import { KEGS_URL } from '../config';

export interface SealHealth { replacedAt: string | null; ageDays: number | null; lifeDays: number | null; due: boolean; soon: boolean }
export interface KegHealth {
  seals: { lid: SealHealth; post: SealHealth; dip: SealHealth };
  cleanAgeDays: number | null; cleanExpired: boolean; anySealDue: boolean;
  warnings: { kind: string; sealType?: string; msg: string }[];
  severity: 'ok' | 'warning' | 'critical';
}
export interface Keg {
  id: string; label: string; type: string; size_l: number; status: string; tap: number | null;
  beer_batch: string | null; beer_style: string | null; beer_abv: number | null; filled_at: string | null;
  lid_seal_at: string | null; lid_seal_life: number; post_seal_at: string | null; post_seal_life: number;
  dip_seal_at: string | null; dip_seal_life: number; cleaned_at: string | null; clean_type: string | null; clean_life: number;
  retired_at: string | null; notes: string | null; health: KegHealth;
}
export interface TapHealth { cleanAgeDays: number | null; lifeDays: number; due: boolean; soon: boolean }
export interface TapLine { tap: number; label: string; cleaned_at: string | null; clean_life: number; current_keg: string | null; health: TapHealth }

/** Polls the keg service's fleet + tap-line lists. Mirrors useEstate's shape (HausWatch). */
export function useKegs(pollMs = 8000) {
  const [kegs, setKegs] = useState<Keg[]>([]);
  const [taps, setTaps] = useState<TapLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [k, t] = await Promise.all([
        fetch(`${KEGS_URL}/api/kegs`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()),
        fetch(`${KEGS_URL}/api/taps`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()),
      ]);
      setKegs(k.kegs || []); setTaps(t.taps || []); setError(null);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, pollMs); return () => clearInterval(iv); }, [load, pollMs]);

  /** Fire a keg action + refresh. Returns the server response — or {ok:false,error} on a
   *  network/parse failure — so callers always get a result to toast (never a silent throw). */
  const kegAction = useCallback(async (id: string, action: string, params: Record<string, unknown> = {}) => {
    let r: { ok?: boolean; warn?: string; error?: string };
    try {
      r = await fetch(`${KEGS_URL}/api/keg/${encodeURIComponent(id)}/action`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, params }), signal: AbortSignal.timeout(8000),
      }).then((res) => res.json());
    } catch (e) { r = { ok: false, error: (e as Error).message }; }
    await load();
    return r;
  }, [load]);

  const tapAction = useCallback(async (tap: number, action: string, params: Record<string, unknown> = {}) => {
    let r: { ok?: boolean; warn?: string; error?: string };
    try {
      r = await fetch(`${KEGS_URL}/api/tap/${tap}/action`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, params }), signal: AbortSignal.timeout(8000),
      }).then((res) => res.json());
    } catch (e) { r = { ok: false, error: (e as Error).message }; }
    await load();
    return r;
  }, [load]);

  return { kegs, taps, error, loading, reload: load, kegAction, tapAction };
}
