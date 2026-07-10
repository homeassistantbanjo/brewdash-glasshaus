/**
 * FERMENTATION PLAN EDITOR — Claude proposes a strain+flavor-aware temp plan; you
 * edit it fully (temps, advance triggers, add/remove/reorder steps, gating) before
 * it runs. Flow: pick a flavor intent (yeast-aware) + optional notes → generate →
 * edit → Accept (writes the plan to sensor.tank_N_program_plan via HA + sets the
 * program to 'Generated'). Per-batch; the runner drives it on the existing engine.
 *
 * Reorder is via up/down buttons (touch-reliable on the kiosk, no drag lib).
 */
import { useEffect, useState } from 'react';
import { theme, hexA, fx } from '../theme/tokens';
import { BREWFATHER_URL, HA_URL, HA_TOKEN } from '../config';
import { useBreweryActions } from '../hooks/useBreweryActions';

const clip = fx().brackets ? 'polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px)' : undefined;
const KINDS = ['hold', 'ramp', 'wait', 'coldCrash'] as const;
const ADV = ['attenuationOfExpected', 'terminal', 'active', 'elapsed', 'confirm'] as const;

interface Phase {
  name: string; kind: string;
  tempF?: number; targetF?: number; stepF?: number; everyHours?: number; hours?: number;
  advance?: { type: string; pct?: number; hours?: number };
  requiresConfirm?: boolean; why?: string;
}
interface Plan { summary?: string; label?: string; expectedAtten?: number | null; clamp: { minF: number; maxF: number }; phases: Phase[]; yeast?: string }

