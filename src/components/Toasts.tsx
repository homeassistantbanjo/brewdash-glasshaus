import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { theme, hexA, stateColor } from '../theme/tokens';

/**
 * Minimal toast system. Exists because every HA write used to be fire-and-forget
 * with failures swallowed into console.error — so "I clicked and nothing happened"
 * was indistinguishable from success. Now a write reports here: a red toast on
 * failure, a brief green confirm on success. No dependency, ~one file.
 */

type ToastKind = 'ok' | 'error';
interface Toast { id: number; kind: ToastKind; msg: string; }

interface ToastApi {
  ok: (msg: string) => void;
  error: (msg: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

/** Access the toast API. Safe no-op if used outside the provider. */
export function useToast(): ToastApi {
  return useContext(ToastCtx) ?? { ok: () => {}, error: () => {} };
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback((kind: ToastKind, msg: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, kind, msg }]);
    // errors linger longer than confirmations
    const ttl = kind === 'error' ? 6000 : 2500;
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl);
  }, []);

  const api: ToastApi = {
    ok: (msg) => push('ok', msg),
    error: (msg) => push('error', msg),
  };

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div style={{
        position: 'fixed', right: 16, bottom: 16, zIndex: 100,
        display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end',
        pointerEvents: 'none',
      }}>
        {toasts.map((t) => {
          const color = t.kind === 'error' ? stateColor('bad') : stateColor('ok');
          return (
            <div key={t.id} style={{
              fontFamily: theme.font.mono, fontSize: 12.5,
              maxWidth: 380,
              padding: '10px 14px', borderRadius: theme.radius.md,
              background: theme.color.panelHi,
              backdropFilter: `blur(${theme.blur})`,
              WebkitBackdropFilter: `blur(${theme.blur})`,
              border: `1px solid ${hexA(color, 0.5)}`,
              boxShadow: theme.glow(color, 0.35),
              color: theme.color.text,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ color, fontSize: 14 }}>{t.kind === 'error' ? '✕' : '✓'}</span>
              <span>{t.msg}</span>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
