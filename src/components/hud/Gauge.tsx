/**
 * Instrumented readouts for the HUD — the things that make data LOOK like
 * instruments instead of text in a box.
 *
 *  <BarGauge/>  — a labeled value with a SEGMENTED bar underneath (fills 0–100%);
 *                 optional target tick. Replaces the flat metric cell for anything
 *                 with a natural 0–100 range (attenuation, progress, level).
 *  <TickReadout/> — a value in a chamfered well framed by measurement ticks; for
 *                 point values without a natural range (temp, velocity, ABV).
 *
 * Theme-gated chrome: chamfer + ticks appear on fx.brackets themes; elsewhere they
 * fall back to the plain recessed cell so command/lcars stay clean.
 */
import { theme, hexA, fx } from '../../theme/tokens';

const clip12 = 'polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)';

export function BarGauge({ label, value, unit, pct, color, target, glow, onClick }: {
  label: string; value: string; unit?: string;
  /** 0–100 fill */ pct: number | null;
  color?: string; /** 0–100 target tick */ target?: number | null;
  glow?: boolean; onClick?: () => void;
}) {
  const c = color ?? theme.color.cyan;
  const cham = fx().brackets;
  const p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const segments = 20;
  const lit = Math.round((p / 100) * segments);

  return (
    <div onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      title={onClick ? `${label} — details` : undefined}
      style={{
        background: theme.color.inset,
        clipPath: cham ? clip12 : undefined,
        borderRadius: cham ? 0 : theme.radius.sm,
        border: `1px solid ${hexA(c, cham ? 0.25 : 0.15)}`,
        padding: '7px 9px 8px', display: 'flex', flexDirection: 'column', gap: 5,
        cursor: onClick ? 'pointer' : undefined, minWidth: 0,
      }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 4 }}>
        <span style={{
          fontFamily: theme.font.mono, fontSize: 17, fontWeight: 600, lineHeight: 1, color: c,
          fontVariantNumeric: 'tabular-nums', textShadow: glow ? `0 0 10px ${hexA(c, 0.7)}` : undefined,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{value}{unit && <span style={{ fontSize: 9, color: theme.color.textDim }}>{unit}</span>}</span>
      </div>
      {/* segmented bar */}
      <div style={{ position: 'relative', display: 'flex', gap: 1.5, height: 6 }}>
        {Array.from({ length: segments }, (_, i) => (
          <span key={i} style={{
            flex: 1,
            background: i < lit ? c : hexA(c, 0.12),
            boxShadow: i < lit && glow ? `0 0 4px ${hexA(c, 0.7)}` : 'none',
            transition: 'background 0.4s',
          }} />
        ))}
        {target != null && (
          <span style={{
            position: 'absolute', top: -2, bottom: -2, left: `${Math.max(0, Math.min(100, target))}%`,
            width: 1.5, background: theme.color.amber, boxShadow: `0 0 5px ${theme.color.amber}`,
          }} />
        )}
      </div>
      <span style={{
        fontFamily: theme.font.sans, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase',
        color: theme.color.textLabel, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{label}</span>
    </div>
  );
}

export function TickReadout({ label, value, unit, color, glow, onClick, staleFlag }: {
  label: string; value: string; unit?: string; color?: string;
  glow?: boolean; onClick?: () => void; staleFlag?: string | null;
}) {
  const c = color ?? theme.color.text;
  const cham = fx().brackets;
  return (
    <div onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      title={onClick ? `${label} — details` : undefined}
      style={{
        position: 'relative', background: theme.color.inset,
        clipPath: cham ? clip12 : undefined,
        borderRadius: cham ? 0 : theme.radius.sm,
        border: `1px solid ${hexA(c === theme.color.text ? theme.color.cyan : c, cham ? 0.22 : 0.12)}`,
        padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3,
        cursor: onClick ? 'pointer' : undefined, minWidth: 0, overflow: 'hidden',
      }}>
      {/* corner measurement ticks (chamfered themes only) */}
      {cham && <>
        <span style={{ position: 'absolute', top: 3, right: 4, width: 5, height: 1, background: hexA(c, 0.5) }} />
        <span style={{ position: 'absolute', top: 3, right: 4, width: 1, height: 5, background: hexA(c, 0.5) }} />
      </>}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 3, minWidth: 0 }}>
        <span style={{
          fontFamily: theme.font.mono, fontSize: 17, fontWeight: 600, lineHeight: 1, color: c,
          fontVariantNumeric: 'tabular-nums', textShadow: glow ? `0 0 10px ${hexA(c, 0.7)}` : undefined,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{value}</span>
        {unit && <span style={{ fontFamily: theme.font.mono, fontSize: 9, color: theme.color.textDim }}>{unit}</span>}
      </div>
      <span style={{
        fontFamily: theme.font.sans, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase',
        color: staleFlag ? theme.color.textFaint : theme.color.textLabel,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{staleFlag ?? label}</span>
    </div>
  );
}
