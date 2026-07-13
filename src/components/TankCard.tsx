import { useState } from 'react';
import { useHaEntity } from '../data/haStates';
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
import { useBreweryActions } from '../hooks/useBreweryActions';

/** A vitals pip at a corner of the hero ring "collar": a LEADING label so it's
 *  unambiguous (e.g. "DAY 6.4d"), glowing value, positioned clear of the ring. */
function CollarPip({ pos, label, value, unit, color, glow }: {
  pos: 'tl' | 'tr' | 'br' | 'bl'; label: string; value: string; unit?: string; color: string; glow?: boolean;
}) {
  const corner: React.CSSProperties =
    pos === 'tl' ? { top: -2, left: -6, textAlign: 'left', alignItems: 'flex-start' }
    : pos === 'tr' ? { top: -2, right: -6, textAlign: 'right', alignItems: 'flex-end' }
    : pos === 'br' ? { bottom: 6, right: -6, textAlign: 'right', alignItems: 'flex-end' }
    : { bottom: 6, left: -6, textAlign: 'left', alignItems: 'flex-start' };
  return (
    <div style={{ position: 'absolute', display: 'flex', flexDirection: 'column', gap: 1, ...corner }}>
      <span style={{ fontFamily: theme.font.sans, fontSize: 8.5, letterSpacing: 1.5, fontWeight: 700, textTransform: 'uppercase', color: theme.color.textLabel }}>{label}</span>
      <span style={{
        fontFamily: theme.font.mono, fontSize: 15, fontWeight: 600, lineHeight: 1, color,
        fontVariantNumeric: 'tabular-nums', textShadow: glow ? textGlow(color, 0.7) : `0 0 6px ${hexA(color, 0.4)}`,
      }}>{value}{unit && <span style={{ fontSize: 9, color: theme.color.textDim }}>{unit}</span>}</span>
    </div>
  );
}

/** Read the active fermentation-program phase for a tank (from the programs
 *  container's sensor.tank_N_program_status). Returns the human phase label when a
 *  program is running, else null. Used to drive the header status.
 *
 *  Trust guard: the phase label is cross-checked against the LIVE program selection
 *  (input_select.tank_N_program). If no program is selected, we return null even if
 *  the status sensor still holds an old phase — this prevents the card from showing a
 *  phantom phase (e.g. a frozen "Hot Diastatic Hold: 86°F") that disagrees with the
 *  actual setpoint. The setpoint tile always reads the live number entity; this keeps
 *  the phase label honest against the same source of truth. */
function useProgramPhase(tankId: string): string | null {
  const e = useHaEntity(`sensor.${tankId}_program_status`);
  const prog = useHaEntity(`input_select.${tankId}_program`);
  const a = (e?.attributes as any) ?? null;
  // no program actively selected → never surface a phase, regardless of stale status
  const progState = prog?.state?.toLowerCase();
  if (!progState || progState === 'none' || progState === 'unknown' || progState === 'unavailable') return null;
  if (!a || !a.phase || a.phase === 'done') return null;
  // ignore idle/none statuses; only surface an actively-running phase
  if (typeof a.phase === 'string' && a.phase.trim() && a.phase.toLowerCase() !== 'none') return a.phase;
  return null;
}

/** Is a running program AWAITING a cold-crash confirmation? The programs engine gates
 *  an auto-reached cold crash on the brewer's OK (taste-check before crashing). This
 *  surfaces that on the card so it's impossible to miss — previously the only confirm
 *  control was buried in the Manage modal, so a gated crash looked like "nothing
 *  happened / stuck". Returns { phase } when awaiting, else null. Cross-checked against
 *  the live program selection so a stale status can't raise a phantom prompt. */
function useAwaitingCrashConfirm(tankId: string): { phase: string } | null {
  const e = useHaEntity(`sensor.${tankId}_program_status`);
  const prog = useHaEntity(`input_select.${tankId}_program`);
  const a = (e?.attributes as any) ?? null;
  const progState = prog?.state?.toLowerCase();
  if (!progState || progState === 'none' || progState === 'unknown' || progState === 'unavailable') return null;
  if (a?.awaitingConfirm === true) return { phase: String(a.phase || 'cold crash') };
  return null;
}

