import { useMemo } from 'react';
import { theme, hexA } from '../theme/tokens';

interface Props {
  /** y-values, oldest→newest. Nulls are skipped (gaps). */
  data: number[];
  color?: string;
  /** optional flat reference line in data units (e.g. setpoint / target FG) */
  reference?: number | null;
  referenceColor?: string;
  width?: number;
  height?: number;
  /** fill under the curve with a faint gradient */
  fill?: boolean;
  /** force the y-domain instead of auto-fitting to data (e.g. to include ref) */
  domain?: [number, number];
  ariaLabel?: string;
  /** fill the parent element instead of using fixed width/height. width/height
   *  still define the internal viewBox coordinate space (aspect is not preserved,
   *  so the line stretches to the box — fine for a trend). */
  responsive?: boolean;
}

/**
 * A minimal, dependency-free telemetry sparkline. Tabular, glowing, glass-native.
 * Renders a smooth-ish polyline over a normalized viewbox; the last point gets a
 * glowing dot (the "live" head). Used inline in dense fermenter rows.
 */
export function Sparkline({
  data, color = theme.color.cyan, reference = null,
  referenceColor = theme.color.amber, width = 120, height = 34,
  fill = true, domain, ariaLabel, responsive = false,
}: Props) {
  const pts = useMemo(() => data.filter((n) => Number.isFinite(n)), [data]);

  const geom = useMemo(() => {
    if (pts.length < 2) return null;
    const vals = domain ? [domain[0], domain[1], ...pts] : [...pts];
    if (reference != null && !domain) vals.push(reference);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (hi === lo) { hi += 1; lo -= 1; }            // avoid /0 on flat series
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const n = pts.length;
    const x = (i: number) => (i / (n - 1)) * width;
    const y = (v: number) => height - ((v - lo) / (hi - lo)) * height;
    const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = `0,${height} ${line} ${width},${height}`;
    const refY = reference != null ? y(reference) : null;
    const headX = x(n - 1);
    const headY = y(pts[n - 1]);
    return { line, area, refY, headX, headY };
  }, [pts, reference, domain, width, height]);

  if (!geom) {
    return (
      <div style={{
        width: responsive ? '100%' : width, height: responsive ? '100%' : height,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: theme.font.mono, fontSize: 10, color: theme.color.textFaint,
      }}>— no trend —</div>
    );
  }

  const gid = `sg-${color.replace('#', '')}`;
  return (
    <svg
      width={responsive ? '100%' : width} height={responsive ? '100%' : height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={responsive ? 'none' : 'xMidYMid meet'}
      role="img" aria-label={ariaLabel} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={hexA(color, 0.35)} />
          <stop offset="100%" stopColor={hexA(color, 0)} />
        </linearGradient>
      </defs>
      {geom.refY != null && (
        <line x1={0} x2={width} y1={geom.refY} y2={geom.refY}
          stroke={hexA(referenceColor, 0.5)} strokeWidth={1} strokeDasharray="3 3" />
      )}
      {fill && <polygon points={geom.area} fill={`url(#${gid})`} />}
      <polyline points={geom.line} fill="none" stroke={color} strokeWidth={1.5}
        strokeLinejoin="round" strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 3px ${hexA(color, 0.6)})` }} />
      <circle cx={geom.headX} cy={geom.headY} r={2.4} fill={color}
        style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
    </svg>
  );
}
