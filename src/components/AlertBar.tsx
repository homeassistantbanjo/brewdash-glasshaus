import { theme, hexA } from '../theme/tokens';
import { ActiveBatch, Tank } from '../types/domain';
import { PlantHealth } from '../hooks/useBrewery';
import { alertColor } from './TankCard';

/**
 * Top alert bar — an at-a-glance roll-up of every active alert, so a wall display
 * answers "is anything wrong?" without scanning cards. Two sources: per-tank BEER
 * alerts (stall/excursion/…) AND plant/component HEALTH (infra: frozen sensors,
 * dropped Kasa/Inkbird plugs, glycol faults, a dead programs container). Health
 * chips have no tank focus target. COLLAPSES to nothing when all-clear.
 */
export function AlertBar({ tanks, batches, health, onFocus }: {
  tanks: Tank[];
  batches: (ActiveBatch | null)[];
  health?: PlantHealth;
  onFocus?: (tankId: string) => void;
}) {
  // flatten (tank, alert) pairs, most-severe first (batch.alerts is pre-sorted)
  const items = batches.flatMap((b, i) =>
    (b?.alerts ?? []).map((a) => ({ tank: tanks[i], alert: a })),
  );
  const healthAlerts = health?.alerts ?? [];
  // container-dead heartbeat: surfaced as a synthetic critical health chip
  const heartbeatDown = health?.heartbeatAgeMin != null && health.heartbeatAgeMin > 15;
  const total = items.length + healthAlerts.length + (heartbeatDown ? 1 : 0);
  if (total === 0) return null; // all clear → no bar

  const problems = items.filter((x) => x.alert.severity === 'problem').length
    + healthAlerts.filter((a) => a.severity === 'critical').length
    + (heartbeatDown ? 1 : 0);
  const barColor = problems > 0 ? theme.color.red : theme.color.amber;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
      background: hexA(barColor, 0.08),
      border: `1px solid ${hexA(barColor, 0.4)}`,
      borderRadius: theme.radius.md,
      boxShadow: problems > 0 ? theme.glow(barColor, 0.25) : 'none',
      padding: '6px 12px',
    }}>
      <span style={{
        fontFamily: theme.font.mono, fontSize: 11, fontWeight: 700, letterSpacing: 1,
        color: barColor, whiteSpace: 'nowrap',
      }}>
        ⚠ {total} ALERT{total > 1 ? 'S' : ''}
      </span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
        {items.map(({ tank, alert }) => {
          const c = alertColor(alert.severity);
          return (
            <button
              key={`${tank.id}:${alert.key}`}
              onClick={(e) => { e.stopPropagation(); onFocus?.(tank.id); }}
              title={`${tank.label} — ${alert.label} (${alert.entityId})`}
              style={{
                fontFamily: theme.font.mono, fontSize: 10, letterSpacing: 0.5,
                color: c, background: hexA(c, 0.12),
                border: `1px solid ${hexA(c, 0.35)}`, borderRadius: 6,
                padding: '2px 8px', cursor: onFocus ? 'pointer' : 'default',
                whiteSpace: 'nowrap',
              }}>
              <span style={{ color: theme.color.textDim }}>{tank.label}</span>{' '}
              <span style={{ fontWeight: 700 }}>{alert.label}</span>
            </button>
          );
        })}
        {/* PLANT/COMPONENT health chips — infra, not tank-scoped (no focus target) */}
        {heartbeatDown && (
          <span
            key="hb_down"
            title={`No health heartbeat in ${health?.heartbeatAgeMin}m — programs container may be down`}
            style={{
              fontFamily: theme.font.mono, fontSize: 10, letterSpacing: 0.5,
              color: theme.color.red, background: hexA(theme.color.red, 0.12),
              border: `1px solid ${hexA(theme.color.red, 0.35)}`, borderRadius: 6,
              padding: '2px 8px', whiteSpace: 'nowrap',
            }}>
            <span style={{ color: theme.color.textDim }}>SYSTEM</span>{' '}
            <span style={{ fontWeight: 700 }}>RUNNER SILENT {health?.heartbeatAgeMin}m</span>
          </span>
        )}
        {healthAlerts.map((a) => {
          const c = a.severity === 'critical' ? theme.color.red : theme.color.amber;
          return (
            <span
              key={a.key}
              title={a.detail ? `${a.label} — ${a.detail}${a.entityId ? ` (${a.entityId})` : ''}` : a.label}
              style={{
                fontFamily: theme.font.mono, fontSize: 10, letterSpacing: 0.5,
                color: c, background: hexA(c, 0.12),
                border: `1px solid ${hexA(c, 0.35)}`, borderRadius: 6,
                padding: '2px 8px', whiteSpace: 'nowrap',
              }}>
              <span style={{ color: theme.color.textDim }}>SYS</span>{' '}
              <span style={{ fontWeight: 700 }}>{a.label}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