/** Ring legend chip — a colored dot + name + value, so you know which concentric
 *  ring is which. Dot color === that ring's arc color. */
function RingKey({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: `0 0 6px ${color}`, flexShrink: 0 }} />
      <span style={{ fontFamily: theme.font.sans, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', color: theme.color.textLabel }}>{label}</span>
      <span style={{ fontFamily: theme.font.mono, fontSize: 11, fontWeight: 600, color, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

/** A thin uppercase section divider used to group the card's telemetry into
 *  labeled bands (GRAVITY / TEMPERATURE / SCHEDULE / EQUIPMENT) — legible from
 *  across the room on the wall display, and the structure the tall layout needs. */
function SectionLabel({ children, accent }: { children: React.ReactNode; accent?: string }) {
  const cham = fx().brackets;
  const c = accent ?? theme.color.textFaint;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 4 }}>
      {/* leading connector: a bracket tick + short rule that ties the label to the
          card edge — the "built from parts" chrome */}
      {cham && <span style={{ width: 6, height: 6, borderLeft: `1px solid ${hexA(c, 0.6)}`, borderTop: `1px solid ${hexA(c, 0.6)}` }} />}
      <span style={{
        fontFamily: theme.font.sans, fontSize: 9, letterSpacing: 1.5,
        textTransform: 'uppercase', color: cham ? hexA(c, 0.85) : theme.color.textFaint, whiteSpace: 'nowrap',
      }}>{children}</span>
      <span style={{ flex: 1, height: 1, background: `linear-gradient(90deg, ${hexA(c, cham ? 0.35 : 0.15)}, transparent)` }} />
      {cham && <span style={{ width: 3, height: 3, background: hexA(c, 0.6), transform: 'rotate(45deg)' }} />}
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
  // Show the full data card whenever a BATCH is assigned — batch presence drives the
  // display, NOT the manual tank-status enum. (Previously gated on
  // isActiveBrew(tank.status), so assigning a batch to a 'Ready' tank showed NOTHING
  // until you also manually set status→Fermenting. Now: assign a batch → card shows
  // it. Cold Crashing still recognized for its special header.) `fermenting` name is
  // legacy = "has live beer / full card".
  const fermenting = batch != null;
  const crashing = tank.status === 'Cold Crashing';
  // active fermentation-program phase (drives the header when a program runs)
  const programPhase = useProgramPhase(tank.id);
  // is the program waiting for the brewer to OK an auto-reached cold crash? surfaced
  // as an unmissable banner on the card (previously only in the Manage modal → looked
  // like the program was stuck/idle).
  const awaitingCrash = useAwaitingCrashConfirm(tank.id);
  const actions = useBreweryActions();

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
  // Header status priority: (1) manual Cold Crashing status, (2) an ACTIVE
  // fermentation-program phase (cold crash / d-rest / ramp — the programs engine
  // already knows the stage), (3) gravity-detected ferment phase, (4) lifecycle.
  const statusLabel = crashing ? '❄ COLD CRASH'
    : programPhase ? programPhase.toUpperCase()
    : fermenting ? readiness(batch!, null).headline
    : tank.status.toUpperCase();
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
            {/* HERO INSTRUMENT CLUSTER — dual concentric rings wrapping the vessel:
                OUTER = attenuation progress (blue, matches the ATTENUATION gauge
                below), INNER = temperature-in-band (green on-profile / amber off).
                A legend under the vessel names each ring; a collar of labeled vitals
                pips (DAY / VEL / ETA) sits at the corners. */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 216, height: 210 }}>
                <ProgressRing pct={batch!.attenuationProgress ?? null} size={210} color={theme.color.blue} active={active}
                  innerPct={tempInBandPct(batch!)} innerColor={onProfile ? theme.color.green : theme.color.amber} />
                <ConicalFermenter state={vessel} fillPct={batch!.attenuationProgress ?? null}
                  active={active} width={100} height={158} />
                {/* labeled collar pips at the ring corners */}
                <CollarPip pos="tl" label="DAY" value={batch!.daysFermenting?.toFixed(1) ?? '—'} unit="d" color={theme.color.textLabel} />
                <CollarPip pos="tr" label="VEL" value={velStr(batch!.gravityVelocityPerDay)} color={velColor(batch!.gravityVelocityPerDay)} glow={active} />
                <CollarPip pos="br" label="ETA" value={fgEtaValue(batch!)} color={theme.color.cyan} />
              </div>
              {/* ring legend — tells you which ring is which */}
              <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                <RingKey color={theme.color.blue} label="ATTEN" value={`${pct(batch!.attenuationProgress)}%`} />
                <RingKey color={onProfile ? theme.color.green : theme.color.amber} label="TEMP"
                  value={onProfile ? 'IN BAND' : `${(dev >= 0 ? '+' : '')}${dev.toFixed(1)}°`} />
              </div>
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
                  { k: 'Phase', v: readiness(b!, null).headline },
                ],
              })} />
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '22px 0 8px' }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 210, height: 210 }}>
              {/* idle ring: a slow-scanning reticle (via active flag on an idle-tint
                  ring) so an empty tank still reads as a LIVE instrument on standby */}
              <ProgressRing pct={null} size={210} color={accent} active />
              <ConicalFermenter state={vessel} width={104} height={164} />
              {/* (no center glyph — the status chip below states it clearly, and a
                  label over the vessel both overlapped the artwork and read as a
                  contradiction next to "NEEDS CLEANING") */}
            </div>
            {/* STANDBY status readout — glowing chamfered chip */}
            {/* ONE status readout — the ACTION to take (not a restatement of the
                header's status word). Header already says DIRTY/READY; this says
                what to DO about it, once. */}
            <div style={{
              fontFamily: theme.font.mono, fontSize: 12, letterSpacing: 2, fontWeight: 700,
              textTransform: 'uppercase', color: accent, textShadow: textGlow(accent, 0.8),
              padding: '5px 16px',
              clipPath: fx().brackets ? 'polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px)' : undefined,
              borderRadius: fx().brackets ? 0 : theme.radius.sm,
              border: `1px solid ${hexA(accent, 0.5)}`, background: hexA(accent, 0.08),
            }}>
              {!tank.hasController ? '◈ NO CONTROLLER'
                : tank.status === 'Dirty' ? '◈ CLEAN & SANITIZE'
                : isActiveBrew(tank.status) ? '◈ ASSIGN A BATCH'
                : '◈ STANDBY · READY'}
            </div>
            {/* even idle, show LIVE diagnostics so the card carries real data */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5, width: '100%', padding: '0 14px' }}>
              <TickReadout value={tank.probeTemp?.value != null ? tank.probeTemp.value.toFixed(1) : '—'} unit="°F" label="Probe" color={theme.color.textLabel} />
              <TickReadout value={tank.setpoint?.value != null ? tank.setpoint.value.toFixed(1) : '—'} unit="°F" label="Setpoint" color={theme.color.amber} />
              <TickReadout value={tank.daysSinceCleaned != null ? String(tank.daysSinceCleaned) : '—'} unit="d" label="Since Clean"
                color={tank.status === 'Dirty' ? stateColor('warn') : theme.color.textLabel} />
            </div>
            {/* only a hint when it adds NEW info (batch-picker guidance); no
                redundant "Dirty 1d — clean it" line (header + chip already cover it) */}
            {isActiveBrew(tank.status) && tank.hasController && (
              <div style={{ fontFamily: theme.font.sans, fontSize: 12, color: theme.color.textDim, textAlign: 'center', padding: '2px 14px 0' }}>
                ⚙ Manage to pick which beer is in this tank
              </div>
            )}
          </div>
        )}
      </div>

      {fermenting && (
        /* BATCH NAMEPLATE — the beer's identity, made prominent: a large title
           with framing connector rules on either side, and a small mono subline
           (day + assigned Tilt). This is what you read first to know WHAT beer. */
        <div style={{ padding: '4px 14px 0', textAlign: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, height: 1, background: `linear-gradient(90deg, transparent, ${hexA(accent, 0.5)})` }} />
            <span style={{ color: accent, fontSize: 8, filter: `drop-shadow(0 0 3px ${accent})` }}>◆</span>
            <span style={{
              fontFamily: theme.font.sans, fontSize: 17, fontWeight: 700, letterSpacing: 0.3,
              color: theme.color.text, textShadow: `0 0 12px ${hexA(accent, 0.4)}`,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '78%',
            }}>{batch!.name}</span>
            <span style={{ color: accent, fontSize: 8, filter: `drop-shadow(0 0 3px ${accent})` }}>◆</span>
            <span style={{ flex: 1, height: 1, background: `linear-gradient(90deg, ${hexA(accent, 0.5)}, transparent)` }} />
          </div>
          <div style={{
            fontFamily: theme.font.mono, fontSize: 10, letterSpacing: 1, color: theme.color.textDim, marginTop: 3,
          }}>
            DAY {batch!.daysFermenting?.toFixed(1) ?? '—'}
            {batch!.tiltColor && <>
              <span style={{ margin: '0 7px', color: theme.color.textFaint }}>//</span>
              <span style={{ color: theme.color.purple }}>{batch!.tiltColor.toUpperCase()} TILT</span>
            </>}
          </div>
          {/* prominent STAGE badge — where the beer is in the ferment→package arc,
              so it's not just a small header word. Shows the readiness call. */}
          <StageBadge batch={batch!} programPhase={programPhase} />
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
              ? ` — ${batch!.verification.reason}`
              : al.detail ? ` — ${al.detail}` : '';
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

      {/* AWAITING COLD-CRASH CONFIRM — unmissable banner + button, right on the card.
          The programs engine paused at a cold-crash step for the brewer's OK. Tapping
          Confirm presses input_button.tank_N_confirm_crash; the runner then starts
          ramping down on its next tick. (This is the ONLY confirm gate now — a
          manually-selected "Cold crash only" starts immediately, no gate.) */}
      {awaitingCrash && (
        <button
          onClick={(e) => { e.stopPropagation(); actions.confirmCrash(tank.id); }}
          style={{
            margin: '6px 14px 0', padding: '10px 14px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
            fontFamily: theme.font.mono, fontSize: 12, letterSpacing: 1, fontWeight: 700,
            color: theme.color.amber, background: hexA(theme.color.amber, 0.12),
            border: `1px solid ${hexA(theme.color.amber, 0.6)}`, borderRadius: theme.radius.sm,
            textShadow: textGlow(theme.color.amber, 0.6),
            animation: fx().animatedGrid ? 'ghpulse 1.6s ease-in-out infinite' : 'none',
          }}
        >
          <span>❄ COLD CRASH READY — {awaitingCrash.phase.toUpperCase()}</span>
          <span style={{
            padding: '4px 10px', borderRadius: theme.radius.sm,
            background: hexA(theme.color.amber, 0.22), border: `1px solid ${hexA(theme.color.amber, 0.7)}`,
          }}>CONFIRM ▸</span>
        </button>
      )}
      <style>{`@keyframes ghpulse { 0%,100% { opacity: 1; } 50% { opacity: 0.62; } }`}</style>

      {fermenting && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 14px 10px',
          flex: 1, minHeight: 0,   // fill the card; sparkline regions absorb slack
        }}>
          {/* ── GRAVITY ── live SG cluster + the full-ferment gravity curve ─────── */}
          <SectionLabel accent={accent}>Gravity</SectionLabel>
          {/* VEL moved to the hero collar → freed a slot; OG + FG now shown here
              (were popup-only) so the full OG→now→FG story reads at a glance. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5 }}>
            <TickReadout value={batch!.og ? batch!.og.toFixed(3) : '—'} label="OG" color={theme.color.textLabel} />
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
            {/* settling-proof activity — cumulative drop from the rolling 8h peak */}
            <TickReadout value={batch!.gravityDropFromPeak != null ? batch!.gravityDropFromPeak.toFixed(1) : '—'} unit="pts"
              label="Drop/Peak" color={theme.color.cyan} glow={active} />
          </div>
          {/* inline gravity curve (full ferment) with the FG reference line */}
          <div style={{ height: 46, minHeight: 34, flex: '0 1 auto' }}>
            <Sparkline data={sgSeries} responsive color={theme.color.cyan}
              reference={batch!.expectedFg ?? null} referenceColor={theme.color.amber}
              width={260} height={46} ariaLabel="Gravity curve" />
          </div>

          {/* ── TEMPERATURE ── probe / beer / setpoint on their own line + curve ── */}
          <SectionLabel accent={accent}>Temperature</SectionLabel>
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
          <SectionLabel accent={accent}>Schedule &amp; Signal</SectionLabel>
          {/* DAY + ETA moved to the hero collar → freed 2 slots; backfilled with the
              expected FG target and Tilt-reading freshness (were not surfaced). */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5 }}>
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
            {/* STABLE — days gravity has held terminal; green once confirmed
                (≥3d, or ≥6d dry-hopped) = ready to move to D-rest/crash. THE
                readiness signal. Dim '—' until it enters the terminal band. */}
            <TickReadout value={stableStr(batch!.stableDays)} unit={batch!.stableDays != null ? 'd' : undefined}
              label="Stable"
              color={batch!.terminalConfirmed ? theme.color.green : batch!.stableDays != null ? theme.color.cyan : theme.color.textDim}
              glow={batch!.terminalConfirmed}
              onClick={() => open({
                label: 'Gravity stability', value: stableStr(b!.stableDays), unit: ' days',
                color: b!.terminalConfirmed ? theme.color.green : theme.color.cyan,
                blurb: 'How long gravity has held terminal (within ~3 pts of expected FG and flat). Turns green once it has been stable long enough to be confirmed terminal — 3 days normally, ~6 for dry-hopped beers (hop creep can re-ferment). This is the gate before diacetyl rest / cold crash / packaging.',
                facts: [
                  { k: 'Confirmed terminal?', v: b!.terminalConfirmed ? 'YES' : 'not yet' },
                  { k: 'Current gravity', v: b!.gravity.value?.toFixed(3) ?? '—' },
                  { k: 'Expected FG', v: b!.expectedFg?.toFixed(3) ?? '—' },
                ],
              })} />
            <TickReadout value={ageStr(batch!.tiltGravityAgeMin)} label="Tilt Age"
              color={batch!.tiltGravityAgeMin != null && batch!.tiltGravityAgeMin > 15 ? stateColor('warn') : theme.color.textDim} />
            <TickReadout value={tank.daysSinceCleaned != null ? String(tank.daysSinceCleaned) : '—'} unit="d"
              label="Since Clean" />
          </div>

          {/* ── EQUIPMENT ── this tank's controller power/energy + setpoint write ─ */}
          <SectionLabel accent={accent}>Equipment</SectionLabel>
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

