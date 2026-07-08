import { Sparkline } from './Sparkline';
import { theme, hexA } from '../theme/tokens';
import { useActiveBatches } from '../hooks/useBrewery';
import { isActiveBrew } from '../types/domain';

/**
 * A dedicated, roomy charts dashboard — the home for big trend graphs that the
 * dense overview cards can't fit (alert rows there steal chart height). One
 * column per fermenting tank; each shows a large gravity curve + beer-temp curve
 * with axes/labels room. Non-fermenting tanks are skipped (nothing to plot).
 */
export function GraphsView() {
  const { tanks, batches } = useActiveBatches();

  const plottable = tanks
    .map((tank, i) => ({ tank, batch: batches[i] }))
    .filter(({ tank, batch }) => isActiveBrew(tank.status) && batch && batch.history.length >= 2);

  if (plottable.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: theme.font.mono, fontSize: 14, color: theme.color.textDim,
      }}>
        No fermenting batches to graph.
      </div>
    );
  }

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'grid',
      gridTemplateColumns: `repeat(${plottable.length}, 1fr)`,
      gap: 12,
    }}>
      {plottable.map(({ tank, batch }) => {
        const b = batch!;
        const sg = b.history.map((r) => r.sg);
        const temp = b.history.map((r) => r.tempF);
        return (
          <div key={tank.id} style={{
            background: theme.color.panelHi,
            border: `1px solid ${theme.color.panelBorderHi}`,
            borderTop: `2px solid ${theme.color.cyan}`,
            borderRadius: theme.radius.lg,
            padding: 16,
            display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexShrink: 0 }}>
              <span style={{ fontFamily: theme.font.mono, fontSize: 15, fontWeight: 700, color: theme.color.text }}>
                {tank.label}
              </span>
              <span style={{ fontFamily: theme.font.mono, fontSize: 11, color: theme.color.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {b.name} · DAY {b.daysFermenting?.toFixed(1) ?? '—'}
              </span>
            </div>

            <BigChart
              label="Gravity" color={theme.color.cyan}
              data={sg} reference={b.expectedFg ?? null} refLabel="FG"
              current={b.gravity.value != null ? b.gravity.value.toFixed(3) : '—'}
            />
            <BigChart
              label="Beer temp" color={theme.color.green}
              data={temp} reference={b.setpoint.value ?? null} refLabel="Setpt" refColor={theme.color.amber}
              current={b.beerTemp.value != null ? `${b.beerTemp.value.toFixed(1)}°F` : '—'}
            />
          </div>
        );
      })}
    </div>
  );
}

function BigChart({ label, color, data, reference, refLabel, refColor, current }: {
  label: string; color: string; data: number[]; reference: number | null;
  refLabel: string; refColor?: string; current: string;
}) {
  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
      background: theme.color.inset, borderRadius: theme.radius.md,
      border: `1px solid ${theme.color.panelBorder}`, padding: '10px 12px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, flexShrink: 0 }}>
        <span style={{ fontFamily: theme.font.sans, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase', color: theme.color.textLabel }}>{label}</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          {reference != null && (
            <span style={{ fontFamily: theme.font.mono, fontSize: 10, color: refColor ?? theme.color.amber }}>
              {refLabel} {reference.toFixed(reference < 2 ? 3 : 1)}
            </span>
          )}
          <span style={{ fontFamily: theme.font.mono, fontSize: 15, fontWeight: 600, color, fontVariantNumeric: 'tabular-nums', textShadow: `0 0 10px ${hexA(color, 0.4)}` }}>{current}</span>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Sparkline data={data} color={color} reference={reference} referenceColor={refColor}
          width={640} height={200} responsive ariaLabel={`${label} (graphs view)`} />
      </div>
    </div>
  );
}
