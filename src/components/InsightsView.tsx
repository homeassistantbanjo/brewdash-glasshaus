/**
 * The dedicated INSIGHTS view (third top-level toggle: Tanks | Graphs | Insights).
 * Shows an AI analysis of the whole brewery, from the analyzer container:
 *   1. a plant-wide summary (the one thing most needing attention)
 *   2. a per-tank fermentation analysis (one card per active tank)
 *   3. an equipment-health section (rule-based facts + LLM interpretation)
 * Opening it shows the last cached analysis instantly; the Refresh button forces a
 * live re-analysis (a few seconds). Equipment hard-numbers are shown alongside the
 * prose so the interpretation is grounded in the actual telemetry.
 */
import { theme, hexA } from '../theme/tokens';
import { useInsights, Section, Severity, EquipmentFacts } from '../hooks/useInsights';

const SEV = {
  problem: { color: theme.color.red, icon: '🛑', label: 'ACT NOW' },
  watch: { color: theme.color.amber, icon: '👀', label: 'WATCH' },
  info: { color: theme.color.green, icon: '✓', label: 'NOMINAL' },
} as const;
const sev = (s: Severity | undefined) => SEV[s && SEV[s] ? s : 'info'];

function SectionCard({ title, section, sub }: { title: string; section: Section | null; sub?: string }) {
  const m = sev(section?.severity);
  return (
    <div style={{
      background: theme.color.panelHi,
      border: `1px solid ${section ? hexA(m.color, 0.4) : theme.color.panelBorder}`,
      borderRadius: theme.radius.md, padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 6,
      boxShadow: section?.severity === 'problem' ? theme.glow(m.color, 0.25) : 'none',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontFamily: theme.font.mono, fontSize: 11, letterSpacing: 1, color: theme.color.textLabel, textTransform: 'uppercase' }}>
          {title}{sub ? <span style={{ color: theme.color.textDim }}> · {sub}</span> : null}
        </span>
        {section && (
          <span style={{ fontFamily: theme.font.mono, fontSize: 10, fontWeight: 700, letterSpacing: 1, color: m.color, whiteSpace: 'nowrap' }}>
            {m.icon} {m.label}
          </span>
        )}
      </div>
      {section ? (
        <>
          <div style={{ fontFamily: theme.font.sans, fontSize: 14, fontWeight: 600, color: theme.color.text }}>
            {section.headline}
          </div>
          {section.detail && (
            <div style={{ fontFamily: theme.font.sans, fontSize: 12.5, color: theme.color.textLabel, lineHeight: 1.5 }}>
              {section.detail}
            </div>
          )}
          {section.action && (
            <div style={{
              marginTop: 2, padding: '6px 9px', borderRadius: theme.radius.sm,
              background: theme.color.inset, border: `1px solid ${theme.color.panelBorder}`,
              fontFamily: theme.font.sans, fontSize: 12.5, color: theme.color.text,
            }}>
              <span style={{ color: m.color, fontWeight: 700 }}>→ </span>{section.action}
            </div>
          )}
        </>
      ) : (
        <div style={{ fontFamily: theme.font.sans, fontSize: 12.5, color: theme.color.textDim }}>No data.</div>
      )}
    </div>
  );
}

