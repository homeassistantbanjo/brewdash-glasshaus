import { useState } from 'react';
import { Metric } from './Metric';
import { ConicalFermenter, VesselState } from './ConicalFermenter';
import { SetpointControl } from './SetpointControl';
import { MetricDetail, MetricDetailSpec } from './MetricDetail';
import { EquipmentChip } from './EquipmentStrip';
import { theme, stateColor, hexA } from '../theme/tokens';
import { ActiveBatch, AlertSeverity, EquipmentPower, Tank, isActiveBrew } from '../types/domain';

/**
 * One fermenter as a vertical CARD in the 3-column grid. Fermenting tanks show
 * the animated vessel + full metric stack + sparklines; idle tanks show a calm
 * empty-vessel card with their lifecycle status. Designed to fit a ~610×870
 * column at 1080p with no scroll.
 */
export function TankCard({ tank, batch, controllerPower, focused, onClick }: {
  tank: Tank; batch: ActiveBatch | null;
  controllerPower: EquipmentPower | null;
  /** when true (alert-bar click), the card pulses/highlights briefly */
  focused?: boolean;
  onClick: () => void;
}) {
  // "active brew" = Fermenting OR Cold Crashing — both hold live beer and get the
  // full data card. (Named `fermenting` for legacy reasons; means active-brew.)
  const fermenting = isActiveBrew(tank.status) && batch != null;
  const crashing = tank.status === 'Cold Crashing';

  // --- resolve vessel + accent state (color === state) ---
  const dev = batch ? (batch.probeTemp.value ?? 0) - (batch.setpoint.value ?? 0) : 0;
  const onProfile = Math.abs(dev) < 1.5;
  const alerts = batch?.alerts ?? [];
  // alerts are pre-sorted most-severe-first, so the first one sets the tone
  const topAlert = alerts[0];
  const hasProblem = alerts.some((a) => a.severity === 'problem');
  // Prefer HA's settling-proof "fermentation started" latch when available;
  // otherwise fall back to the in-app noise/velocity heuristic.
  const active = !!batch && (
    batch.fermentationStarted != null
      ? batch.fermentationStarted
      : (batch.gravityNoise != null && batch.gravityNoise > 0.0005) ||
        (batch.gravityVelocityPerDay != null && batch.gravityVelocityPerDay < -0.001)
  );

  // Vessel color reflects the situation: an active alert tints the vessel by its
  // severity (problem→red, warning→amber, milestone→cyan) so the card visibly
  // signals WHICH tank is notable — echoing the top alert bar. Off-profile (no
  // alert) still reads red. Otherwise green (or cyan while actively chilling).
  let vessel: VesselState;
  if (!fermenting) {
    vessel = tank.status === 'Dirty' ? 'warn'
      : tank.status === 'Out of Service' ? 'idle'
      : 'empty';
  } else if (hasProblem) {
    vessel = 'fault';                              // problem alert → RED
  } else if (crashing) {
    vessel = 'cooling';                            // cold crashing → CYAN (cold, by design)
  } else if (!onProfile) {
    vessel = 'fault';                              // off-profile fermentation → RED
  } else if (topAlert?.severity === 'warning') {
    vessel = 'warn';                               // warning alert → AMBER
  } else if (topAlert?.severity === 'milestone') {
    vessel = 'cooling';                            // milestone (good) → CYAN accent
  } else if (dev < -0.5) {
    vessel = 'cooling';                            // below setpoint, chilling → cyan
  } else {
    vessel = 'healthy';                            // on-profile fermenting → GREEN
  }
  const accent = {
    healthy: theme.color.green, cooling: theme.color.cyan, warn: theme.color.amber,
    fault: theme.color.red, idle: theme.color.textDim, empty: theme.color.textFaint,
  }[vessel];

  const sgSeries = batch?.history.map((r) => r.sg) ?? [];

  // metric-detail popup state + spec builders
  const [detail, setDetail] = useState<MetricDetailSpec | null>(null);
  const open = (spec: MetricDetailSpec) => setDetail(spec);
  const b = batch; // shorthand for the specs below (only used when fermenting)

  return (
    <div style={{
      background: theme.color.panelHi,
      backdropFilter: `blur(${theme.blur})`,
      WebkitBackdropFilter: `blur(${theme.blur})`,
      border: `1px solid ${focused ? hexA(accent, 0.8) : theme.color.panelBorderHi}`,
      borderTop: `2px solid ${accent}`,
      borderRadius: theme.radius.lg,
      // focus (from an alert-bar click) overrides with a strong accent glow so
      // the eye jumps to the offending tank; otherwise normal depth shadow.
      boxShadow: focused
        ? theme.glow(accent, 0.7)
        : fermenting
          ? `0 8px 40px rgba(0,0,0,0.5), inset 0 1px 0 ${hexA('#ffffff', 0.04)}`
          : `0 4px 20px rgba(0,0,0,0.4)`,
      transition: 'box-shadow 0.2s, border-color 0.2s',
      display: 'flex', flexDirection: 'column',
      // The card FITS its column at any viewport — no internal scroll. Fixed
      // sections (hero, grid, setpoint, controller) take natural height; the
      // sparkline region flexes to fill/absorb whatever's left (see below), so a
      // short display (e.g. 1080p fullscreen at 150% scaling ≈ 720px) compresses
      // the trends rather than spawning a scrollbar. overflow hidden = hard no-scroll.
      overflow: 'hidden', height: '100%', minHeight: 0,
    }}>
      {/* header — tank label · status · explicit ⚙ Manage button (opens the
          Assign/Program modal). The card body is NOT clickable; only metrics
          (detail popups) and this button do anything, so it's unambiguous. */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 12px 8px', gap: 8,
      }}>
        <span style={{ fontFamily: theme.font.mono, fontSize: 13, fontWeight: 700, color: theme.color.text, letterSpacing: 0.5 }}>
          {tank.label}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            fontFamily: theme.font.mono, fontSize: 10, letterSpacing: 1,
            textTransform: 'uppercase', color: accent, fontWeight: 600,
          }}>
            {crashing ? '❄ COLD CRASH' : fermenting ? phaseGuess(batch!) : tank.status}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            title={`Manage ${tank.label}`}
            style={{
              fontFamily: theme.font.mono, fontSize: 10, letterSpacing: 0.5,
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 9px', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${theme.color.panelBorderHi}`,
              background: theme.color.inset, color: theme.color.textLabel,
            }}>
            <span style={{ fontSize: 12 }}>⚙</span> MANAGE
          </button>
        </div>
      </div>

      {/* HERO vessel — the big glanceable status signal. Flanked by the two
          headline readouts (gravity + attenuation progress) so it dominates.
          The vessel has a fixed comfortable size (never collapses into the text);
          if the whole card is too short for a windowed browser, the card body
          scrolls internally (see the scroll wrapper below) rather than crushing
          the hero. Optimized for fullscreen/kiosk where it all fits with no scroll. */}
      <div style={{
        flexShrink: 0,
        display: 'flex', gap: 10, padding: '4px 16px 0', alignItems: 'center',
        justifyContent: 'center',
      }}>
        {fermenting ? (
          <>
            {/* left headline: live gravity */}
            <HeadlineStat align="right"
              value={fmt(batch!.gravity.value, 3)} color={theme.color.cyan}
              label={`→ FG ${batch!.expectedFg?.toFixed(3) ?? '—'}`} sub="GRAVITY" big
              onClick={() => open({
                label: 'Gravity', value: fmt(b!.gravity.value, 3), color: theme.color.cyan,
                blurb: 'Live specific gravity from the Tilt. Falls from the original gravity (OG) toward the expected final gravity (FG) as yeast ferment sugars. The full fermentation curve below is from Brewfather’s reading history.',
                series: sgSeries, seriesLabel: 'Gravity curve (full ferment)',
                reference: b!.expectedFg ?? null, referenceLabel: 'FG', referenceColor: theme.color.amber,
                facts: [
                  { k: 'OG', v: b!.og?.toFixed(3) ?? '—' },
                  { k: 'Expected FG', v: b!.expectedFg?.toFixed(3) ?? '—' },
                  { k: 'Velocity', v: velStr(b!.gravityVelocityPerDay) + ' SG/day' },
                  { k: 'ETA to terminal', v: b!.daysToTerminal != null ? b!.daysToTerminal.toFixed(1) + ' d' : '—' },
                ],
                source: `Tilt ${b!.tiltColor ?? '?'} · sensor.tilt_${(b!.tiltColor ?? '').toLowerCase()}_gravity`,
              })} />
            <ConicalFermenter state={vessel} fillPct={batch!.attenuationProgress ?? null}
              active={active} width={116} height={176} />
            {/* right headline: attenuation progress */}
            <HeadlineStat align="left"
              value={pct(batch!.attenuationProgress)} unit="%" color={theme.color.blue}
              label="TO FG" sub={`${fmt(batch!.attenuation, 0)}% ATTEN`} big
              onClick={() => open({
                label: 'Progress to FG', value: pct(b!.attenuationProgress), unit: '%', color: theme.color.blue,
                blurb: 'How far this batch has attenuated toward its expected final gravity. 100% means it has reached the target FG. Apparent attenuation is the yeast-spec figure.',
                series: sgSeries, seriesLabel: 'Gravity curve', reference: b!.expectedFg ?? null,
                referenceLabel: 'FG', referenceColor: theme.color.amber,
                facts: [
                  { k: 'Apparent attenuation', v: fmt(b!.attenuation, 1) + '%' },
                  { k: 'ABV so far', v: fmt(b!.abv, 1) + '%' },
                  { k: 'Days fermenting', v: b!.daysFermenting?.toFixed(1) ?? '—' },
                  { k: 'Phase', v: phaseGuess(b!) },
                ],
              })} />
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '20px 0' }}>
            <ConicalFermenter state={vessel} width={116} height={186} />
            <div style={{ fontFamily: theme.font.sans, fontSize: 13, color: theme.color.textDim, textAlign: 'center', padding: '0 12px' }}>
              {!tank.hasController ? 'No controller wired'
                /* status says active but no batch resolved (e.g. >1 fermenting → can't
                   auto-infer) — tell the user to assign, NOT "out of service". */
                : isActiveBrew(tank.status)
                  ? '⚠ Batch unassigned — ⚙ Manage to pick which beer is in this tank'
                  : idleNote(tank)}
            </div>
          </div>
        )}
      </div>

      {fermenting && (
        <div style={{
          textAlign: 'center', fontFamily: theme.font.mono, fontSize: 12,
          color: theme.color.textDim, padding: '2px 14px 0',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          <span style={{ color: theme.color.text, fontWeight: 700 }}>{batch!.name}</span>
          <span style={{ margin: '0 8px' }}>·</span>DAY {batch!.daysFermenting?.toFixed(1) ?? '—'}
          {batch!.tiltColor && (
            <>
              <span style={{ margin: '0 8px' }}>·</span>
              <span style={{ color: theme.color.purple }}>{batch!.tiltColor.toUpperCase()} TILT</span>
            </>
          )}
          {batch!.joinSource === 'inferred' && (
            <span style={{ color: theme.color.amber, marginLeft: 8 }}>◆ INFERRED</span>
          )}
        </div>
      )}

      {/* ALERT STACK — one row per active alert from HA (+ client-side suspect),
          colored by severity. A 'milestone' (e.g. near-terminal) is GOOD news,
          not a fault. Drives the vessel red only for 'problem' severity (above). */}
      {alerts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
          {alerts.map((al) => {
            const c = alertColor(al.severity);
            const glyph = al.severity === 'milestone' ? '◆' : al.severity === 'warning' ? '◇' : '⚠';
            const suffix = al.key === 'assignment_suspect'
              && batch!.verification.status === 'suspect'
              ? ` — ${batch!.verification.reason}` : '';
            return (
              <div key={al.key} style={{
                fontFamily: theme.font.mono, fontSize: 10, letterSpacing: 0.5,
                color: c, background: hexA(c, 0.08),
                padding: '4px 14px', display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span>{glyph}</span>
                <span style={{ fontWeight: 700 }}>{al.label}</span>
                <span style={{ color: theme.color.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{suffix}</span>
              </div>
            );
          })}
        </div>
      )}

      {fermenting && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 7, padding: '8px 14px 10px',
          flex: 1, minHeight: 0,   // fill the card; let the sparkline region absorb slack
        }}>
          {/* Essential telemetry — 2 rows of 4. Trimmed from 12 cells: dropped
              the standalone Beer·Tilt (now the temp sparkline), the small Setpoint
              cell (the full-width control below owns setpoint), the noise "Activity"
              cell (phase on the ring + the pulsing vessel already say "active"), and
              the 24h range (lives in the Probe detail popup). Temp is now Probe +
              the Tilt−Probe delta (assignment sanity), not probe-vs-setpoint. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5 }}>
            <Metric value={fmt(batch!.abv, 1)} unit="%" label="ABV" size="sm" />
            <Metric value={batch!.og ? batch!.og.toFixed(3) : '—'} label="OG" size="sm" />
            <Metric value={velStr(batch!.gravityVelocityPerDay)} label="SG/day" size="sm"
              color={velColor(batch!.gravityVelocityPerDay)} glow={active}
              onClick={() => open({
                label: 'Fermentation velocity', value: velStr(b!.gravityVelocityPerDay), unit: ' SG/day',
                color: velColor(b!.gravityVelocityPerDay),
                blurb: 'Specific gravity dropped per day (e.g. -0.010 = 10 points). More negative = faster attenuation. Near zero = fermentation has stalled or finished. Drives the ETA-to-terminal estimate.',
                series: sgSeries, seriesLabel: 'Gravity curve', reference: b!.expectedFg ?? null,
                referenceLabel: 'FG', referenceColor: theme.color.amber,
                facts: [
                  { k: '3h activity (stddev)', v: noiseStr(b!.gravityNoise) },
                  { k: 'ETA to terminal', v: b!.daysToTerminal != null ? b!.daysToTerminal.toFixed(1) + ' d' : '—' },
                ],
              })} />
            <Metric
              value={fgEtaValue(batch!)}
              label={batch!.projectedFgReach ? 'FG By' : 'ETA'} size="sm"
              color={theme.color.cyan}
              onClick={() => open({
                label: 'Projected finish', value: fgEtaValue(b!), color: theme.color.cyan,
                blurb: b!.projectedFgReach
                  ? 'Projected calendar date this batch reaches its expected final gravity, from the current attenuation velocity (HA-derived, settling-proof).'
                  : 'Estimated days until terminal gravity at the current velocity.',
                facts: [
                  { k: 'Days to terminal', v: b!.daysToTerminal != null ? b!.daysToTerminal.toFixed(1) + ' d' : '—' },
                  { k: 'Projected date', v: b!.projectedFgReach ?? '—' },
                  { k: 'Velocity', v: velStr(b!.gravityVelocityPerDay) + ' SG/day' },
                  { k: 'Expected FG', v: b!.expectedFg?.toFixed(3) ?? '—' },
                ],
              })} />

            <Metric value={fmt(batch!.probeTemp.value, 1)} unit="°F" label="Probe" size="sm"
              color={onProfile ? stateColor('ok') : stateColor('bad')} glow={!onProfile}
              staleness={batch!.probeTemp.staleness}
              onClick={() => open(tempSpec('Probe temp (ITC-308)', b!.probeTemp.value, onProfile ? theme.color.green : theme.color.red, b!))} />
            <Metric value={tiltProbeDeltaStr(batch!)} unit="°F" label="Δ Tilt−Probe" size="sm"
              color={tiltProbeDeltaColor(batch!)} glow={tiltProbeSuspect(batch!)}
              onClick={() => open(tempSpec('Tilt vs Probe', b!.beerTemp.value, theme.color.green, b!))} />
            <Metric value={paceValue(batch!.paceVsSchedule)} unit="d" label="Pace" size="sm"
              color={paceColor(batch!.paceVsSchedule)}
              onClick={batch!.paceVsSchedule == null ? undefined : () => open({
                label: 'Pace vs schedule', value: paceValue(b!.paceVsSchedule), unit: ' days',
                color: paceColor(b!.paceVsSchedule),
                blurb: 'How many days ahead (+) or behind (−) the Brewfather fermentation schedule this batch is, by attenuation progress. Positive = attenuating faster than planned.',
                facts: [
                  { k: 'Projected FG date', v: b!.projectedFgReach ?? '—' },
                  { k: 'Days fermenting', v: b!.daysFermenting?.toFixed(1) ?? '—' },
                ],
              })} />
            <Metric value={tank.daysSinceCleaned != null ? String(tank.daysSinceCleaned) : '—'} unit="d"
              label="Clean" size="sm" />
          </div>

          {/* 3rd row — genuinely PER-TANK diagnostics (chiller cycles/runtime are
              plant-wide → moved to the top strip). 24h temp swing, settling-proof
              attenuation (gravity drop from 8h peak), Tilt reading freshness, and
              live CO₂ activity. Dim '—' when the derived package value is absent. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5 }}>
            <Metric value={rangeStrCompact(batch!.beerTemp24h)} unit="°F" label="24h °F" size="sm"
              onClick={() => open(tempSpec('Beer temp — 24h range', b!.beerTemp.value, theme.color.green, b!))} />
            <Metric value={batch!.gravityDropFromPeak != null ? batch!.gravityDropFromPeak.toFixed(1) : '—'} unit="pts"
              label="Drop/Peak" size="sm" color={theme.color.cyan} />
            <Metric value={ageStr(batch!.tiltGravityAgeMin)}
              label="Tilt Age" size="sm"
              color={batch!.tiltGravityAgeMin != null && batch!.tiltGravityAgeMin > 15 ? stateColor('warn') : theme.color.textDim} />
            <Metric value={noiseStr(batch!.gravityNoise)} label="Activity" size="sm"
              color={active ? stateColor('ok') : theme.color.textDim} glow={active} />
          </div>

          {/* setpoint control — the one write action on the card face, and the
              single home for the setpoint number (no redundant setpoint cell). */}
          {tank.hasController && (
            <SetpointControl tankId={tank.id} current={batch!.setpoint.value} />
          )}

          {/* this tank's OWN temp-controller power — cooling(pump)/heating/idle
              from wattage, with today/lifetime kWh. Lives here, not in the top
              strip, so it scales to N tanks without crowding. */}
          {controllerPower && <EquipmentChip eq={controllerPower} />}

          {/* Trends are NOT drawn inline here — they crunched when alert rows
              appeared. Tap any metric for its full-ferment chart (MetricDetail),
              or open the dedicated Graphs view. This spacer just absorbs slack so
              the fixed content sits at the top and the card never overflows. */}
          <div style={{ flex: 1, minHeight: 0 }} />
        </div>
      )}

      {detail && <MetricDetail spec={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

/** A large flanking headline number beside the hero vessel. */
function HeadlineStat({ value, unit, label, sub, color, align, big, onClick }: {
  value: string; unit?: string; label: string; sub?: string; color: string;
  align: 'left' | 'right'; big?: boolean; onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      title={onClick ? `${label} — details` : undefined}
      style={{
      display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0,
      textAlign: align, alignItems: align === 'right' ? 'flex-end' : 'flex-start',
      cursor: onClick ? 'pointer' : undefined,
    }}>
      <div style={{
        fontFamily: theme.font.mono, fontSize: big ? 34 : 24, fontWeight: 600, lineHeight: 1,
        color, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        textShadow: `0 0 16px ${hexA(color, 0.4)}`,
      }}>
        {value}{unit && <span style={{ fontSize: big ? 16 : 12, color: theme.color.textDim }}>{unit}</span>}
      </div>
      <div style={{ fontFamily: theme.font.sans, fontSize: 9.5, letterSpacing: 1, textTransform: 'uppercase', color: theme.color.textLabel, marginTop: 4 }}>
        {label}
      </div>
      {sub && <div style={{ fontFamily: theme.font.mono, fontSize: 10, color: theme.color.textFaint, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/** Alert severity → color. problem=red, warning=amber, milestone=cyan (good news). */
export function alertColor(s: AlertSeverity): string {
  return s === 'problem' ? theme.color.red
    : s === 'warning' ? theme.color.amber
    : theme.color.cyan;
}

function phaseGuess(b: ActiveBatch): string {
  if (b.attenuation == null) return 'UNKNOWN';
  if (b.attenuation < 30) return 'LAG';
  if (b.attenuation < 60) return 'ACTIVE';
  if (b.attenuation < 78) return 'SLOWING';
  return 'TERMINAL';
}
function idleNote(tank: Tank): string {
  if (tank.status === 'Dirty') return tank.daysSinceCleaned != null ? `Dirty ${tank.daysSinceCleaned}d — clean it` : 'Needs cleaning';
  if (tank.status === 'Ready' && (tank.daysSinceCleaned ?? 0) > 30) return `Clean ${tank.daysSinceCleaned}d ago — re-sanitize?`;
  if (tank.status === 'Ready') return 'Ready for a batch';
  return 'Out of service';
}
/** Shared detail spec for the temperature metrics — both show the temp-vs-
 *  setpoint curve so you can see how well the controller is holding profile. */
function tempSpec(label: string, value: number | null, color: string, b: ActiveBatch): MetricDetailSpec {
  const dev = (b.probeTemp.value ?? 0) - (b.setpoint.value ?? 0);
  return {
    label, value: fmt(value, 1), unit: '°F', color,
    blurb: 'Beer temperature from the Tilt vs. the tank probe (ITC-308) vs. the setpoint. A large probe-vs-Tilt gap can mean the wrong Tilt is assigned; probe drifting off setpoint means the controller is fighting the glycol loop.',
    series: b.history.map((r) => r.tempF), seriesLabel: 'Beer temp (full ferment)',
    reference: b.setpoint.value ?? null, referenceLabel: 'Setpoint', referenceColor: theme.color.amber,
    facts: [
      { k: 'Beer (Tilt)', v: fmt(b.beerTemp.value, 1) + ' °F' },
      { k: 'Probe (ITC-308)', v: fmt(b.probeTemp.value, 1) + ' °F' },
      { k: 'Setpoint', v: fmt(b.setpoint.value, 1) + ' °F' },
      { k: 'Deviation', v: (dev >= 0 ? '+' : '') + dev.toFixed(1) + ' °F' },
      { k: '24h range', v: rangeStr(b.beerTemp24h) + ' °F' },
      { k: 'Brewfather target', v: b.targetTemp?.value != null ? b.targetTemp.value.toFixed(1) + ' °F' : '—' },
    ],
  };
}

function fmt(n: number | null, dp: number): string { return n == null ? '—' : n.toFixed(dp); }
/** minutes-ago → compact "3m" / "2h" / ">1d". For Tilt reading freshness. */
function ageStr(min: number | null): string {
  if (min == null) return '—';
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return '>1d';
}
function pct(n: number | null): string { return n == null ? '—' : String(Math.round(n)); }

/** Prefer HA's projected calendar date; fall back to in-app days-to-terminal. */
function fgEtaValue(b: ActiveBatch): string {
  if (b.projectedFgReach) {
    if (b.projectedFgReach === 'reached') return 'DONE';
    if (b.projectedFgReach === 'stalled') return '—';
    return b.projectedFgReach;                       // e.g. 'Jul 8'
  }
  return b.daysToTerminal != null ? b.daysToTerminal.toFixed(1) + 'd' : '—';
}
/** Pace vs schedule: +ahead / -behind, in days. */
function paceValue(p: number | null): string {
  if (p == null) return '—';
  return (p >= 0 ? '+' : '') + p.toFixed(1);
}
function paceColor(p: number | null): string {
  if (p == null) return theme.color.textDim;
  if (p >= 0.5) return theme.color.green;   // ahead of plan
  if (p <= -1) return theme.color.amber;    // meaningfully behind
  return theme.color.text;                  // roughly on schedule
}
function rangeStr(r: { min: number | null; max: number | null }): string {
  if (r.min == null || r.max == null) return '—';
  return `${r.min.toFixed(1)}–${r.max.toFixed(1)}`;
}
/** Compact range for the narrow 3rd-row cell: integers, no decimals (a 24h swing
 *  doesn't need 0.1° precision, and the tenths overflowed the small cell). */
function rangeStrCompact(r: { min: number | null; max: number | null }): string {
  if (r.min == null || r.max == null) return '—';
  return `${Math.round(r.min)}–${Math.round(r.max)}`;
}
/** Tilt (beer) minus Probe (ITC-308) temp. Small = the assigned Tilt is
 *  plausibly in this tank; a large gap suggests the wrong Tilt is assigned. */
function tiltProbeDelta(b: ActiveBatch): number | null {
  if (b.beerTemp.value == null || b.probeTemp.value == null) return null;
  return b.beerTemp.value - b.probeTemp.value;
}
function tiltProbeDeltaStr(b: ActiveBatch): string {
  const d = tiltProbeDelta(b);
  if (d == null) return '—';
  return (d >= 0 ? '+' : '') + d.toFixed(1);
}
const TILT_PROBE_SUSPECT_F = 5.0; // matches HA gh_tank1_assignment_suspect
function tiltProbeSuspect(b: ActiveBatch): boolean {
  const d = tiltProbeDelta(b);
  return d != null && Math.abs(d) > TILT_PROBE_SUSPECT_F;
}
function tiltProbeDeltaColor(b: ActiveBatch): string {
  const d = tiltProbeDelta(b);
  if (d == null) return theme.color.textDim;
  if (Math.abs(d) > TILT_PROBE_SUSPECT_F) return theme.color.red;   // likely wrong Tilt
  if (Math.abs(d) > 2.5) return theme.color.amber;                  // watch
  return theme.color.green;                                          // agree
}
// Velocity shown as raw SG/day (e.g. -0.010), matching how gravity reads
// elsewhere. Value is already SG/day; 3 decimals = 1-point resolution.
function velStr(v: number | null): string { if (v == null) return '—'; return (v >= 0 ? '+' : '') + v.toFixed(3); }
function velColor(v: number | null): string {
  if (v == null) return theme.color.textDim;
  if (v < -0.001) return theme.color.green;
  if (v > 0.001) return theme.color.red;
  return theme.color.textDim;
}
function noiseStr(sd: number | null): string {
  if (sd == null) return '—';
  if (sd > 0.002) return 'ACTIVE';
  if (sd > 0.0005) return 'SLOW';
  return 'STILL';
}
