import { theme, stalenessStyle } from '../theme/tokens';
import { Staleness } from '../types/domain';

interface Props {
  value: string;
  label: string;
  color?: string;        // state color for the number
  staleness?: Staleness;
  sub?: string;          // small secondary line under the label
}

/** The oversized-number-with-micro-label HUD unit. Dims + flags when stale. */
export function StatTile({ value, label, color, staleness = 'live', sub }: Props) {
  const st = stalenessStyle(staleness);
  return (
    <div style={{ textAlign: 'center', padding: '10px 6px', position: 'relative', opacity: st.opacity }}>
      {st.flag && (
        <span style={{
          position: 'absolute', top: 4, right: 6,
          fontSize: 9, letterSpacing: 0.5, textTransform: 'uppercase',
          color: theme.color.textFaint,
        }}>{st.flag}</span>
      )}
      <div style={{
        fontFamily: theme.font.mono,
        fontSize: 34, fontWeight: 600, lineHeight: 1.05,
        color: color ?? theme.color.text,
        fontVariantNumeric: 'tabular-nums',
        textShadow: color ? `0 0 14px ${color}44` : undefined,
      }}>{value}</div>
      <div style={{
        fontFamily: theme.font.sans,
        fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase',
        color: theme.color.textDim, marginTop: 4, fontWeight: 500,
      }}>{label}</div>
      {sub && (
        <div style={{ fontSize: 11, color: theme.color.textFaint, marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}
