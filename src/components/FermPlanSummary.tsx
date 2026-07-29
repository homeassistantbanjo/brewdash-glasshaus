import { useHaEntity } from '../data/haStates';
import { theme, hexA, stateColor } from '../theme/tokens';

/**
 * FERM-PLAN SUMMARY — the "where it is / where it's going / when" panel.
 *
 * Reads the plan (sensor.tank_N_program_plan attr `plan.phases`) + the live position
 * (sensor.tank_N_program_status attr `phaseIndex`) and renders the full phase timeline:
 * each step's name, target temp, and duration, with the CURRENT phase highlighted and
 * done phases dimmed. Answers at a glance: what stage now, what's next, the whole arc to
 * package. Purely presentational — the programs runner owns the actual control.
 */

interface Phase {
  name: string; kind?: string;
  tempF?: number; targetF?: number; stepF?: number; everyHours?: number; hours?: number;
  advance?: { type: string; pct?: number; hours?: number };
}

/** Human duration/advance for a phase: fixed hours, or the gravity/terminal condition. */
function phaseWhen(p: Phase): string {
  if (p.hours != null) return p.hours >= 48 ? `${(p.hours / 24).toFixed(0)}d` : `${p.hours}h`;
  const a = p.advance;
  if (a?.type === 'terminal') return 'til terminal';
  if (a?.type === 'attenuation' && a.pct != null) return `til ${a.pct}% att`;
  if (a?.type === 'hours' && a.hours != null) return a.hours >= 48 ? `${(a.hours / 24).toFixed(0)}d` : `${a.hours}h`;
  if (a?.type === 'confirm') return 'on OK';
  return '—';
}

/** Target temp label: a ramp shows from→to, a hold shows the single temp. */
function phaseTemp(p: Phase): string {
  if (p.targetF != null && p.tempF != null && p.targetF !== p.tempF) return `${p.tempF}→${p.targetF}°`;
  return `${p.targetF ?? p.tempF ?? '—'}°`;
}

export function FermPlanSummary({ tankId }: { tankId: string }) {
  const planE = useHaEntity(`sensor.${tankId}_program_plan`);
  const statusE = useHaEntity(`sensor.${tankId}_program_status`);
  const plan = (planE?.attributes as any)?.plan;
  const phases: Phase[] = Array.isArray(plan?.phases) ? plan.phases : [];
  if (!phases.length) return null;                       // no plan → render nothing

  const st = (statusE?.attributes as any) || {};
  const curIdx = typeof st.phaseIndex === 'number' ? st.phaseIndex : -1;
  const done = st.done === true;
  const label = plan.label || st.program || 'Fermentation plan';

  return (
    <div style={{
      marginTop: 8, padding: '8px 10px', borderRadius: theme.radius.sm,
      background: theme.color.inset, border: `1px solid ${theme.color.panelBorder}`,
    }}>
      <div style={{
        fontFamily: theme.font.sans, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase',
        color: theme.color.textLabel, marginBottom: 6,
      }}>Ferm Plan · {label}{plan.yeast ? ` · ${plan.yeast}` : ''}</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {phases.map((p, i) => {
          const isCur = i === curIdx && !done;
          const isDone = done || i < curIdx;
          const c = isCur ? theme.color.cyan : isDone ? theme.color.textFaint : theme.color.textDim;
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'baseline', gap: 8,
              opacity: isDone ? 0.5 : 1,
              padding: isCur ? '3px 6px' : '2px 6px',
              borderRadius: isCur ? theme.radius.sm : 0,
              background: isCur ? hexA(theme.color.cyan, 0.12) : 'transparent',
              border: isCur ? `1px solid ${hexA(theme.color.cyan, 0.4)}` : '1px solid transparent',
            }}>
              {/* step marker: ● current, ✓ done, ○ upcoming */}
              <span style={{ fontSize: 10, color: c, width: 12, flexShrink: 0 }}>
                {isCur ? '▶' : isDone ? '✓' : '○'}
              </span>
              <span style={{
                fontFamily: theme.font.sans, fontSize: 11, color: isCur ? theme.color.text : c,
                fontWeight: isCur ? 700 : 400, flex: 1, minWidth: 0,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{p.name}</span>
              <span style={{ fontFamily: theme.font.mono, fontSize: 10, color: c, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {phaseTemp(p)}
              </span>
              <span style={{ fontFamily: theme.font.mono, fontSize: 9, color: theme.color.textFaint, flexShrink: 0, minWidth: 44, textAlign: 'right' }}>
                {phaseWhen(p)}
              </span>
            </div>
          );
        })}
      </div>

      {/* footer: awaiting-confirm / paused / done state so the whole arc reads at a glance */}
      {done ? (
        <div style={{ fontFamily: theme.font.mono, fontSize: 10, color: stateColor('ok'), marginTop: 6 }}>✓ plan complete</div>
      ) : st.awaitingConfirm ? (
        <div style={{ fontFamily: theme.font.mono, fontSize: 10, color: stateColor('warn'), marginTop: 6 }}>⏸ awaiting your OK to advance</div>
      ) : null}
    </div>
  );
}