/** Brewer-facing readiness call. Collapses the internal state-machine labels
 *  (TERMINAL = flat-at-FG but window not yet met; STABLE = window met) into ONE
 *  headline that says what you actually DO next, because "TERMINAL vs STABLE" is
 *  jargon that reads as two confusing states rather than "still going" vs "done".
 *  Returns { headline, sub, color }. */
function readiness(b: ActiveBatch, programPhase: string | null): { headline: string; sub: string; color: string } {
  const t = theme.color;
  if (programPhase) return { headline: programPhase.toUpperCase(), sub: 'running fermentation program', color: t.cyan };
  // Gravity held flat for the full confirmation window → FERMENTATION is DONE, so
  // the beer moves to conditioning. Conditioning is TIME-based (weeks for a lager),
  // tracked as a countdown; when it elapses the beer is honestly READY TO KEG.
  if (b.readyToKeg) {
    const bf = b.bfConditioned ? ' · Brewfather ✓' : '';
    return { headline: 'READY TO KEG', sub: `conditioned ${b.conditioningDaysElapsed ?? ''}d — ready to package${bf}`, color: t.green };
  }
  if (b.terminalConfirmed) {
    const bf = b.bfConditioned ? ' · Brewfather ✓' : '';
    // show the conditioning countdown if we resolved a target, else just the state
    const sub = (b.conditionDays != null && b.conditioningDaysElapsed != null)
      ? `conditioning ${Math.max(0, Math.floor(b.conditioningDaysElapsed))}/${b.conditionDays}d${bf}`
      : `fermentation complete · conditioning${bf}`;
    return { headline: 'CONDITIONING', sub, color: t.cyan };
  }
  // At FG and flat, but hasn't held the full window yet — still confirming. A
  // dry-hopped beer needs 6d (hop creep can restart fermentation) vs 3d clean.
  if (b.stableDays != null) {
    const need = b.dryHop ? 6 : 3;
    const why = b.dryHop ? ' (dry-hop / hop-creep window)' : '';
    return { headline: 'TERMINAL', sub: `at final gravity · confirming stability ${b.stableDays}/${need}d${why}`, color: t.cyan };
  }
  const a = b.attenuation;
  if (a == null) return { headline: 'FERMENTING', sub: 'no gravity signal yet', color: t.amber };
  if (a < 30) return { headline: 'LAG', sub: 'getting started', color: t.amber };
  if (a < 60) return { headline: 'ACTIVE', sub: 'fermenting hard', color: t.green };
  if (a < 78) return { headline: 'SLOWING', sub: 'attenuation slowing — approaching terminal', color: t.green };
  return { headline: 'TERMINAL', sub: 'at final gravity — confirming stability', color: t.cyan };
}
/** Prominent STAGE band — the single most important line on the card: where the
 *  beer is in the ferment→package arc and what to do next. Full-width, large. */
