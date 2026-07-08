import { Sparkline } from './Sparkline';
import { theme, hexA } from '../theme/tokens';

export interface MetricDetailSpec {
  label: string;              // 'Gravity'
  value: string;              // '1.017'
  unit?: string;
  color?: string;
  /** one-line plain-English explanation of what this metric means */
  blurb?: string;
  /** optional large trend graph */
  series?: number[];
  seriesLabel?: string;
  reference?: number | null;
  referenceLabel?: string;
  referenceColor?: string;
  /** extra key/value rows shown under the graph */
  facts?: { k: string; v: string }[];
  /** context line, e.g. which entity / Tilt it came from */
  source?: string;
}

/** A focused modal for one metric: big number, large graph, plain-English
 *  context. Opened by tapping a metric on a card. */
export function MetricDetail({ spec, onClose }: { spec: MetricDetailSpec; onClose: () => void }) {
  const c = spec.color ?? theme.color.cyan;
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 60,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: theme.color.panelHi,
        border: `1px solid ${theme.color.panelBorderHi}`,
        borderTop: `2px solid ${c}`,
        borderRadius: theme.radius.lg,
        boxShadow: `0 24px 64px rgba(0,0,0,0.6)`,
        width: 'min(720px, 100%)', maxHeight: '86vh', overflowY: 'auto', padding: 24,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{
              fontFamily: theme.font.sans, fontSize: 11, letterSpacing: 1,
              textTransform: 'uppercase', color: theme.color.textLabel,
            }}>{spec.label}</div>
            <div style={{
              fontFamily: theme.font.mono, fontSize: 56, fontWeight: 600, lineHeight: 1.05,
              color: c, fontVariantNumeric: 'tabular-nums',
              textShadow: `0 0 22px ${hexA(c, 0.4)}`,
            }}>
              {spec.value}{spec.unit && <span style={{ fontSize: 24, color: theme.color.textDim }}>{spec.unit}</span>}
            </div>
          </div>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', color: theme.color.textDim,
            fontSize: 20, cursor: 'pointer',
          }}>✕</button>
        </div>

        {spec.blurb && (
          <p style={{ fontFamily: theme.font.sans, fontSize: 13, color: theme.color.textDim, lineHeight: 1.5, margin: '10px 0 0' }}>
            {spec.blurb}
          </p>
        )}

        {spec.series && spec.series.length >= 2 && (
          <div style={{
            marginTop: 18, background: theme.color.inset, borderRadius: theme.radius.md,
            border: `1px solid ${theme.color.panelBorder}`, padding: 16,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontFamily: theme.font.sans, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: theme.color.textLabel }}>
                {spec.seriesLabel ?? 'Trend'}
              </span>
              {spec.reference != null && (
                <span style={{ fontFamily: theme.font.mono, fontSize: 11, color: spec.referenceColor ?? theme.color.amber }}>
                  {spec.referenceLabel ?? 'ref'} {spec.reference.toFixed(spec.reference < 2 ? 3 : 1)}
                </span>
              )}
            </div>
            <Sparkline data={spec.series} color={c} reference={spec.reference}
              referenceColor={spec.referenceColor} width={656} height={180} ariaLabel={spec.seriesLabel ?? spec.label} />
          </div>
        )}

        {spec.facts && spec.facts.length > 0 && (
          <div style={{
            marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8,
          }}>
            {spec.facts.map((f) => (
              <div key={f.k} style={{
                display: 'flex', justifyContent: 'space-between',
                background: theme.color.inset, borderRadius: theme.radius.sm,
                border: `1px solid ${theme.color.panelBorder}`, padding: '8px 12px',
              }}>
                <span style={{ fontFamily: theme.font.sans, fontSize: 12, color: theme.color.textLabel }}>{f.k}</span>
                <span style={{ fontFamily: theme.font.mono, fontSize: 13, color: theme.color.text, fontVariantNumeric: 'tabular-nums' }}>{f.v}</span>
              </div>
            ))}
          </div>
        )}

        {spec.source && (
          <div style={{ fontFamily: theme.font.mono, fontSize: 10, color: theme.color.textFaint, marginTop: 14 }}>
            {spec.source}
          </div>
        )}
      </div>
    </div>
  );
}
