import { useEffect, useRef, useState } from 'react';
import { theme, hexA } from '../theme/tokens';
import { Insight } from '../hooks/useBrewery';

/**
 * Surfaces the LLM insight (sensor.glasshaus_insight) in the dashboard:
 *  - a header BELL/BADGE (severity-colored) you can tap to open the panel
 *  - AUTO-OPENS the panel for `problem` severity (urgent), stays a quiet badge
 *    for `info`/`watch` — so a wall display isn't nagged by routine insights.
 * Dismissible; re-opens automatically only when a NEW problem insight arrives.
 */
const META = {
  problem: { color: theme.color.red, icon: '🛑', label: 'ISSUE' },
  watch: { color: theme.color.amber, icon: '👀', label: 'WATCH' },
  info: { color: theme.color.cyan, icon: '🍺', label: 'INSIGHT' },
} as const;

export function InsightPanel({ insight }: { insight: Insight | null }) {
  const [open, setOpen] = useState(false);
  const lastAutoKey = useRef<string | null>(null);

  // auto-open once per NEW problem insight (keyed by updatedAt+headline)
  useEffect(() => {
    if (!insight || insight.severity !== 'problem') return;
    const key = `${insight.updatedAt}:${insight.headline}`;
    if (key !== lastAutoKey.current) {
      lastAutoKey.current = key;
      setOpen(true);
    }
  }, [insight]);

  if (!insight) return null;
  const m = META[insight.severity];

  return (
    <>
      {/* header badge — tap to toggle the panel */}
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title="GlassHaus insight"
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontFamily: theme.font.mono, fontSize: 10, letterSpacing: 1,
          padding: '4px 9px', borderRadius: 6, cursor: 'pointer',
          border: `1px solid ${hexA(m.color, 0.5)}`,
          background: hexA(m.color, 0.12), color: m.color,
          boxShadow: insight.severity === 'problem' ? theme.glow(m.color, 0.3) : 'none',
        }}>
        <span>{m.icon}</span><span style={{ fontWeight: 700 }}>{m.label}</span>
      </button>

      {open && (
        <div style={{
          position: 'fixed', right: 16, top: 60, zIndex: 60, width: 'min(420px, 90vw)',
          background: theme.color.panelHi,
          backdropFilter: `blur(${theme.blur})`, WebkitBackdropFilter: `blur(${theme.blur})`,
          border: `1px solid ${hexA(m.color, 0.5)}`,
          borderRadius: theme.radius.lg,
          boxShadow: `0 16px 48px rgba(0,0,0,0.6), ${theme.glow(m.color, 0.3)}`,
          padding: 16,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontFamily: theme.font.mono, fontSize: 11, letterSpacing: 1, color: m.color, fontWeight: 700 }}>
              {m.icon} {m.label}
            </span>
            <button onClick={() => setOpen(false)} style={{
              background: 'transparent', border: 'none', color: theme.color.textDim,
              fontSize: 16, cursor: 'pointer',
            }}>✕</button>
          </div>
          <div style={{ fontFamily: theme.font.sans, fontSize: 15, fontWeight: 600, color: theme.color.text, marginBottom: 6 }}>
            {insight.headline}
          </div>
          {insight.detail && (
            <div style={{ fontFamily: theme.font.sans, fontSize: 13, color: theme.color.textLabel, lineHeight: 1.5 }}>
              {insight.detail}
            </div>
          )}
          {insight.action && (
            <div style={{
              marginTop: 10, padding: '8px 10px', borderRadius: theme.radius.sm,
              background: theme.color.inset, border: `1px solid ${theme.color.panelBorder}`,
              fontFamily: theme.font.sans, fontSize: 13, color: theme.color.text,
            }}>
              <span style={{ color: m.color, fontWeight: 700 }}>→ </span>{insight.action}
            </div>
          )}
        </div>
      )}
    </>
  );
}
