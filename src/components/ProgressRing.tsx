/**
 * A HUD targeting-ring gauge that wraps the fermenter vessel: an outer track +
 * a glowing arc showing attenuation progress (0–100%), plus faint tick marks
 * around the circumference. Theme-gated on fx().vesselRing — renders nothing on
 * themes that don't want it, so the vessel just sits bare on `command`.
 *
 * Sized to sit BEHIND/around the vessel; place it in a relative container with
 * the ConicalFermenter centered over it.
 */
import { theme, hexA, fx } from '../theme/tokens';

export function ProgressRing({ pct, size = 210, color, active, innerPct, innerColor }: {
  /** 0–100 progress; null → just the track + ticks (no arc) */
  pct: number | null;
  size?: number;
  color?: string;
  /** when actively fermenting, the ring gets a slow rotation on its tick layer */
  active?: boolean;
  /** optional SECOND (inner) arc, 0–100 — e.g. temperature-in-band */
  innerPct?: number | null;
  innerColor?: string;
}) {
  if (!fx().vesselRing) return null;
  const c = color ?? theme.color.cyan;
  const ic = innerColor ?? theme.color.amber;
  const r = size / 2 - 8;
  const ri = r - 12;                                  // inner arc radius
  const cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  const circi = 2 * Math.PI * ri;
  const p = pct != null ? Math.max(0, Math.min(100, pct)) : 0;
  const dash = (p / 100) * circ;
  const pi = innerPct != null ? Math.max(0, Math.min(100, innerPct)) : null;
  const dashi = pi != null ? (pi / 100) * circi : 0;

  // tick marks around the ring (every 15°)
  const ticks = Array.from({ length: 24 }, (_, i) => {
    const ang = (i / 24) * 2 * Math.PI - Math.PI / 2;
    const r1 = r + 3, r2 = r + (i % 2 === 0 ? 8 : 5);
    return {
      x1: cx + r1 * Math.cos(ang), y1: cy + r1 * Math.sin(ang),
      x2: cx + r2 * Math.cos(ang), y2: cy + r2 * Math.sin(ang),
      major: i % 2 === 0,
    };
  });

  const sweepId = `sweep-${c.replace('#', '')}`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', pointerEvents: 'none', zIndex: 0 }}>
      {/* RADAR SWEEP — a faint rotating wedge of light inside the ring while active
          (the classic "scanning" HUD motion). */}
      {active && (
        <>
          <defs>
            <radialGradient id={sweepId} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={hexA(c, 0.18)} />
              <stop offset="100%" stopColor={hexA(c, 0)} />
            </radialGradient>
          </defs>
          <g style={{ transformOrigin: 'center', animation: 'ghsweep 6s linear infinite' }}>
            <style>{`@keyframes ghsweep { to { transform: rotate(360deg); } }`}</style>
            <path d={`M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx + r * Math.sin(0.9)} ${cy - r * Math.cos(0.9)} Z`}
              fill={`url(#${sweepId})`} />
          </g>
        </>
      )}
      {/* tick layer (slowly rotates while active) */}
      <g style={active ? { transformOrigin: 'center', animation: 'ghring 40s linear infinite' } : undefined}>
        <style>{`@keyframes ghring { to { transform: rotate(360deg); } }`}</style>
        {ticks.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            stroke={hexA(c, t.major ? 0.5 : 0.25)} strokeWidth={t.major ? 1.4 : 1} />
        ))}
      </g>
      {/* faint full track */}
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={hexA(c, 0.12)} strokeWidth={2} />
      {/* a second, faster counter-rotating inner reticle arc (HUD "alive" feel) */}
      {active && (
        <circle cx={cx} cy={cy} r={r - 6} fill="none" stroke={hexA(c, 0.35)} strokeWidth={1}
          strokeDasharray={`${circ * 0.12} ${circ * 0.88}`}
          style={{ transformOrigin: 'center', animation: 'ghring2 12s linear infinite' }} />
      )}
      <style>{`@keyframes ghring2 { to { transform: rotate(-360deg); } }`}</style>
      {/* glowing progress arc, starting at 12 o'clock */}
      {pct != null && (
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={c} strokeWidth={3.5}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ - dash}`}
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{ filter: `drop-shadow(0 0 7px ${hexA(c, 0.9)})`, transition: 'stroke-dasharray 0.8s ease' }} />
      )}
      {/* SECOND inner arc (e.g. temp-in-band) — faint track + its own glowing arc */}
      {pi != null && (
        <>
          <circle cx={cx} cy={cy} r={ri} fill="none" stroke={hexA(ic, 0.1)} strokeWidth={2} />
          <circle cx={cx} cy={cy} r={ri} fill="none" stroke={ic} strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={`${dashi} ${circi - dashi}`}
            transform={`rotate(-90 ${cx} ${cy})`}
            style={{ filter: `drop-shadow(0 0 5px ${hexA(ic, 0.8)})`, transition: 'stroke-dasharray 0.8s ease' }} />
        </>
      )}
      {/* progress % readout on the ring foot */}
      {pct != null && (
        <text x={cx} y={size - 6} textAnchor="middle"
          fontFamily="'JetBrains Mono', monospace" fontSize={11} fontWeight={700}
          fill={c} style={{ filter: `drop-shadow(0 0 4px ${hexA(c, 0.8)})` }}>
          {Math.round(p)}%
        </text>
      )}
    </svg>
  );
}
