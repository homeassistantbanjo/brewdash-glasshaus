import { theme } from '../theme/tokens';
import { Staleness } from '../types/domain';
import { stalenessStyle } from '../theme/tokens';

interface Props {
  value: string;
  label: string;
  unit?: string;
  color?: string;
  staleness?: Staleness;
  glow?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** when set, the cell is clickable (opens a detail popup) */
  onClick?: () => void;
}

/**
 * A single recessed telemetry cell: big tabular number, tiny uppercase label,
 * optional unit and glow. The atomic unit of the command-center grid.
 */
export function Metric({ value, label, unit, color, staleness = 'live', glow, size = 'md', onClick }: Props) {
  const st = stalenessStyle(staleness);
  const fontSize = size === 'lg' ? 30 : size === 'sm' ? 17 : 22;
  const c = color ?? theme.color.text;

  return (
    <div
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      title={onClick ? `${label} — details` : undefined}
      style={{
      background: theme.color.inset,
      borderRadius: theme.radius.sm,
      border: `1px solid ${theme.color.panelBorder}`,
      padding: '8px 10px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      minWidth: 0,
      opacity: st.opacity,
      position: 'relative',
      cursor: onClick ? 'pointer' : undefined,
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 3,
        minWidth: 0, maxWidth: '100%', overflow: 'hidden',
      }}>
        <span style={{
          fontFamily: theme.font.mono,
          fontSize,
          fontWeight: 600,
          lineHeight: 1,
          color: c,
          fontVariantNumeric: 'tabular-nums',
          textShadow: glow ? `0 0 12px ${c}66` : undefined,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
        }}>{value}</span>
        {unit && (
          <span style={{ fontFamily: theme.font.mono, fontSize: fontSize * 0.5, color: theme.color.textDim }}>
            {unit}
          </span>
        )}
      </div>
      <div style={{
        fontFamily: theme.font.sans,
        fontSize: 9.5,
        letterSpacing: 0.8,
        textTransform: 'uppercase',
        color: st.flag ? theme.color.textFaint : theme.color.textLabel,
        marginTop: 4,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>{st.flag ?? label}</div>
    </div>
  );
}
