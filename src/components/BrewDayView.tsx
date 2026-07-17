/**
 * BREW DAY entry — log measured values while brewing and write them back to
 * Brewfather (via the brewfather container, which holds the API key server-side).
 * Only fields the Brewfather API accepts are here: gravities, mash pH, volumes,
 * and status. Enter in YOUR units (SG, gallons); the container converts to metric.
 *
 * Notes/environment aren't here — the Brewfather API can't take them (see the
 * container header). Those would be a separate GlassHaus-local feature.
 */
import { useEffect, useState, useRef } from 'react';
import { theme, hexA, fx } from '../theme/tokens';
import { BREWFATHER_URL } from '../config';
import { useAllTanks } from '../hooks/useBrewery';
import { useBreweryActions } from '../hooks/useBreweryActions';

interface BdBatch { _id: string; batchNo: number; name: string; status: string }

type Draft = Record<string, string>;
const FIELDS: { key: string; label: string; unit: string; step: string; hint?: string }[] = [
  // FG is intentionally NOT here — it's a fermentation-stage measurement that
  // belongs on the Tanks panel, not brew day (Planning/Brewing only).
  { key: 'preBoilGravity', label: 'Pre-Boil Gravity', unit: 'SG', step: '0.001' },
  { key: 'postBoilGravity', label: 'Post-Boil Gravity', unit: 'SG', step: '0.001' },
  { key: 'og', label: 'Original Gravity (OG)', unit: 'SG', step: '0.001' },
  { key: 'mashPh', label: 'Mash pH', unit: 'pH', step: '0.01' },
  { key: 'boilSizeGal', label: 'Pre-Boil Volume', unit: 'gal', step: '0.1' },
  { key: 'batchSizeGal', label: 'Into Fermenter', unit: 'gal', step: '0.1' },
  { key: 'bottlingSizeGal', label: 'Packaged Volume', unit: 'gal', step: '0.1' },
];

const clip = fx().brackets ? 'polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px)' : undefined;

