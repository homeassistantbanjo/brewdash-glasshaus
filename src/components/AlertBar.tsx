import { theme, hexA } from '../theme/tokens';
import { ActiveBatch, Tank } from '../types/domain';
import { alertColor } from './TankCard';

/**
 * Top alert bar — an at-a-glance roll-up of every active alert across all tanks,
 * so a wall display answers "is anything wrong?" without scanning the cards. Each
 * chip names the TANK + the alert and is colored by severity; clicking it calls
 * onFocus(tankId) so the parent can highlight/flash that card. COLLAPSES to
 * nothing when all-clear — the dashboard is height-constrained (cards fit
 * 1920×720), so an always-present bar would cost a row for no reason.
 */
export function AlertBar({ tanks, batches, onFocus }: {
  tanks: Tank[];
  batches: (ActiveBatch | null)[];
  onFocus?: (tankId: string) => void;
}) {
  // flatten (tank, alert) pairs, most-severe first (batch.alerts is pre-sorted)
  const items = batches.flatMap((b, i) =>
    (b?.alerts ?? []).map((a) => ({ tank: tanks[i], alert: a })),
  );
  if (items.length === 0) return null; // all clear → no bar

  const problems = items.filter((x) => x.alert.severity === 'problem').length;
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
        ⚠ {items.length} ALERT{items.length > 1 ? 'S' : ''}
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
      </div>
    </div>
  );
}
