import { useState } from 'react';
import { Metric } from './Metric';
import { Sparkline } from './Sparkline';
import { ConicalFermenter, VesselState } from './ConicalFermenter';
import { SetpointControl } from './SetpointControl';
import { MetricDetail, MetricDetailSpec } from './MetricDetail';
import { EquipmentChip } from './EquipmentStrip';
import { CornerBrackets, ScanLine } from './HudFrame';
import { ProgressRing } from './ProgressRing';
import { Panel } from './hud/Panel';
import { BarGauge, TickReadout } from './hud/Gauge';
import { theme, stateColor, hexA, textGlow, fx } from '../theme/tokens';
import { ActiveBatch, AlertSeverity, EquipmentPower, Tank, isActiveBrew } from '../types/domain';

/** A thin uppercase section divider used to group the card's telemetry into
 *  labeled bands (GRAVITY / TEMPERATURE / SCHEDULE / EQUIPMENT) — legible from
 *  across the room on the wall display, and the structure the tall layout needs. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, marginTop: 4,
    }}>
      <span style={{
        fontFamily: theme.font.sans, fontSize: 9, letterSpacing: 1.5,
        textTransform: 'uppercase', color: theme.color.textFaint, whiteSpace: 'nowrap',
      }}>{children}</span>
      <span style={{ flex: 1, height: 1, background: theme.color.panelBorder }} />
    </div>
  );
}

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

  // header status label: cold-crash / phase / lifecycle status
  const statusLabel = crashing ? '❄ COLD CRASH' : fermenting ? phaseGuess(batch!) : tank.status.toUpperCase();
  // a mono ID tag for the header — batch number when known, else the tank id
  const idTag = fermenting && batch!.batchNo != null ? `//${batch!.batchNo}` : `//${tank.id.replace('tank_', 'T')}`;

  return (
    <Panel accent={focused ? accent : hexA(accent, 0.85)}
      header={tank.label.toUpperCase()} status={statusLabel} statusColor={accent} id={idTag}
      glow={fermenting || focused}
      style={{
        position: 'relative',
        boxShadow: focused ? theme.glow(accent, 0.8) : undefined,
        transition: 'box-shadow 0.2s',
        overflow: 'hidden', height: '100%', minHeight: 0,
      }}>
      {/* HUD chrome — theme-gated (no-op on `command`): targeting-corner brackets
          + a slow scan-line sweep for active brews. */}
      <CornerBrackets color={hexA(accent, 0.7)} />
      {fermenting && <ScanLine color={accent} />}

      {/* Manage button — floated top-right over the panel header bar. */}
      <div style={{ position: 'absolute', top: 5, right: 10, zIndex: 2 }}>
          <button
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            title={`Manage ${tank.label}`}
            style={{
              fontFamily: theme.font.mono, fontSize: 10, letterSpacing: 0.5,
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 9px', borderRadius: fx().brackets ? 0 : 6, cursor: 'pointer',
              clipPath: fx().brackets ? 'polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px)' : undefined,
              border: `1px solid ${hexA(accent, 0.4)}`,
              background: theme.color.inset, color: theme.color.textLabel,
            }}>
            <span style={{ fontSize: 12 }}>⚙</span> MANAGE
          </button>
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
            {/* vessel wrapped in a HUD targeting ring (theme-gated) showing
                attenuation progress; ring sits behind, vessel centered over it. */}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 200, height: 216 }}>
              <ProgressRing pct={batch!.attenuationProgress ?? null} size={216} color={accent} active={active} />
              <ConicalFermenter state={vessel} fillPct={batch!.attenuationProgress ?? null}
                active={active} width={110} height={172} />
            </div>
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
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '16px 0' }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 200, height: 200 }}>
              {/* dim idle ring behind the empty vessel — reads as "system standby",
                  not dead space (HUD themes only; no-op elsewhere) */}
              <ProgressRing pct={null} size={200} color={accent} active={false} />
              <ConicalFermenter state={vessel} width={110} height={172} />
            </div>
            {/* STANDBY chip — glowing status pill instead of bare text */}
            <div style={{
              fontFamily: theme.font.mono, fontSize: 11, letterSpacing: 2, fontWeight: 700,
              textTransform: 'uppercase', color: accent, textShadow: textGlow(accent, 0.7),
              padding: '3px 12px', borderRadius: theme.radius.sm,
              border: `1px solid ${hexA(accent, 0.4)}`, background: hexA(accent, 0.06),
            }}>
              {tank.status === 'Dirty' ? '● NEEDS CLEANING'
                : isActiveBrew(tank.status) ? '● AWAITING ASSIGNMENT'
                : '● STANDBY'}
            </div>
            <div style={{ fontFamily: theme.font.sans, fontSize: 12.5, color: theme.color.textDim, textAlign: 'center', padding: '0 12px' }}>
              {!tank.hasController ? 'No controller wired'
                : isActiveBrew(tank.status)
                  ? '⚙ Manage to pick which beer is in this tank'
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
          display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 14px 10px',
          flex: 1, minHeight: 0,   // fill the card; sparkline regions absorb slack
        }}>
          {/* ── GRAVITY ── live SG cluster + the full-ferment gravity curve ─────── */}
          <SectionLabel>Gravity</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5 }}>
            <TickReadout value={velStr(batch!.gravityVelocityPerDay)} label="SG / day"
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
            {/* attenuation as a segmented BAR gauge — it has a natural 0–100 range */}
            <BarGauge value={fmt(batch!.attenuation, 0)} unit="%" label="Attenuation"
              pct={batch!.attenuation} color={theme.color.blue} glow={active}
              onClick={() => open({
                label: 'Apparent attenuation', value: fmt(b!.attenuation, 1), unit: '%', color: theme.color.blue,
                blurb: 'The yeast-spec figure: % of sugars fermented, (OG−SG)/(OG−1). Distinct from progress-to-FG.',
                series: sgSeries, seriesLabel: 'Gravity curve', reference: b!.expectedFg ?? null,
                referenceLabel: 'FG', referenceColor: theme.color.amber,
                facts: [
                  { k: 'OG', v: b!.og?.toFixed(3) ?? '—' },
                  { k: 'ABV so far', v: fmt(b!.abv, 1) + '%' },
                ],
              })} />
            <TickReadout value={fmt(batch!.abv, 1)} unit="%" label="ABV" />
          </div>
          {/* inline gravity curve (full ferment) with the FG reference line */}
          <div style={{ height: 46, minHeight: 34, flex: '0 1 auto' }}>
            <Sparkline data={sgSeries} responsive color={theme.color.cyan}
              reference={batch!.expectedFg ?? null} referenceColor={theme.color.amber}
              width={260} height={46} ariaLabel="Gravity curve" />
          </div>

          {/* ── TEMPERATURE ── probe / beer / setpoint on their own line + curve ── */}
          <SectionLabel>Temperature</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5 }}>
            <TickReadout value={fmt(batch!.probeTemp.value, 1)} unit="°F" label="Probe"
              color={onProfile ? stateColor('ok') : stateColor('bad')} glow={!onProfile}
              staleFlag={batch!.probeTemp.staleness !== 'live' ? batch!.probeTemp.staleness.toUpperCase() : null}
              onClick={() => open(tempSpec('Probe temp (ITC-308)', b!.probeTemp.value, onProfile ? theme.color.green : theme.color.red, b!))} />
            <TickReadout value={fmt(batch!.beerTemp.value, 1)} unit="°F" label="Beer (Tilt)"
              color={theme.color.green}
              staleFlag={batch!.beerTemp.staleness !== 'live' ? batch!.beerTemp.staleness.toUpperCase() : null}
              onClick={() => open(tempSpec('Beer temp (Tilt)', b!.beerTemp.value, theme.color.green, b!))} />
            <TickReadout value={fmt(batch!.setpoint.value, 1)} unit="°F" label="Setpoint"
              color={theme.color.amber} />
            <TickReadout value={tiltProbeDeltaStr(batch!)} unit="°F" label="Δ T−P"
              color={tiltProbeDeltaColor(batch!)} glow={tiltProbeSuspect(batch!)}
              onClick={() => open(tempSpec('Tilt vs Probe', b!.beerTemp.value, theme.color.green, b!))} />
          </div>
          {/* inline beer-temp curve with the setpoint reference line */}
          <div style={{ height: 40, minHeight: 30, flex: '0 1 auto' }}>
            <Sparkline data={batch!.history.map((r) => r.tempF)} responsive color={theme.color.green}
              reference={batch!.setpoint.value ?? null} referenceColor={theme.color.amber}
              width={260} height={40} ariaLabel="Beer temp curve" />
          </div>

          {/* ── SCHEDULE ── where it is in time + projections ──────────────────── */}
          <SectionLabel>Schedule</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5 }}>
            <TickReadout value={batch!.daysFermenting?.toFixed(1) ?? '—'} unit="d" label="Day" />
            <TickReadout value={fgEtaValue(batch!)} label={batch!.projectedFgReach ? 'FG By' : 'ETA'}
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
            <TickReadout value={paceValue(batch!.paceVsSchedule)} unit="d" label="Pace"
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
            <TickReadout value={tank.daysSinceCleaned != null ? String(tank.daysSinceCleaned) : '—'} unit="d"
              label="Since Clean" />
          </div>

          {/* ── EQUIPMENT ── this tank's controller power/energy + setpoint write ─ */}
          <SectionLabel>Equipment</SectionLabel>
          {controllerPower && <EquipmentChip eq={controllerPower} />}
          {tank.hasController && (
            <SetpointControl tankId={tank.id} current={batch!.setpoint.value} />
          )}

          {/* absorbs any remaining slack so sections sit top-aligned, never overflow */}
          <div style={{ flex: 1, minHeight: 0 }} />
        </div>
      )}

      {detail && <MetricDetail spec={detail} onClose={() => setDetail(null)} />}
    </Panel>
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
        fontFamily: theme.font.mono, fontSize: big ? 38 : 24, fontWeight: 600, lineHeight: 1,
        color, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        textShadow: textGlow(color, big ? 1.1 : 0.8),
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
