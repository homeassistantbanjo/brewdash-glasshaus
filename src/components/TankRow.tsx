import { Metric } from './Metric';
import { Sparkline } from './Sparkline';
import { theme, stateColor, hexA } from '../theme/tokens';
import { ActiveBatch, Tank, TankStatus } from '../types/domain';

// ---------------------------------------------------------------------------
// MAX-DENSITY fermenting row — the command-center centerpiece
// ---------------------------------------------------------------------------

export function TankRow({ tank, batch }: { tank: Tank; batch: ActiveBatch }) {
  const dev = (batch.probeTemp.value ?? 0) - (batch.setpoint.value ?? 0);
  const onProfile = Math.abs(dev) < 1.5;
  const suspect = batch.verification.status === 'suspect';

  // active = meaningful gravity noise OR meaningful downward velocity
  const active = (batch.gravityNoise != null && batch.gravityNoise > 0.0005)
    || (batch.gravityVelocityPerDay != null && batch.gravityVelocityPerDay < -0.001);

  // sparkline series from the reading history (oldest→newest)
  const sgSeries = batch.history.map((r) => r.sg);
  const tempSeries = batch.history.map((r) => r.tempF);

  // probe vs tilt cross-check
  const xdelta = (batch.probeTemp.value != null && batch.beerTemp.value != null)
    ? batch.probeTemp.value - batch.beerTemp.value : null;

  const phaseColor = {
    Active: theme.color.blue, Slowing: theme.color.amber,
    Terminal: theme.color.green, Lag: theme.color.textDim,
  } as Record<string, string>;

  const accent = theme.color.amber;

  return (
    <div style={{
      background: theme.color.panelHi,
      backdropFilter: `blur(${theme.blur})`,
      WebkitBackdropFilter: `blur(${theme.blur})`,
      border: `1px solid ${theme.color.panelBorderHi}`,
      borderLeft: `2px solid ${accent}`,
      borderRadius: theme.radius.lg,
      boxShadow: `0 8px 40px rgba(0,0,0,0.5), inset 0 1px 0 ${hexA('#ffffff', 0.04)}`,
      overflow: 'hidden',
    }}>
      {/* header bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '12px 16px 10px',
        borderBottom: `1px solid ${theme.color.panelBorder}`,
        background: `linear-gradient(180deg, ${hexA(accent, 0.06)}, transparent)`,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontFamily: theme.font.sans, fontSize: 16, fontWeight: 700, color: theme.color.text }}>
            {batch.name}
          </span>
          <span style={{
            fontFamily: theme.font.mono, fontSize: 11, color: accent,
            border: `1px solid ${hexA(accent, 0.3)}`, borderRadius: 4, padding: '1px 6px',
          }}>{tank.label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontFamily: theme.font.mono, fontSize: 11 }}>
          {batch.joinSource === 'inferred' && (
            <span title="Batch inferred from the sole fermenting Brewfather batch — assign explicitly in the panel"
              style={{
                color: theme.color.amber, border: `1px solid ${hexA(theme.color.amber, 0.35)}`,
                borderRadius: 4, padding: '1px 5px', fontSize: 10,
              }}>◆ INFERRED</span>
          )}
          <span style={{ color: phaseColor[batch_phaseGuess(batch)] ?? theme.color.textDim, fontWeight: 600 }}>
            ● {batch_phaseGuess(batch).toUpperCase()}
          </span>
          <span style={{ color: theme.color.textDim }}>DAY {batch.daysFermenting?.toFixed(1) ?? '—'}</span>
        </div>
      </div>

      {suspect && (
        <div style={{
          fontFamily: theme.font.mono, fontSize: 11, color: theme.color.red,
          background: hexA(theme.color.red, 0.08), padding: '6px 16px',
          borderBottom: `1px solid ${hexA(theme.color.red, 0.2)}`,
        }}>
          ⚠ ASSIGNMENT SUSPECT — {batch.verification.status === 'suspect' ? batch.verification.reason : ''}
        </div>
      )}

      {/* dense metric grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(6, 1fr)',
        gap: 6,
        padding: 12,
      }}>
        <Metric value={fmt(batch.gravity.value, 3)} label="Gravity" size="lg"
          color={theme.color.cyan} glow staleness={batch.gravity.staleness} />
        <Metric value={fmt(batch.abv, 1)} unit="%" label="ABV" size="lg" />
        <Metric value={fmt(batch.attenuation, 0)} unit="%" label="Atten" size="lg" />
        <Metric value={fmt(batch.beerTemp.value, 1)} unit="°F" label="Beer · Tilt"
          staleness={batch.beerTemp.staleness} />
        <Metric value={fmt(batch.probeTemp.value, 1)} unit="°F" label="Probe"
          color={onProfile ? stateColor('ok') : stateColor('bad')} glow={!onProfile}
          staleness={batch.probeTemp.staleness} />
        <Metric value={fmt(batch.setpoint.value, 1)} unit="°F" label="Setpoint"
          color={theme.color.amber} staleness={batch.setpoint.staleness} />

        {/* second row — the deeper telemetry */}
        <Metric value={batch.og ? batch.og.toFixed(3) : '—'} label="OG" size="sm" />
        <Metric value={batch.expectedFg ? batch.expectedFg.toFixed(3) : '—'} label="Target FG" size="sm" />
        <Metric value={xdelta != null ? (xdelta >= 0 ? '+' : '') + xdelta.toFixed(1) : '—'} unit="°F"
          label="Probe−Tilt" size="sm"
          color={xdelta != null && Math.abs(xdelta) > 3 ? stateColor('warn') : theme.color.textDim} />
        <Metric value={onProfile ? 'HOLD' : (dev >= 0 ? '+' + dev.toFixed(1) : dev.toFixed(1))}
          label="Deviation" size="sm"
          color={onProfile ? stateColor('ok') : stateColor('bad')} />
        <Metric value={tank.daysSinceCleaned != null ? String(tank.daysSinceCleaned) : '—'} unit="d"
          label="Since Clean" size="sm" />
        <Metric value={batch.tiltColor ?? '—'} label="Tilt" size="sm"
          color={theme.color.purple} />

        {/* third row — velocity / trend / projection (the sexy data) */}
        <Metric value={velocityStr(batch.gravityVelocityPerDay)} label="Velocity/d" size="sm"
          color={velocityColor(batch.gravityVelocityPerDay)}
          glow={active} />
        <Metric value={batch.daysToTerminal != null ? batch.daysToTerminal.toFixed(1) : '—'} unit="d"
          label="ETA Terminal" size="sm" color={theme.color.cyan} />
        <Metric value={batch.attenuationProgress != null ? String(batch.attenuationProgress) : '—'} unit="%"
          label="To FG" size="sm"
          color={batch.attenuationProgress != null && batch.attenuationProgress >= 95 ? stateColor('ok') : theme.color.blue} />
        <Metric value={rangeStr(batch.beerTemp24h)} unit="°F" label="24h Range" size="sm" />
        <Metric value={noiseStr(batch.gravityNoise)} label="Activity" size="sm"
          color={active ? stateColor('ok') : theme.color.textDim} />
        <Metric value={batch.attenuation != null ? batch.attenuation.toFixed(1) : '—'} unit="%"
          label="App. Atten" size="sm" />
      </div>

      {/* trend strip — inline sparklines from the Brewfather reading history */}
      {sgSeries.length >= 2 && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6,
          padding: '0 12px 12px',
        }}>
          <TrendCell label="Gravity curve" color={theme.color.cyan}
            head={fmt(batch.gravity.value, 3)}
            data={sgSeries} reference={batch.expectedFg ?? null} refLabel="FG" />
          <TrendCell label="Beer temp vs setpoint" color={theme.color.green}
            head={fmt(batch.beerTemp.value, 1)} headUnit="°F"
            data={tempSeries} reference={batch.setpoint.value ?? null} refLabel="SP"
            refColor={theme.color.amber} />
        </div>
      )}
    </div>
  );
}

