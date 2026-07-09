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
          {/* LIST layout — each part on its own labeled row with dividers, so it
              reads as discrete items instead of one mashed-together paragraph. */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <InsightRow label="STATUS" color={m.color} strong>{insight.headline}</InsightRow>
            {insight.detail && <InsightRow label="DETAIL" color={theme.color.textFaint}>{insight.detail}</InsightRow>}
            {insight.action && <InsightRow label="NEXT" color={m.color}>{insight.action}</InsightRow>}
          </div>
          <div style={{
            marginTop: 10, paddingTop: 8, borderTop: `1px solid ${theme.color.panelBorder}`,
            fontFamily: theme.font.mono, fontSize: 10, letterSpacing: 1, color: theme.color.textDim,
            textAlign: 'center',
          }}>
            open the <span style={{ color: m.color }}>INSIGHTS</span> tab for the full per-tank + equipment breakdown
          </div>
        </div>
      )}
    </>
  );
}

/** One labeled row in the insight list — a small uppercase tag + the text. */
function InsightRow({ label, color, strong, children }: {
  label: string; color: string; strong?: boolean; children: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', gap: 10, padding: '7px 0',
      borderBottom: `1px solid ${theme.color.panelBorder}`,
    }}>
      <span style={{
        fontFamily: theme.font.mono, fontSize: 9, letterSpacing: 1, fontWeight: 700,
        color, minWidth: 42, paddingTop: 2, flexShrink: 0,
      }}>{label}</span>
      <span style={{
        fontFamily: theme.font.sans, fontSize: strong ? 14 : 13,
        fontWeight: strong ? 600 : 400,
        color: strong ? theme.color.text : theme.color.textLabel, lineHeight: 1.45,
      }}>{children}</span>
    </div>
  );
}
