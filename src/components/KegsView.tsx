import { useState } from 'react';
import { theme, hexA } from '../theme/tokens';
import { useKegs, type Keg, type TapLine } from '../hooks/useKegs';
import { KEGS_URL } from '../config';

const sevColor: Record<string, string> = { ok: theme.color.green, warning: theme.color.amber, critical: theme.color.red };
const statusColor: Record<string, string> = {
  dirty: theme.color.red, clean: theme.color.cyan, filled: theme.color.blue,
  tapped: theme.color.green, empty: theme.color.amber, retired: theme.color.textFaint,
};

/**
 * Tablet-responsive KEG + TAP management board — the backend work-surface for cleaning
 * sessions (distinct from the QR scan-to-log page and the future bar-top taplist display;
 * those don't merge with this — see docs/keg-management-design.md). Grid auto-fits so it
 * reads well from a 14" tablet down to a laptop.
 */
export function KegsView() {
  const { kegs, taps, error, loading, kegAction, tapAction } = useKegs();
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (msg: string, ms = 2200) => { setToast(msg); setTimeout(() => setToast(null), ms); };

  async function run(id: string, action: string, params: Record<string, unknown> = {}) {
    setBusy(id);
    try {
      const r = await kegAction(id, action, params);
      if (r?.warn) flash(`⚠ ${r.warn}`);
      else if (r?.ok === false) flash(`✗ ${r.error || 'failed'}`);
      else flash('✓ done', 1200);
    } finally { setBusy(null); }
  }
  async function runTap(tap: number, action: string) {
    setBusy(`tap-${tap}`);
    try {
      const r = await tapAction(tap, action);
      flash(r?.ok ? '✓ line cleaned' : `✗ ${r?.error || 'failed'}`, 1200);
    } finally { setBusy(null); }
  }

  if (loading) return <Center>loading kegs…</Center>;
  if (error) return <Center><span style={{ color: theme.color.red }}>Keg service unreachable: {error}</span></Center>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, height: '100%', overflowY: 'auto', paddingBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ margin: 0, fontFamily: theme.font.sans, fontSize: 16, fontWeight: 700, color: theme.color.text }}>🛢 Kegs</h2>
        <span style={{ fontFamily: theme.font.mono, fontSize: 11, color: theme.color.textDim }}>{kegs.length} kegs</span>
        <a href={`${KEGS_URL}/kegs-print`} target="_blank" rel="noreferrer"
          style={{ marginLeft: 'auto', fontFamily: theme.font.mono, fontSize: 11, color: theme.color.cyan, textDecoration: 'none' }}>
          ⎙ print all labels
        </a>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {kegs.map((k) => <KegCard key={k.id} keg={k} busy={busy === k.id} onAction={run} />)}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
        <h2 style={{ margin: 0, fontFamily: theme.font.sans, fontSize: 16, fontWeight: 700, color: theme.color.text }}>🚰 Tap Lines</h2>
        <span style={{ fontFamily: theme.font.mono, fontSize: 11, color: theme.color.textDim }}>{taps.length} taps</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
        {taps.map((t) => <TapCard key={t.tap} tap={t} busy={busy === `tap-${t.tap}`} onClean={runTap} kegs={kegs} />)}
      </div>

      {toast && (
        <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          background: theme.color.panelHi, border: `1px solid ${theme.color.panelBorderHi}`, borderRadius: 10,
          padding: '10px 18px', fontFamily: theme.font.mono, fontSize: 12, color: theme.color.text, zIndex: 40 }}>
          {toast}
        </div>
      )}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontFamily: theme.font.mono, fontSize: 13, color: theme.color.textDim }}>{children}</div>;
}

function Btn({ label, primary, onClick }: { label: string; primary?: boolean; onClick: () => void }) {
  const c = primary ? theme.color.cyan : theme.color.textDim;
  return (
    <button onClick={onClick} style={{
      fontFamily: theme.font.mono, fontSize: 11, letterSpacing: 0.3, cursor: 'pointer',
      padding: '6px 10px', borderRadius: 7, border: `1px solid ${primary ? theme.color.cyan : theme.color.panelBorder}`,
      background: primary ? hexA(theme.color.cyan, 0.14) : theme.color.inset, color: c,
    }}>{label}</button>
  );
}