/** A labeled sparkline cell for the trend strip. */
function TrendCell({ label, color, data, reference, refLabel, refColor, head, headUnit }: {
  label: string; color: string; data: number[]; reference: number | null;
  refLabel: string; refColor?: string; head: string; headUnit?: string;
}) {
  return (
    <div style={{
      background: theme.color.inset, borderRadius: theme.radius.sm,
      border: `1px solid ${theme.color.panelBorder}`, padding: '8px 10px',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4,
      }}>
        <span style={{
          fontFamily: theme.font.sans, fontSize: 9.5, letterSpacing: 0.8,
          textTransform: 'uppercase', color: theme.color.textLabel,
        }}>{label}</span>
        <span style={{ fontFamily: theme.font.mono, fontSize: 13, color, fontVariantNumeric: 'tabular-nums' }}>
          {head}{headUnit && <span style={{ fontSize: 9, color: theme.color.textDim }}>{headUnit}</span>}
          {reference != null && (
            <span style={{ color: refColor ?? theme.color.amber, fontSize: 10, marginLeft: 6 }}>
              {refLabel} {reference.toFixed(reference < 2 ? 3 : 1)}
            </span>
          )}
        </span>
      </div>
      <Sparkline data={data} color={color} reference={reference} referenceColor={refColor}
        width={400} height={40} ariaLabel={label} />
    </div>
  );
}

