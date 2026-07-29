import { useEffect, useState } from 'react';
import { Sparkline } from './Sparkline';
import { theme, hexA } from '../theme/tokens';
import { useActiveBatches } from '../hooks/useBrewery';
import { BREWFATHER_URL } from '../config';

/**
 * Dedicated, roomy charts dashboard. Reads gravity + beer-temp history from OUR
 * VictoriaMetrics (via the brewfather sidecar's /series/:tank proxy) rather than
 * Brewfather's batch.history — VM is complete + every-tick + always available, whereas
 * Brewfather returned empty history for active batches (only one tank would graph). One
 * column per tank that has a batch. Titles are "Tank N - Beer".
 */
interface Series { gravity: { t: number; v: number }[]; temp: { t: number; v: number }[] }

export function GraphsView() {
  const { tanks, batches } = useActiveBatches();
  const [series, setSeries] = useState<Record<string, Series>>({});

  // tanks that currently hold a batch — these are what we graph (VM has their history)
  const withBatch = tanks
    .map((tank, i) => ({ tank, batch: batches[i] }))
    .filter(({ batch }) => batch != null);

  // fetch each tank's VM series (poll every 60s — ferment moves slowly)
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const out: Record<string, Series> = {};
      await Promise.all(withBatch.map(async ({ tank }) => {
        try {
          const r = await fetch(`${BREWFATHER_URL}/series/${encodeURIComponent(tank.id)}`, { signal: AbortSignal.timeout(9000) });
          if (r.ok) out[tank.id] = await r.json();
        } catch { /* leave prior */ }
      }));
      if (!cancelled) setSeries((prev) => ({ ...prev, ...out }));
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withBatch.map((x) => x.tank.id).join(',')]);

  if (withBatch.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: theme.font.mono, fontSize: 14, color: theme.color.textDim,
      }}>
        No tanks with an assigned batch to graph.
      </div>
    );
  }

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'grid',
      gridTemplateColumns: `repeat(${withBatch.length}, 1fr)`,
      gap: 12,
    }}>
      {withBatch.map(({ tank, batch }) => {
        const b = batch!;
        const vm = series[tank.id];
        // prefer VM series; fall back to Brewfather batch.history if VM hasn't loaded yet
        const sg = vm?.gravity?.length ? vm.gravity.map((p) => p.v) : b.history.map((r) => r.sg);
        const temp = vm?.temp?.length ? vm.temp.map((p) => p.v) : b.history.map((r) => r.tempF);
        const title = `${tank.label} - ${b.name}`;   // "Tank 3 - Piwo Grodziskie"
        return (
          <div key={tank.id} style={{
            background: theme.color.panelHi,
            border: `1px solid ${theme.color.panelBorderHi}`,
            borderTop: `2px solid ${theme.color.cyan}`,
            borderRadius: theme.radius.lg,
            padding: 16,
            display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexShrink: 0, gap: 8 }}>
              <span style={{
                fontFamily: theme.font.mono, fontSize: 14, fontWeight: 700, color: theme.color.text,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{title}</span>
              <span style={{ fontFamily: theme.font.mono, fontSize: 11, color: theme.color.textDim, flexShrink: 0 }}>
                DAY {b.daysFermenting?.toFixed(1) ?? '—'}{!sg.length ? ' · no data yet' : ''}
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