export function FermPlanEditor({ tankId, batchNo, onClose }: {
  tankId: string; batchNo: number | string; onClose: () => void;
}) {
  const actions = useBreweryActions();
  const [intents, setIntents] = useState<{ label: string; hint?: string }[] | null>(null);
  const [intent, setIntent] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // fetch yeast-aware flavor intents on open
  useEffect(() => {
    fetch(`${BREWFATHER_URL}/fermplan-intents/${encodeURIComponent(batchNo)}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j) => setIntents(j.intents || []))
      .catch(() => setIntents([])); // intents are optional; free-text still works
  }, [batchNo]);

  const generate = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${BREWFATHER_URL}/fermplan/${encodeURIComponent(batchNo)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent, notes }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setPlan(j);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const patchPhase = (i: number, patch: Partial<Phase>) =>
    setPlan((p) => p && ({ ...p, phases: p.phases.map((ph, j) => (j === i ? { ...ph, ...patch } : ph)) }));
  const move = (i: number, dir: -1 | 1) => setPlan((p) => {
    if (!p) return p; const j = i + dir; if (j < 0 || j >= p.phases.length) return p;
    const ph = [...p.phases]; [ph[i], ph[j]] = [ph[j], ph[i]]; return { ...p, phases: ph };
  });
  const del = (i: number) => setPlan((p) => p && ({ ...p, phases: p.phases.filter((_, j) => j !== i) }));
  const add = () => setPlan((p) => p && ({ ...p, phases: [...p.phases, { name: 'new step', kind: 'hold', tempF: 66, advance: { type: 'terminal' } }] }));

  // Accept → write the plan into sensor.tank_N_program_plan (attrs, no size limit)
  // via the HA API, then set the program to 'Generated'. Strip display-only `why`/
  // `summary` from the stored plan (keep it lean).
  const accept = async () => {
    if (!plan) return;
    setBusy(true); setErr(null);
    try {
      const stored = {
        label: plan.label || plan.summary?.slice(0, 40) || 'Generated plan',
        clamp: plan.clamp, expectedAtten: plan.expectedAtten ?? null,
        phases: plan.phases.map(({ why, ...ph }) => ph), // drop why
      };
      // 1) write the plan sensor via HA (attributes carry the object)
      const r = await fetch(`${HA_URL}/api/states/sensor.${tankId}_program_plan`, {
        method: 'POST', headers: { Authorization: `Bearer ${HA_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ state: stored.label, attributes: { friendly_name: `${tankId} program plan`, tank: tankId, plan: stored } }),
      });
      if (!r.ok) throw new Error(`HA write failed: HTTP ${r.status}`);
      // 2) flip the program to Generated (resets phase; runner picks it up)
      await actions.setGeneratedPlan(tankId, stored.label);
      setSaved(true);
      setTimeout(onClose, 900);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} title={`Fermentation Plan · ${tankId.replace('_', ' ')}`}>
      {!plan ? (
        /* STEP 1: flavor intent + generate */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontFamily: theme.font.sans, fontSize: 13, color: theme.color.textLabel }}>
            What flavor are you aiming for? Temperature drives ester/phenol expression, so this shapes the plan.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(intents || []).map((it) => (
              <button key={it.label} title={it.hint} onClick={() => setIntent(it.label)} style={pill(it.label === intent)}>
                {it.label}
              </button>
            ))}
            {intents && intents.length === 0 && <span style={{ fontSize: 12, color: theme.color.textDim }}>Describe your target below.</span>}
          </div>
          <input value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="optional notes — e.g. 'light banana, low clove' or 'bone dry & clean'"
            style={inp} />
          <button onClick={generate} disabled={busy} style={primary(busy)}>
            {busy ? 'Asking Claude…' : '✦ Generate Plan'}
          </button>
          {err && <span style={{ color: theme.color.red, fontSize: 13 }}>✕ {err}</span>}
        </div>
      ) : (
        /* STEP 2: review + edit */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {plan.summary && <div style={{ fontFamily: theme.font.sans, fontSize: 13, color: theme.color.text, lineHeight: 1.5 }}>{plan.summary}</div>}
          <div style={{ fontFamily: theme.font.mono, fontSize: 11, color: theme.color.textDim }}>
            {plan.yeast} · expected atten {plan.expectedAtten ?? '—'}% · clamp {plan.clamp.minF}–{plan.clamp.maxF}°F
          </div>
          {plan.phases.map((ph, i) => (
            <div key={i} style={{
              background: theme.color.inset, clipPath: clip, borderRadius: clip ? 0 : theme.radius.sm,
              border: `1px solid ${ph.requiresConfirm ? hexA(theme.color.amber, 0.5) : theme.color.panelBorder}`,
              padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <input value={ph.name} onChange={(e) => patchPhase(i, { name: e.target.value })} style={{ ...inp, flex: 1, minWidth: 90, fontSize: 13 }} />
                <select value={ph.kind} onChange={(e) => patchPhase(i, { kind: e.target.value })} style={sel}>
                  {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                <button onClick={() => move(i, -1)} disabled={i === 0} style={mini}>↑</button>
                <button onClick={() => move(i, 1)} disabled={i === plan.phases.length - 1} style={mini}>↓</button>
                <button onClick={() => del(i)} style={{ ...mini, color: theme.color.red }}>✕</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontFamily: theme.font.mono, fontSize: 11, color: theme.color.textDim }}>
                {(ph.kind === 'hold') && <NumF label="°F" v={ph.tempF} on={(v) => patchPhase(i, { tempF: v })} />}
                {(ph.kind === 'ramp' || ph.kind === 'coldCrash') && <>
                  <NumF label="→°F" v={ph.targetF} on={(v) => patchPhase(i, { targetF: v })} />
                  <NumF label="step°F" v={ph.stepF} on={(v) => patchPhase(i, { stepF: v })} />
                  <NumF label="every h" v={ph.everyHours} on={(v) => patchPhase(i, { everyHours: v })} />
                </>}
                {(ph.kind === 'wait') && <NumF label="hours" v={ph.hours} on={(v) => patchPhase(i, { hours: v })} />}
                <span>· advance</span>
                <select value={ph.advance?.type || 'terminal'} onChange={(e) => patchPhase(i, { advance: { ...ph.advance, type: e.target.value } })} style={sel}>
                  {ADV.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                {ph.advance?.type === 'attenuationOfExpected' && <NumF label="% of exp" v={ph.advance.pct} on={(v) => patchPhase(i, { advance: { ...ph.advance!, pct: v } })} />}
                {ph.advance?.type === 'elapsed' && <NumF label="hours" v={ph.advance.hours} on={(v) => patchPhase(i, { advance: { ...ph.advance!, hours: v } })} />}
                <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!ph.requiresConfirm} disabled={ph.kind === 'coldCrash'}
                    onChange={(e) => patchPhase(i, { requiresConfirm: e.target.checked })} />
                  gated{ph.kind === 'coldCrash' ? ' (crash always)' : ''}
                </label>
              </div>
              {ph.why && <div style={{ fontFamily: theme.font.sans, fontSize: 11, color: theme.color.textFaint, fontStyle: 'italic' }}>{ph.why}</div>}
            </div>
          ))}
          <button onClick={add} style={{ ...mini, alignSelf: 'flex-start', padding: '6px 12px' }}>+ add step</button>
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button onClick={accept} disabled={busy || saved} style={primary(busy)}>
              {saved ? '✓ Plan running' : busy ? 'Saving…' : '▸ Accept & Run this plan'}
            </button>
            <button onClick={() => setPlan(null)} style={pill(false)}>← re-generate</button>
          </div>
          {err && <span style={{ color: theme.color.red, fontSize: 13 }}>✕ {err}</span>}
          <div style={{ fontFamily: theme.font.sans, fontSize: 11, color: theme.color.textFaint, lineHeight: 1.5 }}>
            A starting point — edit freely. Cold crash always waits for your ❄ confirm. Applies to this batch only.
          </div>
        </div>
      )}
    </Modal>
  );
}