// hard equipment numbers shown under the equipment prose (grounds the interpretation)
function EquipmentFactsRow({ facts }: { facts?: EquipmentFacts }) {
  if (!facts) return null;
  const chips: { label: string; value: string; warn?: boolean }[] = [];
  const g = facts.glycol;
  if (g) {
    if (g.reservoirTempF != null) chips.push({ label: 'Glycol', value: `${g.reservoirTempF.toFixed(1)}°F` });
    if (g.powerW != null) chips.push({ label: 'Chiller', value: `${Math.round(g.powerW)}W ${g.running ? '· ON' : '· idle'}` });
    if (g.cyclesPerHour != null) chips.push({ label: 'Cycles', value: `${g.cyclesPerHour}/h`, warn: !!g.shortCycling });
    if (g.runtimeHrs7d != null) chips.push({ label: 'Runtime', value: `${g.runtimeHrs7d.toFixed(1)}h/7d` });
  }
  if (facts.kegerator?.powerW != null) {
    chips.push({ label: 'Kegerator', value: `${Math.round(facts.kegerator.powerW)}W ${facts.kegerator.cooling ? '· cooling' : ''}` });
  }
  (facts.controllers || []).forEach((c) => {
    if (c.controllerW != null) chips.push({ label: c.tank.replace('_', ' '), value: `${c.controllerW.toFixed(1)}W` });
    if (c.tiltSignalLost) chips.push({ label: `${c.tank.replace('_', ' ')} Tilt`, value: 'SIGNAL LOST', warn: true });
  });
  if (!chips.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      {chips.map((c, i) => (
        <span key={i} style={{
          fontFamily: theme.font.mono, fontSize: 10.5, fontVariantNumeric: 'tabular-nums',
          padding: '3px 8px', borderRadius: 6,
          background: theme.color.inset,
          border: `1px solid ${c.warn ? hexA(theme.color.amber, 0.5) : theme.color.panelBorder}`,
          color: c.warn ? theme.color.amber : theme.color.textLabel,
        }}>
          <span style={{ color: theme.color.textDim }}>{c.label} </span>{c.value}
        </span>
      ))}
    </div>
  );
}

function ago(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function InsightsView() {
  const { data, loading, error, refresh } = useInsights(true);

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, paddingRight: 4 }}>
      {/* header row: title + freshness + refresh */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
        <div style={{ fontFamily: theme.font.mono, fontSize: 12, letterSpacing: 1, color: theme.color.textLabel, textTransform: 'uppercase' }}>
          AI Analysis {data?.generatedAt && <span style={{ color: theme.color.textDim }}>· {ago(data.generatedAt)}</span>}
        </div>
        <button onClick={refresh} disabled={loading} style={{
          fontFamily: theme.font.mono, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase',
          padding: '6px 14px', borderRadius: 8, cursor: loading ? 'wait' : 'pointer',
          border: `1px solid ${loading ? theme.color.panelBorder : hexA(theme.color.cyan, 0.5)}`,
          background: loading ? theme.color.inset : hexA(theme.color.cyan, 0.14),
          color: loading ? theme.color.textDim : theme.color.cyan,
          display: 'flex', alignItems: 'center', gap: 7,
        }}>
          <span style={{
            display: 'inline-block', width: 11, height: 11, borderRadius: '50%',
            border: `2px solid ${loading ? theme.color.textDim : theme.color.cyan}`,
            borderTopColor: 'transparent',
            animation: loading ? 'ghspin 0.7s linear infinite' : 'none',
          }} />
          {loading ? 'Analyzing…' : 'Refresh'}
        </button>
      </div>
      <style>{`@keyframes ghspin { to { transform: rotate(360deg); } }`}</style>

      {error && (
        <div style={{
          fontFamily: theme.font.sans, fontSize: 13, color: theme.color.red,
          background: hexA(theme.color.red, 0.1), border: `1px solid ${hexA(theme.color.red, 0.4)}`,
          borderRadius: theme.radius.md, padding: '10px 14px',
        }}>
          Couldn't reach the analyzer: {error}. Is the Glasshaus-analyzer container running on :8091?
        </div>
      )}

      {!data && !error && (
        <div style={{ fontFamily: theme.font.sans, fontSize: 13, color: theme.color.textDim, padding: 20, textAlign: 'center' }}>
          Loading analysis…
        </div>
      )}

      {data && (
        <>
          <SectionCard title="Plant Summary" section={data.plantSummary} />

          {data.tanks.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontFamily: theme.font.mono, fontSize: 11, letterSpacing: 1, color: theme.color.textDim, textTransform: 'uppercase' }}>
                Fermentation · by tank
              </div>
              {data.tanks.map((t) => (
                <SectionCard key={t.tank} title={t.tank.replace('_', ' ')} sub={t.batch || undefined} section={t} />
              ))}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <SectionCard title="Equipment Health" section={data.equipment} />
            <EquipmentFactsRow facts={data.equipmentFacts} />
          </div>
        </>
      )}
    </div>
  );
}
