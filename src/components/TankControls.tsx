import { useState } from 'react';
import { useEntity, type EntityName } from '@hakit/core';
import { theme, hexA, stateColor } from '../theme/tokens';
import { useBreweryActions } from '../hooks/useBreweryActions';
import { Tank } from '../types/domain';

// Fallbacks used ONLY until the helper's live options resolve. The real option
// list always comes from HA (see useOptions) so pills can never offer a value
// the input_select would reject on select_option.
const STATUS_FALLBACK = ['Ready', 'Fermenting', 'Cold Crashing', 'Dirty'];

/** Pull an input_select's current options from HA (batch list is auto-synced). */
function useOptions(entityId: string): string[] {
  try {
    const e = useEntity(entityId as EntityName, { returnNullIfNotFound: true });
    const opts = (e?.attributes as any)?.options;
    return Array.isArray(opts) ? opts : [];
  } catch { return []; }
}

/** Read an entity's attributes object (or null). For the program-status sensor. */
function useEntityAttrs(entityId: string): Record<string, any> | null {
  try {
    const e = useEntity(entityId as EntityName, { returnNullIfNotFound: true });
    return (e?.attributes as any) ?? null;
  } catch { return null; }
}

export function TankControls({ tank, onClose }: { tank: Tank; onClose: () => void }) {
  const a = useBreweryActions();
  const batchOptions = useOptions(`input_select.${tank.id}_batch`);
  // Live option lists straight from the HA helpers — never hardcoded, so a pill
  // can only ever offer a value select_option will accept. Fall back to a static
  // list only while the entity is still resolving (empty bay / first paint).
  const liveStatusOptions = useOptions(`input_select.${tank.id}_status`);
  const statusOptions = liveStatusOptions.length ? liveStatusOptions : STATUS_FALLBACK;
  const tiltOptions = useOptions(`input_select.${tank.id}_tilt`);

  // read current selections to show active state
  const cur = (id: string) => {
    try { return useEntity(id as EntityName, { returnNullIfNotFound: true })?.state; }
    catch { return undefined; }
  };
  const curStatus = cur(`input_select.${tank.id}_status`);
  const curTilt = cur(`input_select.${tank.id}_tilt`);
  const curBatch = cur(`input_select.${tank.id}_batch`);

  // fermentation program: options + current selection + live status (from the
  // programs container's sensor.tank_N_program_status). Absent until the programs
  // HA package is installed — the section shows a hint in that case.
  const programOptions = useOptions(`input_select.${tank.id}_program`);
  const curProgram = cur(`input_select.${tank.id}_program`);
  const programStatus = useEntityAttrs(`sensor.${tank.id}_program_status`);
  const running = !!curProgram && curProgram !== 'None';
  const awaitingConfirm = programStatus?.awaitingConfirm === true;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: theme.color.panelHi,
        border: `1px solid ${theme.color.panelBorderHi}`,
        borderRadius: theme.radius.lg,
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        width: 'min(440px, 100%)', maxHeight: '86vh', overflowY: 'auto',
        padding: 20,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <span style={{ fontFamily: theme.font.mono, fontSize: 18, fontWeight: 700, color: theme.color.text }}>
            {tank.label} — Manage
          </span>
          <button onClick={onClose} style={closeBtn}>✕</button>
        </div>

        <Field label="Status">
          <Pills options={statusOptions} active={curStatus}
            onPick={(v) => a.setStatus(tank.id, v)} wrap />
        </Field>

        <Field label="Fermentation Program">
          {programOptions.length ? (
            <>
              <Pills options={programOptions} active={curProgram}
                onPick={(v) => (v === 'None' ? a.cancelProgram(tank.id) : a.setProgram(tank.id, v))} wrap />
              {running && (
                <div style={{
                  marginTop: 8, padding: '8px 10px', borderRadius: theme.radius.sm,
                  background: theme.color.inset, border: `1px solid ${awaitingConfirm ? hexA(theme.color.amber, 0.5) : theme.color.panelBorder}`,
                }}>
                  <div style={{ fontFamily: theme.font.mono, fontSize: 12, color: theme.color.text }}>
                    {programStatus?.status ?? 'starting…'}
                  </div>
                  {programStatus?.phase && (
                    <div style={{ ...hint, marginTop: 2 }}>
                      phase: {programStatus.phase}
                      {programStatus.setpointF != null ? ` · target ${programStatus.setpointF}°F` : ''}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    {awaitingConfirm && (
                      <button
                        onClick={() => a.confirmCrash(tank.id)}
                        style={{ ...actionBtn, color: theme.color.cyan, borderColor: hexA(theme.color.cyan, 0.5) }}>
                        ❄ Confirm cold crash
                      </button>
                    )}
                    <button onClick={() => a.cancelProgram(tank.id)}
                      style={{ ...actionBtn, color: theme.color.textDim }}>
                      Stop program
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <span style={hint}>Programs helper not installed yet (add ha/glasshaus_programs.yaml).</span>
          )}
        </Field>

        <Field label="Batch">
          {batchOptions.length > 1 ? (
            <Pills options={batchOptions} active={curBatch}
              onPick={(v) => a.setBatch(tank.id, v)} wrap />
          ) : (
            <span style={hint}>No fermenting batches synced from Brewfather yet.</span>
          )}
        </Field>

        <Field label="Tilt (floating — verify by temp match)">
          {tiltOptions.length ? (
            <Pills options={tiltOptions} active={curTilt}
              onPick={(v) => a.setTilt(tank.id, v)} wrap />
          ) : (
            <span style={hint}>No Tilt options configured on this tank's helper.</span>
          )}
        </Field>

        <Field label="Expected FG">
          <FgStepper current={tank.id}
            onSet={(fg) => a.setExpectedFg(tank.id, fg)} />
        </Field>

        <Field label="Cleaning">
          <button style={actionBtn}
            onClick={() => a.markCleaned(tank.id, new Date().toISOString().slice(0, 10))}>
            Mark cleaned today
          </button>
          {tank.daysSinceCleaned != null && (
            <span style={{ ...hint, marginLeft: 10 }}>last: {tank.daysSinceCleaned}d ago</span>
          )}
        </Field>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        fontFamily: theme.font.sans, fontSize: 10, letterSpacing: 1,
        textTransform: 'uppercase', color: theme.color.textLabel, marginBottom: 8,
      }}>{label}</div>
      {children}
    </div>
  );
}

function Pills({ options, active, onPick, wrap }: {
  options: string[]; active?: string; onPick: (v: string) => void; wrap?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: wrap ? 'wrap' : 'nowrap', gap: 6 }}>
      {options.map((o) => {
        const on = o === active;
        return (
          <button key={o} onClick={() => onPick(o)} style={{
            fontFamily: theme.font.mono, fontSize: 12,
            padding: '7px 12px', borderRadius: 8, cursor: 'pointer',
            border: `1px solid ${on ? theme.color.cyan : theme.color.panelBorder}`,
            background: on ? hexA(theme.color.cyan, 0.15) : theme.color.inset,
            color: on ? theme.color.cyan : theme.color.textDim,
            boxShadow: on ? theme.glow(theme.color.cyan, 0.25) : 'none',
            transition: 'all 0.12s',
          }}>{o}</button>
        );
      })}
    </div>
  );
}

