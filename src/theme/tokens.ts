/**
 * GlassHaus design tokens — COMMAND CENTER aesthetic.
 * Dark telemetry, tight grid, tabular figures, glow = live state.
 * Glass reads because it sits over a layered depth background.
 */

export const theme = {
  color: {
    // layered surfaces — background has actual depth so blur refracts
    bgBase: '#070809',
    bgGrid: 'rgba(255,255,255,0.015)',   // faint grid lines
    panel: 'rgba(16, 19, 24, 0.72)',
    panelHi: 'rgba(24, 28, 35, 0.85)',
    panelBorder: 'rgba(255,255,255,0.07)',
    panelBorderHi: 'rgba(255,255,255,0.12)',
    inset: 'rgba(0,0,0,0.35)',           // recessed metric wells

    // text — telemetry hierarchy
    text: '#e9edf2',
    textDim: '#7d8894',
    textFaint: '#4a535d',
    textLabel: '#9aa5b1',

    // state palette — these GLOW when active
    amber: '#f4a259',
    cyan: '#4fd1e8',      // primary accent — cold, technical
    blue: '#5b8dee',
    green: '#5ed89a',
    red: '#f0616d',
    purple: '#b58dee',
    yellow: '#e8c84f',
  },
  // glows keyed to state colors, for box-shadow on active elements
  glow: (c: string, strength = 0.5) => `0 0 20px ${hexA(c, strength * 0.4)}, 0 0 4px ${hexA(c, strength)}`,
  radius: { sm: '8px', md: '12px', lg: '16px' },
  blur: '16px',
  font: {
    // tabular figures for all numbers — telemetry must align
    mono: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
    sans: "'Inter', system-ui, sans-serif",
  },
  space: (n: number) => `${n * 4}px`,
} as const;

/** hex + alpha → rgba string */
function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
export { hexA };

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
