import { useState } from 'react';
import { theme, hexA } from '../theme/tokens';
import { useBreweryActions } from '../hooks/useBreweryActions';

const STEP = 0.5;   // °F per tap
const MIN = 32;     // sane guard rails for a glycol-jacketed fermenter
const MAX = 80;

/**
 * Setpoint ±  with STEP + CONFIRM semantics. Tapping ± adjusts a *pending* value
 * shown locally; nothing is written to HA until "Set" is pressed. This keeps the
 * historically-dangerous setpoint deliberate — no accidental writes from a stray
 * tap on a wall tablet. The ×10 raw conversion lives in useBreweryActions.setSetpoint.
 */
export function SetpointControl({ tankId, current }: { tankId: string; current: number | null }) {
  const a = useBreweryActions();
  // `edit` holds the uncommitted pending value, or null when not editing. We do
  // NOT auto-resync to the live `current` on every stream tick — that made the
  // control twitchy and could unmount the SET button mid-click. While editing,
  // the display shows `edit`; otherwise it shows the live `current`.
  const [edit, setEdit] = useState<number | null>(null);

  const clamp = (v: number) => Math.min(MAX, Math.max(MIN, Math.round(v * 2) / 2));
  const base = edit ?? current ?? 65;
  const step = (delta: number) => setEdit(clamp(base + delta));
  const commit = () => {
    if (edit != null) a.setSetpoint(tankId, edit);
    setEdit(null);   // drop back to showing live `current` (which will catch up)
  };
  const cancel = () => setEdit(null);

  const pending = edit ?? current;
  const changed = edit != null && edit !== current;

  return (
    <div
      onClick={(e) => e.stopPropagation()}  // don't open the card's assignment panel
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: theme.color.inset, borderRadius: theme.radius.sm,
        border: `1px solid ${changed ? hexA(theme.color.amber, 0.5) : theme.color.panelBorder}`,
        padding: '6px 8px',
      }}
    >
      <span style={{
        fontFamily: theme.font.sans, fontSize: 9, letterSpacing: 0.8,
        textTransform: 'uppercase', color: theme.color.textLabel, marginRight: 2,
      }}>Setpoint</span>

      <button aria-label="Lower setpoint" onClick={() => step(-STEP)} style={btn}>–</button>

      <span style={{
        fontFamily: theme.font.mono, fontSize: 20, fontWeight: 600, minWidth: 58,
        textAlign: 'center', fontVariantNumeric: 'tabular-nums',
        color: changed ? theme.color.amber : theme.color.text,
        textShadow: changed ? `0 0 12px ${hexA(theme.color.amber, 0.4)}` : undefined,
      }}>
        {pending != null ? pending.toFixed(1) : '—'}
        <span style={{ fontSize: 11, color: theme.color.textDim }}>°F</span>
      </span>

      <button aria-label="Raise setpoint" onClick={() => step(STEP)} style={btn}>+</button>

      {changed ? (
        <div style={{ display: 'flex', gap: 4, marginLeft: 2 }}>
          <button onClick={commit} style={{ ...pill, color: theme.color.green, borderColor: hexA(theme.color.green, 0.4) }}>SET</button>
          <button onClick={cancel} style={{ ...pill, color: theme.color.textDim }}>✕</button>
        </div>
      ) : (
        <span style={{ fontFamily: theme.font.mono, fontSize: 10, color: theme.color.textFaint, marginLeft: 2 }}>
          held
        </span>
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  fontFamily: theme.font.mono, fontSize: 18, lineHeight: 1,
  width: 30, height: 30, borderRadius: 6, cursor: 'pointer',
  border: `1px solid ${theme.color.panelBorder}`, background: theme.color.panel,
  color: theme.color.cyan,
};
const pill: React.CSSProperties = {
  fontFamily: theme.font.mono, fontSize: 11, padding: '5px 8px', borderRadius: 6,
  cursor: 'pointer', border: `1px solid ${theme.color.panelBorder}`,
  background: theme.color.panel,
};