function FgStepper({ current, onSet }: { current: string; onSet: (fg: number) => void }) {
  let init = 1.010;
  try {
    const e = useEntity(`input_number.${current}_expected_fg`, { returnNullIfNotFound: true });
    if (e?.state) init = Number(e.state);
  } catch { /* default */ }
  const [fg, setFg] = useState(init.toFixed(3));

  const commit = () => {
    const v = Number(fg);
    if (!isNaN(v)) onSet(v);   // writes ONLY here, on explicit blur/enter
  };

  return (
    <input
      type="text"
      inputMode="decimal"
        aria-label="Expected FG"
        placeholder="1.010"
      value={fg}
      onChange={(e) => setFg(e.target.value)}   // local state only, no write
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      style={{
        fontFamily: theme.font.mono, fontSize: 20, width: 110, textAlign: 'center',
        background: theme.color.inset, color: theme.color.text,
        border: `1px solid ${theme.color.panelBorder}`, borderRadius: 8, padding: '8px 6px',
      }}
    />
  );
}

const closeBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: theme.color.textDim,
  fontSize: 18, cursor: 'pointer',
};
const actionBtn: React.CSSProperties = {
  fontFamily: theme.font.mono, fontSize: 12, padding: '8px 14px', borderRadius: 8,
  border: `1px solid ${theme.color.panelBorder}`, background: theme.color.inset,
  color: theme.color.text, cursor: 'pointer',
};
const stepBtn: React.CSSProperties = {
  fontFamily: theme.font.mono, fontSize: 18, width: 38, height: 38, borderRadius: 8,
  border: `1px solid ${theme.color.panelBorder}`, background: theme.color.inset,
  color: theme.color.cyan, cursor: 'pointer',
};
const hint: React.CSSProperties = {
  fontFamily: theme.font.sans, fontSize: 12, color: theme.color.textFaint,
};

