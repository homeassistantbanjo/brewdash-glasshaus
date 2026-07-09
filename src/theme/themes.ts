/**
 * GlassHaus THEMES — swappable visual identities.
 *
 * Every theme provides the SAME token shape (the `color` block + a few HUD flags),
 * so components keep writing `theme.color.cyan` verbatim and just get different
 * values when the active theme changes (see tokens.ts). Add a theme here and it
 * shows up in the switcher automatically — no component changes needed.
 *
 * Themes:
 *   command   — the original glass "command center" (dark, restrained). Fallback.
 *   hud       — Iron Man / JARVIS cyan holographic HUD (flagship, default).
 *   cyberpunk — neon magenta+cyan, heavy bloom, Blade Runner brewery.
 *   lcars     — Star Trek console (amber/lilac pills on black).
 */

export interface ThemeColors {
  bgBase: string;
  bgGrid: string;
  panel: string;
  panelHi: string;
  panelBorder: string;
  panelBorderHi: string;
  inset: string;
  text: string;
  textDim: string;
  textFaint: string;
  textLabel: string;
  amber: string;
  cyan: string;
  blue: string;
  green: string;
  red: string;
  purple: string;
  yellow: string;
}

export interface ThemeFx {
  /** multiplier on glow strength (1 = current, >1 = more bloom) */
  glowScale: number;
  /** draw corner brackets ⌜⌝⌞⌟ on framed panels instead of full borders */
  brackets: boolean;
  /** slow scan-line sweep over cards */
  scanlines: boolean;
  /** animated background grid / particle drift */
  animatedGrid: boolean;
  /** panel corner radius family: 'sharp' | 'soft' | 'pill' */
  radius: 'sharp' | 'soft' | 'pill';
  /** show the progress ring around the fermenter vessel */
  vesselRing: boolean;
}

export interface ThemeDef {
  name: string;
  label: string;
  color: ThemeColors;
  fx: ThemeFx;
}

// ── command: the original look, preserved ────────────────────────────────────
const command: ThemeDef = {
  name: 'command',
  label: 'Command',
  color: {
    bgBase: '#070809', bgGrid: 'rgba(255,255,255,0.015)',
    panel: 'rgba(16, 19, 24, 0.72)', panelHi: 'rgba(24, 28, 35, 0.85)',
    panelBorder: 'rgba(255,255,255,0.07)', panelBorderHi: 'rgba(255,255,255,0.12)',
    inset: 'rgba(0,0,0,0.35)',
    text: '#e9edf2', textDim: '#7d8894', textFaint: '#4a535d', textLabel: '#9aa5b1',
    amber: '#f4a259', cyan: '#4fd1e8', blue: '#5b8dee', green: '#5ed89a',
    red: '#f0616d', purple: '#b58dee', yellow: '#e8c84f',
  },
  fx: { glowScale: 1, brackets: false, scanlines: false, animatedGrid: false, radius: 'soft', vesselRing: false },
};

// ── hud: Iron Man / JARVIS — cyan-dominant holographic instrument panel ───────
const hud: ThemeDef = {
  name: 'hud',
  label: 'HUD',
  color: {
    bgBase: '#03080c',
    bgGrid: 'rgba(79,209,232,0.045)',                 // faint cyan grid
    panel: 'rgba(6, 20, 28, 0.55)',                   // cool, transparent glass
    panelHi: 'rgba(10, 26, 36, 0.70)',
    panelBorder: 'rgba(79,209,232,0.22)',             // cyan-tinted edges
    panelBorderHi: 'rgba(79,209,232,0.45)',
    inset: 'rgba(0, 12, 18, 0.5)',
    text: '#dff6fb', textDim: '#6fa9b8', textFaint: '#3a6470', textLabel: '#8fc7d6',
    amber: '#ffb347', cyan: '#38e6ff',                // brighter, more saturated cyan
    blue: '#4fa8ff', green: '#4fe6b0', red: '#ff5a6e',
    purple: '#b98bff', yellow: '#ffe14f',
  },
  fx: { glowScale: 2.2, brackets: true, scanlines: true, animatedGrid: true, radius: 'sharp', vesselRing: true },
};

// ── cyberpunk: neon magenta + cyan, heavy bloom ───────────────────────────────
const cyberpunk: ThemeDef = {
  name: 'cyberpunk',
  label: 'Cyberpunk',
  color: {
    bgBase: '#0c0316',
    bgGrid: 'rgba(255,45,149,0.08)',
    panel: 'rgba(26, 6, 40, 0.62)',
    panelHi: 'rgba(36, 8, 54, 0.78)',
    panelBorder: 'rgba(255,45,149,0.45)',            // hot magenta edges
    panelBorderHi: 'rgba(56,230,255,0.7)',           // electric cyan hi
    inset: 'rgba(8, 0, 16, 0.6)',
    text: '#ffe6ff', textDim: '#c48fd8', textFaint: '#6a4488', textLabel: '#ff9fe8',
    amber: '#ffb347', cyan: '#1ef0ff',               // hotter neon cyan
    blue: '#5b8dff', green: '#2effc0', red: '#ff1f5e',
    purple: '#ff3df0', yellow: '#ffe14f',            // hot magenta primary
  },
  fx: { glowScale: 3.0, brackets: true, scanlines: true, animatedGrid: true, radius: 'sharp', vesselRing: true },
};

// ── lcars: Star Trek console — amber/lilac pills on black ──────────────────────
const lcars: ThemeDef = {
  name: 'lcars',
  label: 'LCARS',
  color: {
    bgBase: '#000000',
    bgGrid: 'rgba(255,153,0,0.03)',
    panel: 'rgba(20, 16, 8, 0.5)',
    panelHi: 'rgba(28, 22, 10, 0.7)',
    panelBorder: 'rgba(255,153,0,0.35)',
    panelBorderHi: 'rgba(255,153,0,0.6)',
    inset: 'rgba(0,0,0,0.5)',
    text: '#ffd9a0', textDim: '#c99b6a', textFaint: '#7a5a34', textLabel: '#ffcc99',
    amber: '#ff9900',                                 // LCARS signature orange
    cyan: '#99ccff', blue: '#7788ff', green: '#66cc99',
    red: '#cc6666', purple: '#cc99cc', yellow: '#ffcc66',
  },
  fx: { glowScale: 0.8, brackets: false, scanlines: false, animatedGrid: false, radius: 'pill', vesselRing: true },
};

export const THEMES: Record<string, ThemeDef> = { hud, cyberpunk, lcars, command };
export const THEME_ORDER = ['hud', 'cyberpunk', 'lcars', 'command'];
export const DEFAULT_THEME = 'hud';