function StageBadge({ batch, programPhase }: { batch: ActiveBatch; programPhase: string | null }) {
  const { headline, sub, color } = readiness(batch, programPhase);
  return (
    <div style={{
      marginTop: 10, padding: '9px 14px', borderRadius: theme.radius.sm,
      border: `1px solid ${hexA(color, 0.55)}`,
      background: `linear-gradient(180deg, ${hexA(color, 0.16)}, ${hexA(color, 0.06)})`,
      boxShadow: `0 0 14px ${hexA(color, 0.22)}, inset 0 0 20px ${hexA(color, 0.05)}`,
      textAlign: 'center',
    }}>
      <div style={{
        fontFamily: theme.font.mono, fontSize: 20, fontWeight: 800, letterSpacing: 3,
        color, textShadow: `0 0 12px ${hexA(color, 0.6)}`, lineHeight: 1.1,
      }}>{headline}</div>
      {sub && <div style={{
        fontFamily: theme.font.sans, fontSize: 11, color: theme.color.textDim, marginTop: 3, letterSpacing: 0.3,
      }}>{sub}</div>}
    </div>
  );
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
/** Gravity-stable days → compact string; '—' when not yet in the terminal band. */
function stableStr(d: number | null): string { return d == null ? '—' : d.toFixed(1); }

/** Temperature-in-band as a 0–100 arc for the inner hero ring: 100% = probe dead
 *  on setpoint, falling linearly to 0 at ±5°F off. Null when either temp missing. */
function tempInBandPct(b: ActiveBatch): number | null {
  if (b.probeTemp.value == null || b.setpoint.value == null) return null;
  const dev = Math.abs(b.probeTemp.value - b.setpoint.value);
  return Math.max(0, Math.min(100, 100 - (dev / 5) * 100));
}

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
