import { useMemo } from 'react';
import { theme, hexA } from '../theme/tokens';

export type VesselState = 'healthy' | 'cooling' | 'warn' | 'fault' | 'idle' | 'empty';

interface Props {
  state: VesselState;
  /** 0–100 liquid fill (attenuation progress). Ignored for empty/idle. */
  fillPct?: number | null;
  /** show rising bubbles (active fermentation) */
  active?: boolean;
  width?: number;
  height?: number;
}

// read live theme colors (getter) so the vessel recolors on a theme switch
function stateColorOf(state: VesselState): string {
  switch (state) {
    case 'healthy': return theme.color.green;
    case 'cooling': return theme.color.cyan;
    case 'warn': return theme.color.amber;
    case 'fault': return theme.color.red;
    case 'idle': return theme.color.textDim;
    case 'empty': return theme.color.textFaint;
  }
}

/**
 * An animated conical fermenter. The vessel silhouette (cylinder + cone) glows
 * in its state color: green when fermenting healthy, red when it needs
 * attention, cyan while actively cooling, amber for warnings, dim when idle.
 * Liquid fills to `fillPct` (attenuation progress); bubbles rise when active.
 *
 * Pure SVG + inline @keyframes (scoped by a unique id) — no deps, no CSS files.
 */
export function ConicalFermenter({
  state, fillPct = null, active = false, width = 120, height = 200,
}: Props) {
  const c = stateColorOf(state);
  const uid = useMemo(() => `cf-${state}-${Math.round((fillPct ?? 0))}-${width}`, [state, fillPct, width]);

  // Geometry in a 100x180 viewBox: neck, cylinder body, cone to a valve.
  const bodyTop = 26;      // top of cylinder
  const bodyBottom = 118;  // where cone starts
  const coneTip = 168;     // cone point
  const left = 20, right = 80, cx = 50;

  // liquid level within the cylinder (fill from bottom of cone upward).
  const pct = Math.max(0, Math.min(100, fillPct ?? 0));
  const hasLiquid = state !== 'empty' && state !== 'idle' && fillPct != null;
  // fill spans cone tip → body top; map pct onto that vertical range
  const fillTopY = coneTip - (coneTip - bodyTop) * (pct / 100);

  const bubbles = active && hasLiquid;

  return (
    <svg width={width} height={height} viewBox="0 0 100 180"
      role="img" aria-label={`fermenter ${state} ${hasLiquid ? Math.round(pct) + '% full' : ''}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block', overflow: 'visible', flexShrink: 0 }}>
      <defs>
        <linearGradient id={`${uid}-liq`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={hexA(c, 0.55)} />
          <stop offset="100%" stopColor={hexA(c, 0.22)} />
        </linearGradient>
        <clipPath id={`${uid}-clip`}>
          {/* the interior shape liquid is clipped to */}
          <path d={`M${left},${bodyTop} L${right},${bodyTop} L${right},${bodyBottom} L${cx},${coneTip} L${left},${bodyBottom} Z`} />
        </clipPath>
        <style>{`
          @keyframes ${uid}-rise {
            0%   { transform: translateY(0);     opacity: 0; }
            15%  { opacity: 0.9; }
            100% { transform: translateY(-46px); opacity: 0; }
          }
          @keyframes ${uid}-pulse {
            0%,100% { opacity: 0.85; }
            50%     { opacity: 1; }
          }
          .${uid}-glow { animation: ${uid}-pulse 2.6s ease-in-out infinite; }
          .${uid}-b { animation: ${uid}-rise 2.8s ease-in infinite; }
        `}</style>
      </defs>

      {/* soft ambient glow behind the vessel */}
      <ellipse cx={cx} cy={92} rx={44} ry={78} fill={hexA(c, state === 'empty' ? 0.02 : 0.10)}
        style={{ filter: 'blur(6px)' }} />

      {/* neck / port at top */}
      <rect x={cx - 8} y={12} width={16} height={16} rx={2}
        fill={theme.color.inset} stroke={hexA(c, 0.5)} strokeWidth={1.5} />

      {/* liquid fill (clipped to vessel interior) */}
      {hasLiquid && (
        <g clipPath={`url(#${uid}-clip)`}>
          <rect x={left - 2} y={fillTopY} width={(right - left) + 4} height={coneTip - fillTopY + 2}
            fill={`url(#${uid}-liq)`} />
          {/* surface line */}
          <rect x={left - 2} y={fillTopY} width={(right - left) + 4} height={1.5} fill={hexA(c, 0.85)} />
          {bubbles && [22, 40, 58, 34, 66].map((x, i) => (
            <circle key={i} className={`${uid}-b`} cx={x} cy={coneTip - 6} r={i % 2 ? 1.6 : 2.3}
              fill={hexA(c, 0.7)}
              style={{ animationDelay: `${i * 0.5}s`, transformBox: 'fill-box' }} />
          ))}
        </g>
      )}

      {/* vessel outline (cylinder + cone) */}
      <path className={state === 'empty' ? undefined : `${uid}-glow`}
        d={`M${left},${bodyTop} L${right},${bodyTop} L${right},${bodyBottom} L${cx},${coneTip} L${left},${bodyBottom} Z`}
        fill="none" stroke={c} strokeWidth={2} strokeLinejoin="round"
        style={{ filter: state === 'empty' ? 'none' : `drop-shadow(0 0 5px ${hexA(c, 0.6)})` }} />

      {/* cone/valve foot */}
      <line x1={cx} y1={coneTip} x2={cx} y2={coneTip + 8} stroke={c} strokeWidth={2} />
      <rect x={cx - 5} y={coneTip + 8} width={10} height={4} rx={1} fill={hexA(c, 0.6)} />

      {/* a couple of body hoops for the "vessel" read */}
      {[bodyTop + 22, bodyTop + 52].map((y) => (
        <line key={y} x1={left} y1={y} x2={right} y2={y} stroke={hexA(c, 0.18)} strokeWidth={1} />
      ))}
    </svg>
  );
}
