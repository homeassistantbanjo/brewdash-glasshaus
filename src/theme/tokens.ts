/**
 * GlassHaus design tokens — now THEME-DRIVEN.
 *
 * The exported `theme` keeps its exact original shape (`theme.color.cyan`,
 * `theme.font.mono`, `theme.radius.sm`, `theme.glow(...)`, `theme.blur`,
 * `theme.space(n)`) so every component keeps working unchanged — but the VALUES
 * come from the active theme (see themes.ts) and swap at runtime via setTheme().
 *
 * Dark telemetry, tight grid, tabular figures, glow = live state. Glass reads
 * because it sits over a layered depth background.
 */
import { THEMES, DEFAULT_THEME, ThemeColors, ThemeFx } from './themes';
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'glasshaus.theme';

function initialName(): string {
  try {
    const saved = typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY);
    if (saved && THEMES[saved]) return saved;
  } catch { /* ignore */ }
  return DEFAULT_THEME;
}

let activeName = initialName();

// ── pub/sub so React re-renders and the <body> restyles on a theme switch ─────
const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }

const RADIUS_MAP = {
  sharp: { sm: '3px', md: '4px', lg: '6px' },
  soft: { sm: '8px', md: '12px', lg: '16px' },
  pill: { sm: '10px', md: '18px', lg: '28px' },
} as const;

/** hex + alpha → rgba string (also accepts already-rgba, returned as-is) */
export function hexA(hex: string, a: number): string {
  if (!hex.startsWith('#')) return hex;
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * The live theme object. `color` / `radius` / `glow` are GETTERS that read the
 * active theme, so a setTheme() call instantly changes every consumer's values.
 */
export const theme = {
  get color(): ThemeColors { return THEMES[activeName].color; },
  get radius() { return RADIUS_MAP[THEMES[activeName].fx.radius]; },
  glow(c: string, strength = 0.5) {
    const s = strength * THEMES[activeName].fx.glowScale;
    return `0 0 20px ${hexA(c, s * 0.4)}, 0 0 4px ${hexA(c, Math.min(s, 1))}`;
  },
  blur: '16px',
  font: {
    mono: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
    sans: "'Inter', system-ui, sans-serif",
  },
  space: (n: number) => `${n * 4}px`,
};

/** The active theme's FX flags (brackets / scanlines / vesselRing / etc.). */
export function fx(): ThemeFx { return THEMES[activeName].fx; }

/** Text-shadow bloom for glowing HUD numerals, scaled by the theme's glow. */
export function textGlow(c: string, strength = 1): string {
  const s = strength * THEMES[activeName].fx.glowScale;
  return `0 0 ${8 * s}px ${hexA(c, Math.min(0.5 * s, 0.9))}, 0 0 ${2 * s}px ${hexA(c, Math.min(0.8 * s, 1))}`;
}

export function getThemeName(): string { return activeName; }

export function setTheme(name: string): void {
  if (!THEMES[name] || name === activeName) return;
  activeName = name;
  try { localStorage.setItem(STORAGE_KEY, name); } catch { /* ignore */ }
  applyBodyBg();
  emit();
}

/** Paint the document background to match the theme (blur needs depth behind it). */
export function applyBodyBg(): void {
  if (typeof document === 'undefined') return;
  const c = THEMES[activeName].color;
  document.body.style.background = c.bgBase;
}

/** React hook: subscribe to theme changes so components re-render on switch. */
export function useThemeName(): string {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => activeName,
    () => activeName,
  );
}

// ── state-color helpers (unchanged API; read live theme) ──────────────────────
export type StateKind = 'ok' | 'active' | 'warn' | 'bad' | 'idle' | 'cool';

export function stateColor(s: StateKind): string {
  switch (s) {
    case 'ok': return theme.color.green;
    case 'active': return theme.color.blue;
    case 'cool': return theme.color.cyan;
    case 'warn': return theme.color.amber;
    case 'bad': return theme.color.red;
    case 'idle': return theme.color.textDim;
  }
}

export function stalenessStyle(s: 'live' | 'stale' | 'dead' | 'unknown') {
  switch (s) {
    case 'live': return { opacity: 1, flag: null as string | null };
    case 'stale': return { opacity: 0.55, flag: 'STALE' };
    case 'dead': return { opacity: 0.3, flag: 'OFFLINE' };
    case 'unknown': return { opacity: 0.3, flag: '—' };
  }
}
