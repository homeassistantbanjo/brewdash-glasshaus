import { theme, stateColor, hexA } from '../theme/tokens';
import { EquipmentPower, PowerState } from '../types/domain';

/**
 * The top-strip equipment chips — PLANT-WIDE devices only (glycol chiller,
 * kegerator). Per-tank temp controllers do NOT live here: each belongs to a
 * specific tank and renders on that tank's card (see PowerBadge / EnergyFooter,
 * reused there), so the strip never crowds as tanks are added. Renders nothing
 * if no plant plugs resolve.
 */

const STATE_META: Record<PowerState, { label: string; color: string; glow: boolean }> = {
  cooling: { label: 'COOLING', color: stateColor('cool'), glow: true },
  heating: { label: 'HEATING', color: theme.color.amber, glow: true },
  holding: { label: 'HOLDING', color: theme.color.green, glow: false },
  idle:    { label: 'IDLE',    color: theme.color.textDim, glow: false },
  off:     { label: 'OFF',     color: theme.color.textFaint, glow: false },
  unknown: { label: '—',       color: theme.color.textFaint, glow: false },
};

// heating glyph vs cooling snowflake vs holding vs idle dash
const ICON: Record<PowerState, string> = {
  cooling: '❄', heating: '▲', holding: '=', idle: '·', off: '○', unknown: '?',
};

export const fmtKwh = (v: number | null | undefined) =>
  (v == null ? '—' : v < 10 ? v.toFixed(2) : v.toFixed(1));

/** tiny "1.2 / 340 kWh" energy footer (today / lifetime). Reused on tank cards. */
export function EnergyFooter({ today, lifetime }: { today: number | null; lifetime: number | null }) {
  return (
    <div style={{
      display: 'flex', gap: 4, marginTop: 2, alignItems: 'baseline',
      fontFamily: theme.font.mono, fontSize: 9.5, fontVariantNumeric: 'tabular-nums',
      color: theme.color.textDim, whiteSpace: 'nowrap',
    }}
    title={`Today ${fmtKwh(today)} kWh · Lifetime ${fmtKwh(lifetime)} kWh`}>
      <span style={{ color: theme.color.textLabel }}>{fmtKwh(today)}</span>
      <span style={{ color: theme.color.textFaint }}>/</span>
      <span>{fmtKwh(lifetime)}</span>
      <span style={{ color: theme.color.textFaint, fontSize: 8.5 }}>kWh</span>
    </div>
  );
}

/** The chip body for one piece of equipment: icon + label + STATE + watts, with
 *  optional kWh footer. Shared between the top strip and the tank cards so the
 *  power language reads identically everywhere. */
export function EquipmentChip({ eq, showEnergy = true }: { eq: EquipmentPower; showEnergy?: boolean }) {
  const m = STATE_META[eq.state];
  const active = eq.state === 'cooling' || eq.state === 'heating';
  const w = eq.powerW.value;
  return (
    <div style={{
      background: theme.color.inset,
      border: `1px solid ${active ? hexA(m.color, 0.4) : theme.color.panelBorder}`,
      borderRadius: theme.radius.sm,
      boxShadow: active ? theme.glow(m.color, 0.3) : 'none',
      padding: '6px 10px',
      display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
    }}>
      <span style={{
        fontSize: 18, lineHeight: 1, color: m.color,
        filter: active ? `drop-shadow(0 0 6px ${m.color})` : 'none',
      }}>{ICON[eq.state]}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, overflow: 'hidden' }}>
          <span style={labelStyle}>{eq.label}</span>
          <span style={{
            fontFamily: theme.font.mono, fontSize: 9.5, letterSpacing: 1,
            color: m.color, whiteSpace: 'nowrap',
            textShadow: m.glow ? `0 0 8px ${m.color}66` : undefined,
          }}>{m.label}</span>
        </div>
        <div style={drawStyle}>
          {w != null ? w.toFixed(w < 10 ? 1 : 0) : '—'}
          <span style={{ fontSize: 9, color: theme.color.textDim, marginLeft: 2 }}>W</span>
        </div>
        {showEnergy && eq.energy && (
          <EnergyFooter today={eq.energy.todayKwh.value} lifetime={eq.energy.lifetimeKwh.value} />
        )}
      </div>
    </div>
  );
}

export function EquipmentStrip({ equipment }: { equipment: EquipmentPower[] }) {
  // Only plant-wide devices belong in the top strip. Controllers (id ends with
  // _controller) render on their tank's card instead — no aggregate chip.
  const plant = equipment.filter((e) => !e.id.endsWith('_controller'));
  if (plant.length === 0) return null;

  return (
    <div style={{
      flex: 1, minWidth: 0,
      display: 'grid',
      gridTemplateColumns: `repeat(${plant.length}, 1fr)`,
      gap: 8,
    }}>
      {plant.map((eq) => <EquipmentChip key={eq.id} eq={eq} />)}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontFamily: theme.font.sans, fontSize: 11, fontWeight: 600,
  color: theme.color.text, whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis',
};

const drawStyle: React.CSSProperties = {
  fontFamily: theme.font.mono, fontSize: 13, fontWeight: 600,
  color: theme.color.textLabel, fontVariantNumeric: 'tabular-nums',
  marginTop: 2,
};
