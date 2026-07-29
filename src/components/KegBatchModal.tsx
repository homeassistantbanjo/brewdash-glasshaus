import { useState } from 'react';
import { theme, hexA, stateColor } from '../theme/tokens';
import { useKegs } from '../hooks/useKegs';
import { useBreweryActions } from '../hooks/useBreweryActions';
import { Tank } from '../types/domain';

/** The minimum a kegging handoff needs. Full stats (SRM/IBU/FG/OG) are re-fetched from
 *  Brewfather server-side by the keg service's `kegBatch` action, so the UI only supplies
 *  identity. `abv` is optional, shown in the header when known. */
export interface KegBatchInfo { batchNo: number | null; name: string; abv?: number | null; }

/**
 * KEGGING HANDOFF — the missing link between a fermenter and the keg fleet.
 *
 * From the tank view you couldn't previously get a finished batch INTO kegs; the keg
 * service was ready (its `kegBatch` action auto-enriches SRM/IBU/FG/OG/style from
 * Brewfather) but nothing in the UI called it. This modal is that call:
 *   pick one or more CLEAN kegs → keg each from this batch → free the tank (Dirty).
 *
 * Multi-select is deliberate: a 10g+ batch fills 2+ kegs off ONE fermenter. Tapping to
 * a line is a SEPARATE step done later from the Kegs view (you keg now, serve when ready)
 * — so this modal only FILLS. On success the tank's batch is cleared and it goes Dirty
 * (needs CIP before the next brew), keeping the board honest.
 */
export function KegBatchModal({ tank, batch, onClose }: {
  tank: Tank; batch: KegBatchInfo; onClose: () => void;
}) {
  const { kegs, kegAction, reload } = useKegs();
  const actions = useBreweryActions();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // Only CLEAN kegs can be filled (the keg lifecycle: clean → filled). A dirty/tapped/
  // filled keg isn't a valid target — surface clean ones only so you can't mis-keg.
  const cleanKegs = kegs.filter((k) => k.status === 'clean');
  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const kegIt = async () => {
    if (!selected.size || busy) return;
    setBusy(true); setResult(null);
    let ok = 0; const fails: string[] = [];
    // Fill each selected keg from this batch. kegBatch pulls Brewfather stats server-side;
    // we pass the batch number + source tank so the event log records the provenance.
    for (const id of selected) {
      const r = await kegAction(id, 'kegBatch', {
        batchNo: batch.batchNo,
        batch: { batchNo: batch.batchNo, name: batch.name },
        sourceTank: tank.id,
      });
      if (r?.ok) ok++; else fails.push(`${id}: ${r?.error || 'failed'}`);
    }
    if (ok > 0) {
      // free the fermenter: clear its batch + set Dirty (needs cleaning before next brew).
      // setBatch('') already flips status→Ready in the action; override to Dirty after.
      await actions.setBatch(tank.id, '');
      await actions.setStatus(tank.id, 'Dirty');
    }
    await reload();
    setBusy(false);
    setResult(fails.length
      ? `Kegged ${ok}, ${fails.length} failed: ${fails.join('; ')}`
      : `✓ Kegged "${batch.name}" into ${ok} keg${ok > 1 ? 's' : ''}. Tank set Dirty. Tap from the Kegs view when ready.`);
    if (!fails.length) setTimeout(onClose, 2200);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.6)',
      backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: theme.color.panelHi, border: `1px solid ${theme.color.panelBorderHi}`,
        borderRadius: theme.radius.lg, boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        width: 'min(460px, 100%)', maxHeight: '86vh', overflowY: 'auto', padding: 20,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontFamily: theme.font.mono, fontSize: 18, fontWeight: 700, color: theme.color.text }}>
            🛢 Keg — {tank.label}
          </span>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: theme.color.textDim, fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ fontFamily: theme.font.sans, fontSize: 13, color: theme.color.textDim, marginBottom: 16 }}>
          Racking <span style={{ color: theme.color.text, fontWeight: 600 }}>{batch.name}</span>
          {batch.abv != null && <> · {batch.abv.toFixed(1)}% ABV</>}. Pick the keg(s) to fill — a big batch fills more than one.
        </div>

        <div style={{ fontFamily: theme.font.sans, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: theme.color.textLabel, marginBottom: 8 }}>
          Clean kegs {selected.size > 0 && <span style={{ color: theme.color.cyan }}>· {selected.size} selected</span>}
        </div>

        {cleanKegs.length === 0 ? (
          <div style={{
            fontFamily: theme.font.sans, fontSize: 13, color: theme.color.amber,
            background: hexA(theme.color.amber, 0.1), border: `1px solid ${hexA(theme.color.amber, 0.3)}`,
            borderRadius: theme.radius.sm, padding: '10px 12px',
          }}>
            No clean kegs available. Clean a keg first (Kegs view → scan/mark cleaned), then keg this batch.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {cleanKegs.map((k) => {
              const on = selected.has(k.id);
              return (
                <button key={k.id} onClick={() => toggle(k.id)} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 12px', borderRadius: theme.radius.sm, cursor: 'pointer', textAlign: 'left',
                  border: `1px solid ${on ? theme.color.cyan : theme.color.panelBorder}`,
                  background: on ? hexA(theme.color.cyan, 0.14) : theme.color.inset,
                  color: on ? theme.color.cyan : theme.color.text,
                }}>
                  <span style={{ fontFamily: theme.font.mono, fontSize: 13 }}>
                    {on ? '☑' : '☐'} {k.label}
                    <span style={{ color: theme.color.textDim, fontSize: 11 }}> · {k.type} · {k.size_l}L</span>
                  </span>
                  {/* seal warning so you don't fill a keg with a worn o-ring */}
                  {k.health?.anySealDue && (
                    <span style={{ fontSize: 10, color: stateColor('warn') }}>⚠ seal due</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {result && (
          <div style={{
            marginTop: 14, fontFamily: theme.font.sans, fontSize: 12,
            color: result.startsWith('✓') ? stateColor('ok') : stateColor('warn'),
          }}>{result}</div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <button
            onClick={kegIt}
            disabled={!selected.size || busy}
            style={{
              flex: 1, padding: '11px 0', cursor: selected.size && !busy ? 'pointer' : 'not-allowed',
              fontFamily: theme.font.mono, fontSize: 13, letterSpacing: 1, fontWeight: 700,
              borderRadius: theme.radius.sm,
              border: `1px solid ${selected.size ? hexA(theme.color.green, 0.6) : theme.color.panelBorder}`,
              background: selected.size ? hexA(theme.color.green, 0.15) : theme.color.inset,
              color: selected.size ? theme.color.green : theme.color.textDim,
            }}>
            {busy ? 'Kegging…' : `🛢 Keg it${selected.size ? ` → ${selected.size}` : ''}`}
          </button>
          <button onClick={onClose} style={{
            padding: '11px 16px', cursor: 'pointer', fontFamily: theme.font.mono, fontSize: 13,
            borderRadius: theme.radius.sm, border: `1px solid ${theme.color.panelBorder}`,
            background: theme.color.inset, color: theme.color.textDim,
          }}>Cancel</button>
        </div>
        <div style={{ fontFamily: theme.font.sans, fontSize: 11, color: theme.color.textFaint, marginTop: 10 }}>
          Tapping to a line is done later from the Kegs view — this just fills the kegs.
        </div>
      </div>
    </div>
  );
}
