/**
 * BREW DAY entry — log measured values while brewing and write them back to
 * Brewfather (via the brewfather container, which holds the API key server-side).
 * Only fields the Brewfather API accepts are here: gravities, mash pH, volumes,
 * and status. Enter in YOUR units (SG, gallons); the container converts to metric.
 *
 * Notes/environment aren't here — the Brewfather API can't take them (see the
 * container header). Those would be a separate GlassHaus-local feature.
 */
import { useEffect, useState } from 'react';
import { theme, hexA, fx } from '../theme/tokens';
import { BREWFATHER_URL } from '../config';

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
  const [active, setActive] = useState<BdBatch[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [state, setState] = useState<{ loading: boolean; msg: string | null; err: string | null }>(
    { loading: false, msg: null, err: null });
  const [current, setCurrent] = useState<any>(null);

  useEffect(() => {
    fetch(`${BREWFATHER_URL}/batches`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j) => setActive(j.batches || []))
      .catch((e) => setListErr(`Couldn't reach Brewfather service: ${e.message}`));
  }, []);

  const selected = active.find((b) => String(b.batchNo) === batchId) ?? active[0] ?? null;
  const selId = selected ? String(selected.batchNo) : null;

  // fetch current measured values from Brewfather to prefill/show what's there
  useEffect(() => {
    if (!selected) return;
    setCurrent(null); setState((s) => ({ ...s, err: null }));
    fetch(`${BREWFATHER_URL}/batch/${encodeURIComponent(selected._id || selected.batchNo)}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setCurrent)
      .catch((e) => setState((s) => ({ ...s, err: `Couldn't read Brewfather: ${e.message}` })));
  }, [selId]); // eslint-disable-line react-hooks/exhaustive-deps

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
      setDraft({});
      // refresh the shown current values
      setTimeout(() => setBatchId((b) => b), 300);
    } catch (e) {
      setState({ loading: false, msg: null, err: (e as Error).message });
    }
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
        }}>{listErr} — is the Glasshaus-brewfather container running on :8092?</div>
      ) : active.length === 0 ? (
        <div style={{ fontFamily: theme.font.sans, fontSize: 13, color: theme.color.textDim, padding: 20 }}>
          No batches in <b>Planning</b> or <b>Brewing</b> status in Brewfather. Set a batch to Brewing
          in Brewfather when you start brew day, and it'll appear here.
        </div>
      ) : (
        <>
          {/* batch selector */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {active.map((b) => {
              const on = String(b.batchNo) === selId;
              return (
                <button key={b.batchNo} onClick={() => { setBatchId(String(b.batchNo)); setDraft({}); }}
                  style={{
                    fontFamily: theme.font.mono, fontSize: 12, padding: '7px 12px', cursor: 'pointer', clipPath: clip,
                    borderRadius: clip ? 0 : 8,
                    border: `1px solid ${on ? theme.color.cyan : theme.color.panelBorder}`,
                    background: on ? hexA(theme.color.cyan, 0.15) : theme.color.inset,
                    color: on ? theme.color.cyan : theme.color.textDim,
                  }}>{b.name} <span style={{ opacity: 0.6 }}>· {b.status}</span></button>
              );
            })}
          </div>

          {/* measurement fields */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, maxWidth: 720 }}>
            {FIELDS.map((f) => {
              const cur = current?.measured?.[f.key];
              return (
                <div key={f.key} style={{
                  background: theme.color.panelHi, clipPath: clip, borderRadius: clip ? 0 : theme.radius.md,
                  border: `1px solid ${theme.color.panelBorder}`, padding: '10px 12px',
                  display: 'flex', flexDirection: 'column', gap: 6,
                }}>
                  <label style={{ fontFamily: theme.font.sans, fontSize: 11, letterSpacing: 0.5, color: theme.color.textLabel, textTransform: 'uppercase' }}>
                    {f.label}
                    {cur != null && <span style={{ color: theme.color.textFaint, marginLeft: 6 }}>now: {cur}</span>}
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