// crude local phase guess for display (real phase comes from HA sensor later)
function batch_phaseGuess(b: ActiveBatch): string {
  if (b.attenuation == null) return 'Unknown';
  if (b.attenuation < 30) return 'Lag';
  if (b.attenuation < 60) return 'Active';
  if (b.attenuation < 78) return 'Slowing';
  return 'Terminal';
}

function fmt(n: number | null, dp: number): string {
  return n == null ? '—' : n.toFixed(dp);
}

/** Velocity in gravity points/day (×1000 SG). Negative = attenuating (good). */
function velocityStr(v: number | null): string {
  if (v == null) return '—';
  const pts = v * 1000; // SG points/day
  return (pts >= 0 ? '+' : '') + pts.toFixed(1);
}
function velocityColor(v: number | null): string {
  if (v == null) return theme.color.textDim;
  if (v < -0.001) return theme.color.green;   // actively dropping
  if (v > 0.001) return theme.color.red;       // rising — off-profile / bad reading
  return theme.color.textDim;                  // stalled
}
function rangeStr(r: { min: number | null; max: number | null }): string {
  if (r.min == null || r.max == null) return '—';
  return `${r.min.toFixed(1)}–${r.max.toFixed(1)}`;
}
/** 3h gravity stddev → human activity label. */
function noiseStr(sd: number | null): string {
  if (sd == null) return '—';
  if (sd > 0.002) return 'ACTIVE';
  if (sd > 0.0005) return 'SLOW';
  return 'STILL';
}

// ---------------------------------------------------------------------------
// Thin strip for non-fermenting tanks
// ---------------------------------------------------------------------------

export function TankStrip({ tank }: { tank: Tank }) {
  const { statusColor, note } = stripMeta(tank);
  return (
    <div style={{
      background: theme.color.panel,
      backdropFilter: `blur(${theme.blur})`,
      WebkitBackdropFilter: `blur(${theme.blur})`,
      border: `1px solid ${theme.color.panelBorder}`,
      borderLeft: `2px solid ${statusColor}`,
      borderRadius: theme.radius.md,
      padding: '11px 16px',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontFamily: theme.font.sans, fontSize: 14, fontWeight: 700, color: theme.color.text }}>
          {tank.label}
        </span>
        <span style={{
          fontFamily: theme.font.mono, fontSize: 10, letterSpacing: 1,
          color: statusColor, textTransform: 'uppercase',
        }}>{tank.status}</span>
        {!tank.hasController && (
          <span style={{ fontFamily: theme.font.mono, fontSize: 10, color: theme.color.textFaint }}>
            NO CONTROLLER
          </span>
        )}
      </div>
      {note && <span style={{ fontFamily: theme.font.mono, fontSize: 11, color: theme.color.amber }}>{note}</span>}
    </div>
  );
}

function stripMeta(tank: Tank): { statusColor: string; note: string | null } {
  switch (tank.status) {
    case 'Dirty':
      return { statusColor: theme.color.amber,
        note: tank.daysSinceCleaned != null ? `DIRTY ${tank.daysSinceCleaned}D` : 'NEEDS CLEANING' };
    case 'Ready':
      return { statusColor: theme.color.green,
        note: (tank.daysSinceCleaned ?? 0) > 30 ? `CLEAN ${tank.daysSinceCleaned}D AGO — RE-SANITIZE?` : null };
    case 'Out of Service':
      return { statusColor: theme.color.textFaint, note: null };
    default:
      return { statusColor: theme.color.textDim, note: null };
  }
}