function KegCard({ keg, busy, onAction }: { keg: Keg; busy: boolean; onAction: (id: string, action: string, params?: Record<string, unknown>) => void }) {
  const sc = statusColor[keg.status] ?? theme.color.textDim;
  const h = keg.health;
  const warnColor = h.severity === 'critical' ? theme.color.red : h.severity === 'warning' ? theme.color.amber : undefined;

  return (
    <div style={{
      background: theme.color.panel, backdropFilter: `blur(${theme.blur})`, borderRadius: theme.radius.lg,
      border: `1px solid ${warnColor ? hexA(warnColor, 0.5) : theme.color.panelBorder}`,
      boxShadow: warnColor ? theme.glow(warnColor, 0.25) : 'none',
      padding: 12, opacity: busy ? 0.6 : 1, transition: 'opacity .15s',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <b style={{ fontFamily: theme.font.sans, fontSize: 14, color: theme.color.text }}>{keg.label}</b>
        <span style={{ fontFamily: theme.font.mono, fontSize: 10, color: theme.color.textFaint }}>{keg.id}</span>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '6px 0' }}>
        <span style={{ fontFamily: theme.font.mono, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase',
          padding: '2px 8px', borderRadius: 10, color: sc, background: hexA(sc, 0.15), border: `1px solid ${hexA(sc, 0.4)}` }}>{keg.status}</span>
        {keg.tap && <span style={{ fontFamily: theme.font.mono, fontSize: 10, color: theme.color.textDim }}>Tap {keg.tap}</span>}
      </div>
      {keg.beer_batch && (
        <div style={{ fontFamily: theme.font.sans, fontSize: 12, color: theme.color.textLabel, marginBottom: 6 }}>
          🍺 {keg.beer_batch}{keg.beer_style ? ` · ${keg.beer_style}` : ''}{keg.beer_abv ? ` · ${keg.beer_abv}%` : ''}
        </div>
      )}
      <div style={{ fontFamily: theme.font.mono, fontSize: 10, color: theme.color.textDim, marginBottom: 8 }}>
        cleaned {h.cleanAgeDays == null ? 'never' : `${h.cleanAgeDays}d ago`}{h.cleanExpired ? ' ⚠' : ''}
        {' · '}seals {(['lid', 'post', 'dip'] as const).map((t) => {
          const s = h.seals[t]; const c = s.due ? theme.color.red : s.soon ? theme.color.amber : theme.color.textFaint;
          return <span key={t} style={{ color: c }}> {t[0]}{s.ageDays ?? '–'}</span>;
        })}
      </div>
      {h.warnings.length > 0 && (
        <div style={{ fontSize: 10.5, color: warnColor, marginBottom: 8 }}>{h.warnings.map((w) => w.msg).join(' · ')}</div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {keg.status === 'dirty' && <Btn primary label="✓ Cleaned" onClick={() => onAction(keg.id, 'clean', { cleanType: 'caustic' })} />}
        {keg.status === 'clean' && <Btn primary label="🛢 Fill" onClick={() => {
          const name = prompt('Beer name?'); if (name == null) return;
          onAction(keg.id, 'filled', { beer: { name } });
        }} />}
        {keg.status === 'filled' && <Btn primary label="🍺 Tap" onClick={() => {
          const t = prompt('Tap number (1-8)?'); if (!t) return;
          onAction(keg.id, 'tap', { tap: Number(t) });
        }} />}
        {keg.status === 'tapped' && <Btn primary label="💧 Empty" onClick={() => onAction(keg.id, 'empty')} />}
        {keg.status === 'empty' && <Btn label="↩ To dirty" onClick={() => onAction(keg.id, 'dirty')} />}
        {(['lid', 'post', 'dip'] as const).map((t) => h.seals[t].due || h.seals[t].soon ? (
          <Btn key={t} label={`${t} o-ring`} onClick={() => onAction(keg.id, 'seal', { sealType: t })} />
        ) : null)}
        <a href={`${KEGS_URL}/kegs/${keg.id}`} target="_blank" rel="noreferrer"
          style={{ fontFamily: theme.font.mono, fontSize: 11, color: theme.color.cyan, textDecoration: 'none', alignSelf: 'center', marginLeft: 'auto' }}>
          open ↗
        </a>
      </div>
    </div>
  );
}

function TapCard({ tap, busy, onClean, kegs }: { tap: TapLine; busy: boolean; onClean: (tap: number, action: string) => void; kegs: Keg[] }) {
  const h = tap.health;
  const c = h.due ? theme.color.red : h.soon ? theme.color.amber : theme.color.green;
  const kegOnTap = kegs.find((k) => k.id === tap.current_keg);
  return (
    <div style={{
      background: theme.color.panel, borderRadius: theme.radius.md,
      border: `1px solid ${h.due ? hexA(theme.color.red, 0.5) : theme.color.panelBorder}`,
      padding: 10, opacity: busy ? 0.6 : 1,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <b style={{ fontFamily: theme.font.sans, fontSize: 13, color: theme.color.text }}>{tap.label}</b>
        <span style={{ fontFamily: theme.font.mono, fontSize: 10, color: c }}>
          {h.cleanAgeDays == null ? 'never cleaned' : `${h.cleanAgeDays}d`}{h.due ? ' — DUE' : h.soon ? ' — soon' : ''}
        </span>
      </div>
      <div style={{ fontFamily: theme.font.mono, fontSize: 11, color: theme.color.textDim, margin: '4px 0 8px' }}>
        {kegOnTap ? `🍺 ${kegOnTap.beer_batch || kegOnTap.label}` : '— empty —'}
      </div>
      <Btn label="✓ Line cleaned" primary={h.due} onClick={() => onClean(tap.tap, 'cleanLine')} />
    </div>
  );
}
