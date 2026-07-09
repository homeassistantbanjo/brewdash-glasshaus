/**
 * HUD chrome — theme-gated decorative layers that turn a plain panel into a
 * sci-fi instrument. All of it no-ops (renders nothing) on themes whose fx flags
 * are off (e.g. `command`), so the same component tree serves every theme.
 *
 *  <CornerBrackets/> — ⌜⌝⌞⌟ targeting-reticle corners (fx.brackets)
 *  <ScanLine/>       — a slow vertical sweep of light over the parent (fx.scanlines)
 * Both are absolutely-positioned overlays; the parent must be position:relative.
 */
import { theme, hexA, fx } from '../theme/tokens';

export function CornerBrackets({ color, size = 14, inset = -1 }: {
  color?: string; size?: number; inset?: number;
}) {
  if (!fx().brackets) return null;
  const c = color ?? theme.color.panelBorderHi;
  const thick = 1.5;
  const common: React.CSSProperties = { position: 'absolute', width: size, height: size, pointerEvents: 'none' };
  const glow = `drop-shadow(0 0 3px ${hexA(c, 0.7)})`;
  return (
    <>
      <span style={{ ...common, top: inset, left: inset, borderTop: `${thick}px solid ${c}`, borderLeft: `${thick}px solid ${c}`, filter: glow }} />
      <span style={{ ...common, top: inset, right: inset, borderTop: `${thick}px solid ${c}`, borderRight: `${thick}px solid ${c}`, filter: glow }} />
      <span style={{ ...common, bottom: inset, left: inset, borderBottom: `${thick}px solid ${c}`, borderLeft: `${thick}px solid ${c}`, filter: glow }} />
      <span style={{ ...common, bottom: inset, right: inset, borderBottom: `${thick}px solid ${c}`, borderRight: `${thick}px solid ${c}`, filter: glow }} />
    </>
  );
}

export function ScanLine({ color, durationSec = 8 }: { color?: string; durationSec?: number }) {
  if (!fx().scanlines) return null;
  const c = color ?? theme.color.cyan;
  return (
    <>
      <style>{`@keyframes ghscan { 0% { transform: translateY(-10%); opacity: 0; } 8% { opacity: 0.5; } 92% { opacity: 0.5; } 100% { transform: translateY(1100%); opacity: 0; } }`}</style>
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 0, height: 2, pointerEvents: 'none',
        background: `linear-gradient(90deg, transparent, ${hexA(c, 0.6)}, transparent)`,
        boxShadow: `0 0 12px ${hexA(c, 0.5)}`,
        animation: `ghscan ${durationSec}s linear infinite`,
        zIndex: 1,
      }} />
    </>
  );
}