export function BrewDayView() {
  // Batch list comes from the CONTAINER (Brewfather API, Planning + Brewing) — HA's
  // integration only surfaces active fermentations, so it wouldn't show brew-day
  // batches. Once a batch goes Fermenting it drops out (past brew day).
  const tanks = useAllTanks();
  const actions = useBreweryActions();
  const [active, setActive] = useState<BdBatch[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [assignMsg, setAssignMsg] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [state, setState] = useState<{ loading: boolean; msg: string | null; err: string | null }>(
    { loading: false, msg: null, err: null });
  const [current, setCurrent] = useState<any>(null);
  const [prep, setPrep] = useState<any>(null);
  // bumped after a save to force the current-values effect to re-fetch from Brewfather
  // (the old `setBatchId(b=>b)` was a no-op — same value = no re-run — so values vanished).
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    fetch(`${BREWFATHER_URL}/batches`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j) => setActive(j.batches || []))
      .catch((e) => setListErr(`Couldn't reach Brewfather service: ${e.message}`));
  }, []);

  const selected = active.find((b) => String(b.batchNo) === batchId) ?? active[0] ?? null;
  const selId = selected ? String(selected.batchNo) : null;

  // fetch current measured values from Brewfather to prefill/show what's there. Re-runs on
  // batch change AND after a save (refreshKey bump) so just-written values show. Only blank
  // the displayed values when the BATCH changed — on a post-save refresh keep them so the
  // fields don't flash empty (and Brewfather read-back can briefly lag).
  const prevSelId = useRef<string | null>(null);
  useEffect(() => {
    if (!selected) return;
    const batchChanged = prevSelId.current !== selId;
    prevSelId.current = selId;
    if (batchChanged) { setCurrent(null); setPrep(null); }
    setState((s) => ({ ...s, err: null }));
    const id = selected._id || selected.batchNo;
    fetch(`${BREWFATHER_URL}/batch/${encodeURIComponent(id)}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setCurrent)
      .catch((e) => setState((s) => ({ ...s, err: `Couldn't read Brewfather: ${e.message}` })));
    fetch(`${BREWFATHER_URL}/recipe/${encodeURIComponent(id)}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setPrep)
      .catch(() => {/* prep is best-effort; measurement entry still works */});
  }, [selId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!selected) return;
    const body: Record<string, number> = {};
    for (const [k, v] of Object.entries(draft)) {
      const num = parseFloat(v);
      if (v !== '' && Number.isFinite(num)) body[k] = num;
    }
    if (!Object.keys(body).length) { setState({ loading: false, msg: null, err: 'Nothing entered to save.' }); return; }
    setState({ loading: true, msg: null, err: null });
    try {
      const id = selected._id || selected.batchNo;
      const r = await fetch(`${BREWFATHER_URL}/batch/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setState({ loading: false, msg: `Saved to Brewfather: ${(j.wrote || []).join(', ')}`, err: null });
      // OPTIMISTICALLY show what we just saved as the current values IMMEDIATELY — the fields
      // read from current.measured[key], so merging the sent body in means the entered values
      // persist visibly right away (Brewfather's read-back can lag a few seconds). Clearing
      // the draft is correct once saved (it's now "current", not an unsaved edit).
      setCurrent((c: any) => ({ ...(c || {}), measured: { ...(c?.measured || {}), ...body } }));
      setDraft({});
      // then reconcile against Brewfather (bump refreshKey → the fetch effect re-runs; the
      // old setBatchId(b=>b) was a no-op, which is why values vanished with nothing to show).
      setTimeout(() => setRefreshKey((k) => k + 1), 1500);
    } catch (e) {
      setState({ loading: false, msg: null, err: (e as Error).message });
    }
  };

  // advance the batch's Brewfather status (Phase 1: Planning → Brewing, when you
  // pull the recipe on the BrewTools touchscreen). Deliberate, one tap.
  const [statusBusy, setStatusBusy] = useState(false);
  const setBatchStatus = async (status: string) => {
    if (!selected) return;
    setStatusBusy(true); setState((s) => ({ ...s, err: null }));
    try {
      const id = selected._id || selected.batchNo;
      const r = await fetch(`${BREWFATHER_URL}/batch/${encodeURIComponent(id)}/status`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setState({ loading: false, msg: `Batch set to ${status} in Brewfather`, err: null });
      // reflect locally + refresh the list so the pill/status updates
      setActive((prev) => prev.map((b) => (b.batchNo === selected.batchNo ? { ...b, status } : b)));
    } catch (e) {
      setState({ loading: false, msg: null, err: (e as Error).message });
    } finally { setStatusBusy(false); }
  };

  // fermenters that can take a batch = Ready (clean & empty), with a controller
  const readyTanks = tanks.filter((t) => t.status === 'Ready' && t.hasController);

  // assign the selected batch to a fermenter: batch→tank + tank Fermenting + Tilt.
  const assignToTank = async (tankId: string, tankLabel: string, tilt: string) => {
    if (!selected) return;
    setAssignMsg(null);
    await actions.setBatch(tankId, String(selected.batchNo)); // free-text batchNo
    if (tilt && tilt !== 'None') await actions.setTilt(tankId, tilt);
    await actions.setStatus(tankId, 'Fermenting');
    setAssignMsg(`${prep?.name || 'Batch'} → ${tankLabel}${tilt && tilt !== 'None' ? ` · ${tilt} Tilt` : ''} (now Fermenting).`);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, paddingRight: 4 }}>
      <div style={{ fontFamily: theme.font.mono, fontSize: 12, letterSpacing: 1, color: theme.color.textLabel, textTransform: 'uppercase' }}>
        Brew Day · log measurements → Brewfather
      </div>

      {listErr ? (
        <div style={{
          fontFamily: theme.font.sans, fontSize: 13, color: theme.color.red,
          background: hexA(theme.color.red, 0.1), border: `1px solid ${hexA(theme.color.red, 0.4)}`,
          borderRadius: theme.radius.md, padding: '10px 14px',
        }}>{listErr} — is the Glasshaus-brewfather container running on :8093?</div>
      ) : active.length === 0 ? (
        <div style={{ fontFamily: theme.font.sans, fontSize: 13, color: theme.color.textDim, padding: 20 }}>
          No batches in <b>Planning</b> or <b>Brewing</b> status in Brewfather. Set a batch to Brewing
          in Brewfather when you start brew day, and it'll appear here.
        </div>
      ) : (
        <>
          {/* batch selector — labeled so it's clearly a picker even with one batch.
              Shows the RECIPE name (what you recognize) for the loaded batch; the
              batch's own name is often generic ("Batch"). */}
          <div style={{ fontFamily: theme.font.mono, fontSize: 11, letterSpacing: 1.5, color: theme.color.textFaint, textTransform: 'uppercase' }}>
            ⌐ Select Batch {active.length > 1 ? `(${active.length} in Planning/Brewing)` : ''}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {active.map((b) => {
              const on = String(b.batchNo) === selId;
              // for the selected batch we know its recipe name (from the prep fetch)
              const label = on && prep?.name ? prep.name : (b.name && b.name !== 'Batch' ? b.name : `Batch #${b.batchNo}`);
              return (
                <button key={b.batchNo} onClick={() => { setBatchId(String(b.batchNo)); setDraft({}); }}
                  style={{
                    fontFamily: theme.font.mono, fontSize: 13, padding: '9px 14px', cursor: 'pointer', clipPath: clip,
                    borderRadius: clip ? 0 : 8, display: 'flex', alignItems: 'center', gap: 7,
                    border: `1px solid ${on ? theme.color.cyan : theme.color.panelBorder}`,
                    background: on ? hexA(theme.color.cyan, 0.18) : theme.color.inset,
                    color: on ? theme.color.cyan : theme.color.textDim,
                    boxShadow: on ? theme.glow(theme.color.cyan, 0.25) : 'none',
                  }}>
                  <span>{on ? '●' : '○'}</span>
                  {label}
                  <span style={{ opacity: 0.55, fontSize: 10 }}>#{b.batchNo} · {b.status}</span>
                </button>
              );
            })}
          </div>

          {/* START BREWING — deliberate Planning→Brewing status flip, shown only for
              a Planning batch (you tap this when you pull the recipe on BrewTools). */}
          {selected?.status === 'Planning' && (
            <button onClick={() => setBatchStatus('Brewing')} disabled={statusBusy} style={{
              alignSelf: 'flex-start', fontFamily: theme.font.mono, fontSize: 12, letterSpacing: 1,
              textTransform: 'uppercase', padding: '9px 18px', cursor: statusBusy ? 'wait' : 'pointer',
              clipPath: clip, borderRadius: clip ? 0 : 8,
              border: `1px solid ${theme.color.green}`, background: hexA(theme.color.green, 0.16),
              color: theme.color.green, boxShadow: theme.glow(theme.color.green, 0.25),
            }}>{statusBusy ? 'Setting…' : '▸ Start Brewing (set Brewing in Brewfather)'}</button>
          )}
          {selected && selected.status !== 'Planning' && (
            <div style={{ fontFamily: theme.font.mono, fontSize: 11, color: theme.color.textDim, letterSpacing: 0.5 }}>
              Status: <span style={{ color: theme.color.cyan }}>{selected.status}</span>
              {selected.status === 'Brewing' && ' — brewing in progress'}
            </div>
          )}

          {/* ASSIGN TO FERMENTER — after the boil, put the batch in a Ready tank.
              Sets batch→tank + tank Fermenting + the Tilt going in it (GlassHaus side;
              Brewfather's own device-attach is a separate manual step in BF settings). */}
          {selected && (
            <AssignToFermenter
              readyTanks={readyTanks}
              onAssign={assignToTank}
              msg={assignMsg} />
          )}

          {/* PREP — recipe bill for weighing out (read-only, from Brewfather) */}
          {prep && <PrepSection prep={prep} />}

          {/* LOG — measurement entry (writes back to Brewfather) */}
          <div style={{ fontFamily: theme.font.mono, fontSize: 11, letterSpacing: 1.5, color: theme.color.textFaint, textTransform: 'uppercase', marginTop: 6 }}>
            ⌐ Log Measurements → Brewfather
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, maxWidth: 720 }}>
            {FIELDS.map((f) => {
              const cur = current?.measured?.[f.key];
              const tgt = prep?.target?.[f.key];
              return (
                <div key={f.key} style={{
                  background: theme.color.panelHi, clipPath: clip, borderRadius: clip ? 0 : theme.radius.md,
                  border: `1px solid ${theme.color.panelBorder}`, padding: '10px 12px',
                  display: 'flex', flexDirection: 'column', gap: 6,
                }}>
                  <label style={{ fontFamily: theme.font.sans, fontSize: 11, letterSpacing: 0.5, color: theme.color.textLabel, textTransform: 'uppercase', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span>{f.label}</span>
                    {tgt != null && <span style={{ color: theme.color.cyan }}>target {tgt}</span>}
                    {cur != null && <span style={{ color: theme.color.textFaint }}>now {cur}</span>}
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="number" inputMode="decimal" step={f.step}
                      value={draft[f.key] ?? ''}
                      placeholder={cur != null ? String(cur) : '—'}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      style={{
                        flex: 1, fontFamily: theme.font.mono, fontSize: 18, fontWeight: 600,
                        background: theme.color.inset, border: `1px solid ${theme.color.panelBorder}`,
                        borderRadius: 6, padding: '8px 10px', color: theme.color.text, minWidth: 0,
                      }} />
                    <span style={{ fontFamily: theme.font.mono, fontSize: 12, color: theme.color.textDim, width: 30 }}>{f.unit}</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <button onClick={save} disabled={state.loading} style={{
              fontFamily: theme.font.mono, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase',
              padding: '10px 22px', cursor: state.loading ? 'wait' : 'pointer', clipPath: clip, borderRadius: clip ? 0 : 8,
              border: `1px solid ${theme.color.cyan}`, background: hexA(theme.color.cyan, 0.18), color: theme.color.cyan,
              boxShadow: theme.glow(theme.color.cyan, 0.3),
            }}>{state.loading ? 'Saving…' : '↑ Save to Brewfather'}</button>
            {state.msg && <span style={{ fontFamily: theme.font.sans, fontSize: 13, color: theme.color.green }}>✓ {state.msg}</span>}
            {state.err && <span style={{ fontFamily: theme.font.sans, fontSize: 13, color: theme.color.red }}>✕ {state.err}</span>}
          </div>

          <div style={{ fontFamily: theme.font.sans, fontSize: 11, color: theme.color.textFaint, marginTop: 4, maxWidth: 720, lineHeight: 1.5 }}>
            Gravities in SG, volumes in gallons (converted to litres for Brewfather). Only fields you fill are written;
            blanks leave Brewfather unchanged. Notes / mash time / environment aren't writable via the Brewfather API.
          </div>
        </>
      )}
    </div>
  );
}

// ---- unit conversions for the prep display -----------------------------------
const KG_TO_LB = 2.2046226218;
const L_TO_GAL = 0.2641720524;
/** kg → "X lb Y oz" (how you'd weigh grain). Rounds ounces to 0.1 FIRST, then
 *  carries into pounds, so 16.0 oz becomes +1 lb 0 oz (not "16 lb 16 oz"). */
function kgToLbOz(kg: number | null): string {
  if (kg == null) return '—';
  let oz = Math.round(kg * KG_TO_LB * 16 * 10) / 10; // total oz, 0.1 precision
  let lb = Math.floor(oz / 16);
  oz = Math.round((oz - lb * 16) * 10) / 10;
  if (oz >= 16) { lb += 1; oz = 0; } // safety carry
  return lb > 0 ? `${lb} lb ${oz} oz` : `${oz} oz`;
}
const lToGal = (l: number | null) => (l == null ? '—' : `${(l * L_TO_GAL).toFixed(2)} gal`);

/**
 * PREP — the recipe ingredient bill for brew-day prep, in the units you weigh in:
 * grain in lb+oz, water in gallons, salts/acids in their native g/ml, hops in g.
 * Read-only, pulled live from Brewfather.
 */
function PrepSection({ prep }: { prep: any }) {
  const card: React.CSSProperties = {
    background: theme.color.panelHi, clipPath: clip, borderRadius: clip ? 0 : theme.radius.md,
    border: `1px solid ${theme.color.panelBorder}`, padding: '12px 14px',
    display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
  };
  const head = (t: string) => (
    <div style={{ fontFamily: theme.font.mono, fontSize: 11, letterSpacing: 1.5, color: theme.color.cyan, textTransform: 'uppercase' }}>{t}</div>
  );
  const row = (l: string, r: string, warn?: boolean) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontFamily: theme.font.sans, fontSize: 13 }}>
      <span style={{ color: theme.color.textLabel, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l}</span>
      <span style={{ fontFamily: theme.font.mono, fontWeight: 600, color: warn ? theme.color.amber : theme.color.text, whiteSpace: 'nowrap' }}>{r}</span>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontFamily: theme.font.mono, fontSize: 11, letterSpacing: 1.5, color: theme.color.textFaint, textTransform: 'uppercase' }}>
        ⌐ Prep · {prep.name}{prep.style ? ` · ${prep.style}` : ''}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
        {/* GRAIN */}
        <div style={card}>
          {head(`Grain Bill (${(prep.fermentables || []).length})`)}
          {(prep.fermentables || []).map((f: any, i: number) => row(f.name, kgToLbOz(f.kg), false))}
          {prep.fermentables?.length ? row('— total —',
            kgToLbOz((prep.fermentables).reduce((s: number, f: any) => s + (f.kg || 0), 0))) : null}
        </div>
        {/* WATER — Mash / Sparge / Top-up as distinct values (source conflates them; the
            sidecar resolves each from its authoritative field so all methods read right:
            no-sparge → Sparge "—" + Top-up shown; sparge → Sparge shown; big batch over
            vessel capacity → Top-up = end-of-boil gap). */}
        <div style={card}>
          {head('Water')}
          {row('Mash / strike', lToGal(prep.water?.mashL))}
          {row('Sparge', lToGal(prep.water?.spargeL))}
          {prep.water?.topUpL != null && row('Top-up', lToGal(prep.water?.topUpL))}
          {row('Boil size', lToGal(prep.boilSizeL))}
          {row('Batch size', lToGal(prep.batchSizeL))}
        </div>
        {/* SALTS / WATER AGENTS */}
        {(prep.salts || []).length > 0 && (
          <div style={card}>
            {head(`Salts & Acids (${prep.salts.length})`)}
            {prep.salts.map((s: any, i: number) => row(`${s.name}${s.use && s.use !== 'Mash' ? ` (${s.use})` : ''}`,
              `${s.amount ?? '—'} ${s.unit}`))}
          </div>
        )}
        {/* HOPS */}
        {(prep.hops || []).length > 0 && (
          <div style={card}>
            {head(`Hops (${prep.hops.length})`)}
            {prep.hops.map((h: any, i: number) => row(
              `${h.name}${h.alpha != null ? ` · ${h.alpha}% AA` : ''}${h.form ? ` · ${h.form}` : ''}${h.time != null ? ` · ${h.time}m ${h.use}` : h.use ? ` · ${h.use}` : ''}`,
              `${h.g != null ? h.g.toFixed(1) : '—'} g`))}
          </div>
        )}
        {/* OTHER MASH ADDITIONS (e.g. Brewtan B) */}
        {(prep.otherMiscs || []).length > 0 && (
          <div style={card}>
            {head('Other Additions')}
            {prep.otherMiscs.map((m: any, i: number) => row(`${m.name}${m.use ? ` (${m.use})` : ''}`, `${m.amount ?? '—'} ${m.unit}`))}
          </div>
        )}
        {/* MASH STEPS */}
        {(prep.mashSteps || []).length > 0 && (
          <div style={card}>
            {head('Mash Steps')}
            {prep.mashSteps.map((s: any, i: number) => row(s.name || `Step ${i + 1}`,
              `${s.tempC != null ? Math.round(s.tempC * 9 / 5 + 32) + '°F' : '—'} · ${s.min ?? '—'}m`))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * ASSIGN TO FERMENTER — the brew-day handoff: pick a Ready (clean, empty) tank and
 * the Tilt going in it, then confirm. Writes batch→tank + Tilt + tank Fermenting.
 * Note: Brewfather's own Tilt/device attach is a separate manual step in Brewfather
 * settings — the API can't set it, so this only handles the GlassHaus side.
 */
function AssignToFermenter({ readyTanks, onAssign, msg }: {
  readyTanks: { id: string; label: string }[];
  onAssign: (tankId: string, label: string, tilt: string) => void;
  msg: string | null;
}) {
  const [tankId, setTankId] = useState<string | null>(null);
  const [tilt, setTilt] = useState('None');
  const [busy, setBusy] = useState(false);
  const tank = readyTanks.find((t) => t.id === tankId);
  const TILTS = ['None', 'Black', 'Red', 'Blue', 'Green', 'Orange', 'Purple', 'Pink', 'Yellow'];

  const pill = (on: boolean): React.CSSProperties => ({
    fontFamily: theme.font.mono, fontSize: 12, padding: '7px 12px', cursor: 'pointer', clipPath: clip,
    borderRadius: clip ? 0 : 8,
    border: `1px solid ${on ? theme.color.cyan : theme.color.panelBorder}`,
    background: on ? hexA(theme.color.cyan, 0.15) : theme.color.inset,
    color: on ? theme.color.cyan : theme.color.textDim,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontFamily: theme.font.mono, fontSize: 11, letterSpacing: 1.5, color: theme.color.textFaint, textTransform: 'uppercase' }}>
        ⌐ Assign to Fermenter
      </div>
      {readyTanks.length === 0 ? (
        <div style={{ fontFamily: theme.font.sans, fontSize: 12.5, color: theme.color.textDim }}>
          No fermenters are Ready. Clean/free a tank (set it Ready in ⚙ Manage) to assign this batch.
        </div>
      ) : (
        <>
          <div style={{ fontFamily: theme.font.sans, fontSize: 11, color: theme.color.textLabel }}>1 · Pick a ready fermenter</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {readyTanks.map((t) => (
              <button key={t.id} onClick={() => setTankId(t.id)} style={pill(t.id === tankId)}>{t.label}</button>
            ))}
          </div>
          {tankId && <>
            <div style={{ fontFamily: theme.font.sans, fontSize: 11, color: theme.color.textLabel, marginTop: 4 }}>
              2 · Which Tilt is going in? <span style={{ color: theme.color.textFaint }}>(GlassHaus mapping; attach the device in Brewfather separately)</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {TILTS.map((c) => (
                <button key={c} onClick={() => setTilt(c)} style={pill(c === tilt)}>{c}</button>
              ))}
            </div>
            <button disabled={busy} onClick={async () => { setBusy(true); await onAssign(tankId, tank!.label, tilt); setBusy(false); setTankId(null); }}
              style={{
                alignSelf: 'flex-start', marginTop: 6, fontFamily: theme.font.mono, fontSize: 12, letterSpacing: 1,
                textTransform: 'uppercase', padding: '9px 18px', cursor: busy ? 'wait' : 'pointer', clipPath: clip,
                borderRadius: clip ? 0 : 8, border: `1px solid ${theme.color.green}`,
                background: hexA(theme.color.green, 0.16), color: theme.color.green, boxShadow: theme.glow(theme.color.green, 0.25),
              }}>{busy ? 'Assigning…' : `▸ Put in ${tank!.label}${tilt !== 'None' ? ` · ${tilt} Tilt` : ''}`}</button>
          </>}
        </>
      )}
      {msg && <span style={{ fontFamily: theme.font.sans, fontSize: 13, color: theme.color.green }}>✓ {msg}</span>}
    </div>
  );
}
