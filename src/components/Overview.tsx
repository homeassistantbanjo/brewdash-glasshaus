import { useState } from 'react';
import { TankCard } from './TankCard';
import { TankControls } from './TankControls';
import { Metric } from './Metric';
import { EquipmentStrip } from './EquipmentStrip';
import { AlertBar } from './AlertBar';
import { GraphsView } from './GraphsView';
import { InsightsView } from './InsightsView';
import { BrewDayView } from './BrewDayView';
import { KegsView } from './KegsView';
import { InsightPanel } from './InsightPanel';
import { ThemeSwitcher } from './ThemeSwitcher';
import { theme, stateColor, hexA, useThemeName } from '../theme/tokens';
import { useActiveBatches, useGlycol, useEquipment, usePlantDiag, useInsight, useHealth } from '../hooks/useBrewery';
import { Tank, isActiveBrew } from '../types/domain';
import logo from '../assets/iconoclast-logo.jpg';

export function Overview() {
  const { tanks, batches } = useActiveBatches();
  const glycol = useGlycol();
  const equipment = useEquipment();
  const plantDiag = usePlantDiag();
  const insight = useInsight();
  const health = useHealth();
  useThemeName(); // re-render this whole view when the theme switches
  // (batch options are no longer synced to an input_select — batch is stored as
  //  free text (batchNo) and the picker builds its list live from Brewfather, so
  //  there's nothing to reconcile and nothing that can reset on reboot.)
  const [view, setView] = useState<'tanks' | 'graphs' | 'insights' | 'brewday' | 'kegs'>('tanks');
  const [editing, setEditing] = useState<Tank | null>(null);
  // tank id the alert bar asked to highlight (pulses that card briefly)
  const [focusTankId, setFocusTankId] = useState<string | null>(null);
  const focusCard = (tankId: string) => {
    setFocusTankId(tankId);
    setTimeout(() => setFocusTankId((cur) => (cur === tankId ? null : cur)), 2600);
  };

  // Stable column order (by registry order — Tank 1 always leftmost) so a
  // wall-mounted display never rearranges under you. No status sort.
  const cards = tanks.map((tank, i) => ({ tank, batch: batches[i] }));

  const fermentingCount = tanks.filter(t => t.status === 'Fermenting').length;
  const cooling = glycol.compressorRunning;

  // Cooling demand: prefer GROUND TRUTH — a tank's controller plug drawing in
  // its cooling band means its glycol pump is actually running. Fall back to the
  // probe-vs-setpoint proxy only for tanks that have no plug yet. Counting real
  // pump activations (not a temperature guess) is what tells the loop's true load.
  const pumpingTankIds = new Set(
    equipment
      .filter((e) => e.id.endsWith('_controller') && e.state === 'cooling')
      .map((e) => e.id.replace('_controller', '')),
  );
  const hasPlug = (tankId: string) =>
    equipment.some((e) => e.id === `${tankId}_controller`);

  const demanding = tanks.filter((t) => {
    if (hasPlug(t.id)) return pumpingTankIds.has(t.id);           // truth: pump on
    // no plug → proxy: active-brew tank (fermenting OR cold-crashing) whose probe
    // is above setpoint by a margin. Cold-crash tanks demand cooling too.
    return isActiveBrew(t.status) && t.hasController &&
      t.probeTemp.value != null && t.setpoint.value != null &&
      t.probeTemp.value - t.setpoint.value > 0.5;
  });
  const contention = demanding.length > 1;

  return (
    <div style={{
      maxWidth: 1860, margin: '0 auto', padding: '16px 20px',
      height: '100vh', boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        paddingBottom: 6, height: 44, flexShrink: 0,
        borderBottom: `1px solid ${theme.color.panelBorder}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src={logo} alt="Iconoclast Brewing" style={{
            height: 36, width: 'auto', display: 'block',
            // the logo art is on black — let it sit flush on the dark bg
            filter: `drop-shadow(0 0 10px ${hexA(theme.color.cyan, 0.25)})`,
          }} />
          <div style={{ fontFamily: theme.font.mono, fontSize: 18, fontWeight: 700, color: theme.color.text, letterSpacing: 1 }}>
            GLASS<span style={{ color: theme.color.cyan }}>HAUS</span>
          </div>
        </div>

        {/* ICONOCLAST BREWING banner — Anton (heavy condensed caps, closest to
            the logo lettering) with a holographic gradient echoing the skull art.
            Centered between the wordmark and the status readout. */}
        <div style={{
          display: 'inline-block',   // required for background-clip:text to clip to the glyphs
          fontFamily: "'Anton', 'JetBrains Mono', sans-serif",
          fontSize: 27, letterSpacing: 4, lineHeight: 1,
          textTransform: 'uppercase', whiteSpace: 'nowrap',
          background: `linear-gradient(100deg, ${theme.color.cyan} 0%, ${theme.color.blue} 30%, ${theme.color.purple} 55%, ${theme.color.red} 78%, ${theme.color.amber} 100%)`,
          WebkitBackgroundClip: 'text', backgroundClip: 'text',
          WebkitTextFillColor: 'transparent', color: 'transparent',
          filter: `drop-shadow(0 0 14px ${hexA(theme.color.cyan, 0.35)})`,
          userSelect: 'none',
        }}>
          Iconoclast Brewing
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {/* LLM insight badge (auto-opens for problems) */}
          <InsightPanel insight={insight} />
          {/* view toggle: tank cards ↔ dedicated big-charts view */}
          <div style={{ display: 'flex', gap: 4 }}>
            {(['tanks', 'graphs', 'insights', 'brewday', 'kegs'] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} style={{
                fontFamily: theme.font.mono, fontSize: 10, letterSpacing: 1,
                textTransform: 'uppercase', padding: '4px 10px', borderRadius: 6,
                cursor: 'pointer', transition: 'all 0.12s',
                border: `1px solid ${view === v ? theme.color.cyan : theme.color.panelBorder}`,
                background: view === v ? hexA(theme.color.cyan, 0.15) : theme.color.inset,
                color: view === v ? theme.color.cyan : theme.color.textDim,
              }}>{v === 'tanks' ? 'Tanks' : v === 'graphs' ? 'Graphs' : v === 'insights' ? 'Insights' : v === 'brewday' ? 'Brew Day' : 'Kegs'}</button>
            ))}
          </div>
          <ThemeSwitcher />
          <div style={{ fontFamily: theme.font.mono, fontSize: 11, color: theme.color.textDim }}>
            {fermentingCount} FERMENTING · {tanks.length} TANKS
          </div>
        </div>
      </div>

      {/* Top alert bar — collapses to nothing when all-clear. Clicking a chip
          highlights the offending card. */}
      <AlertBar tanks={tanks} batches={batches} health={health} onFocus={focusCard} />

      {/* ONE unified plant strip: glycol hero on the left + equipment chips
          inline on the right. Merged from two stacked bands into one to reclaim
          vertical height (the cards were scrolling). */}
      <div style={{
        background: theme.color.panelHi,
        backdropFilter: `blur(${theme.blur})`,
        WebkitBackdropFilter: `blur(${theme.blur})`,
        border: `1px solid ${cooling ? hexA(theme.color.cyan, 0.4) : theme.color.panelBorder}`,
        borderRadius: theme.radius.lg,
        boxShadow: cooling ? theme.glow(theme.color.cyan, 0.35) : 'none',
        padding: '10px 14px', flexShrink: 0,
        display: 'flex', alignItems: 'stretch', gap: 10,
      }}>
        {/* GLYCOL — the ONE glycol tile. Reservoir temp + state + demand, with a
            footer line carrying power · cycles · runtime. Consolidated: the chiller
            was previously drawn 3× in this strip (hero + duty panel + equip chip);
            now it's one tile and the glycol chip is dropped from EquipmentStrip. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingRight: 12, borderRight: `1px solid ${theme.color.panelBorder}` }}>
          <span style={{ fontSize: 24, filter: cooling ? `drop-shadow(0 0 8px ${theme.color.cyan})` : 'none' }}>❄</span>
          <div>
            <div style={{
              fontFamily: theme.font.mono, fontSize: 28, fontWeight: 600, lineHeight: 1,
              color: cooling ? theme.color.cyan : theme.color.text,
              fontVariantNumeric: 'tabular-nums',
              textShadow: cooling ? `0 0 16px ${theme.color.cyan}55` : undefined,
            }}>
              {glycol.reservoirTemp.value?.toFixed(1) ?? '—'}<span style={{ fontSize: 15, color: theme.color.textDim }}>°F</span>
            </div>
            <div style={{ fontFamily: theme.font.sans, fontSize: 9, letterSpacing: 1, color: theme.color.textLabel, textTransform: 'uppercase', marginTop: 3 }}>
              Glycol {cooling ? '· COOLING' : '· IDLE'} · {pumpingTankIds.size || demanding.length} DEMAND{contention ? ' ⚡' : ''}
            </div>
            {/* duty + power footer: watts · cycles/h · runtime. cycles warn-colored
                from the single health source (monitor's glycol_short_cycle). */}
            <div style={{
              fontFamily: theme.font.mono, fontSize: 10, fontVariantNumeric: 'tabular-nums',
              color: theme.color.textDim, marginTop: 4, display: 'flex', gap: 6, alignItems: 'baseline',
            }}>
              <span><span style={{ color: theme.color.textLabel, fontWeight: 600 }}>{glycol.powerW?.value != null ? Math.round(glycol.powerW.value) : '—'}</span>W</span>
              <span style={{ color: theme.color.textFaint }}>·</span>
              <span style={{ color: health.has('glycol_short_cycle') ? stateColor('warn') : theme.color.textDim }}>
                <span style={{ fontWeight: 600 }}>{plantDiag.cycles1h ?? '—'}</span> cyc/h
              </span>
              <span style={{ color: theme.color.textFaint }}>·</span>
              <span><span style={{ fontWeight: 600 }}>{plantDiag.runtime7dH != null ? plantDiag.runtime7dH.toFixed(1) : '—'}</span> h/7d</span>
            </div>
          </div>
        </div>
        {/* equipment chips share the same band, filling the rest of the width.
            Glycol is excluded here (it's the hero tile above) — see EquipmentStrip. */}
        <EquipmentStrip equipment={equipment} excludeIds={['glycol']} />
      </div>

      {view === 'graphs' ? (
        <GraphsView />
      ) : view === 'insights' ? (
        <InsightsView />
      ) : view === 'brewday' ? (
        <BrewDayView />
      ) : view === 'kegs' ? (
        <KegsView />
      ) : (
        /* 3-column card grid — one fermenter per column, stable order, fills the
           remaining vertical space. Single-screen: this flex-1 region is the only
           thing that can grow, and cards size to it (no page scroll). */
        <div style={{
          flex: 1, minHeight: 0,
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.max(cards.length, 1)}, 1fr)`,
          gap: 12,
        }}>
          {cards.map(({ tank, batch }) => (
            <TankCard key={tank.id} tank={tank} batch={batch}
              controllerPower={equipment.find((e) => e.id === `${tank.id}_controller`) ?? null}
              focused={focusTankId === tank.id}
              onClick={() => setEditing(tank)} />
          ))}
        </div>
      )}

      {editing && <TankControls tank={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
