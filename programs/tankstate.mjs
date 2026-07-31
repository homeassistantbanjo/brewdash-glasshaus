// TankState — pure per-tank control state. No I/O. Persisted by the runner as JSON in
// input_text.tank_N_control_state (255-char cap). Short keys for headroom.
//
// Keys: b=batchKey, pa=phaseAnchorF, cc=crashConfirmedPhase (-1=none), ad=adopted,
// ss=stableSinceMs, us=unstableSinceMs, fl=fermStartedLatch, off=lastOffset,
// lcp=lastConsumedPressMs, u=updatedMs.
// See docs/superpowers/specs/2026-07-30-control-state-refactor-design.md
const KEYS = ['b', 'pa', 'cc', 'ad', 'ss', 'us', 'fl', 'off', 'lcp', 'u'];

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

// First-boot migration: build an initial State from the existing scattered HA
// helpers so a live mid-ferment tank carries real state across the cutover
// (no re-adopt / phase re-jump, no re-ask crash-confirm, no lost stability clock).
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