// --- little inline UI bits ----------------------------------------------------
const inp: React.CSSProperties = { fontFamily: theme.font.mono, fontSize: 12, background: theme.color.inset, border: `1px solid ${theme.color.panelBorder}`, borderRadius: 5, padding: '6px 8px', color: theme.color.text };
const sel: React.CSSProperties = { ...inp, padding: '4px 6px' };
const mini: React.CSSProperties = { fontFamily: theme.font.mono, fontSize: 12, padding: '4px 8px', cursor: 'pointer', border: `1px solid ${theme.color.panelBorder}`, background: theme.color.inset, color: theme.color.textLabel, borderRadius: 5 };
function pill(on: boolean): React.CSSProperties {
  return { fontFamily: theme.font.mono, fontSize: 12, padding: '7px 12px', cursor: 'pointer', clipPath: clip, borderRadius: clip ? 0 : 8, border: `1px solid ${on ? theme.color.cyan : theme.color.panelBorder}`, background: on ? hexA(theme.color.cyan, 0.15) : theme.color.inset, color: on ? theme.color.cyan : theme.color.textDim };
}
function primary(busy: boolean): React.CSSProperties {
  return { alignSelf: 'flex-start', fontFamily: theme.font.mono, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase', padding: '10px 20px', cursor: busy ? 'wait' : 'pointer', clipPath: clip, borderRadius: clip ? 0 : 8, border: `1px solid ${theme.color.cyan}`, background: hexA(theme.color.cyan, 0.18), color: theme.color.cyan, boxShadow: theme.glow(theme.color.cyan, 0.3) };
}
function NumF({ label, v, on }: { label: string; v?: number; on: (n: number) => void }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <input type="number" value={v ?? ''} onChange={(e) => on(parseFloat(e.target.value))}
        style={{ ...inp, width: 54, padding: '4px 6px', fontSize: 12 }} />
      <span>{label}</span>
    </span>
  );
}
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: theme.color.panelHi, backdropFilter: `blur(${theme.blur})`,
        border: `1px solid ${theme.color.panelBorderHi}`, borderRadius: theme.radius.lg,
        boxShadow: `0 16px 48px rgba(0,0,0,0.6)`, padding: 18, width: 'min(680px, 94vw)', maxHeight: '88vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontFamily: theme.font.mono, fontSize: 14, fontWeight: 700, letterSpacing: 1, color: theme.color.cyan }}>✦ {title}</span>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: theme.color.textDim, fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
