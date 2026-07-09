/**
 * A CHAMFERED HUD panel — the structural chrome that makes the UI read as a
 * console instead of a stack of rounded rectangles. Cut corners, a hairline
 * glowing border, and an optional labeled header bar with an ID tag + status.
 *
 * Border technique: the notched outline is drawn as a background LAYER on the
 * outer element (clipped to the chamfer) with the inner content inset 1px and
 * clipped to a slightly smaller chamfer — so the accent color shows through as a
 * crisp 1px rim on every edge including the cut corners. No fragile SVG scaling.
 *
 * Theme-gated: on themes with fx.brackets off (command/lcars) it degrades to a
 * plain rounded panel so those skins stay clean.
 */
import { CSSProperties, ReactNode } from 'react';
import { theme, hexA, fx } from '../../theme/tokens';

/** clip-path polygon with `cut` px chamfers on all four corners */
function chamfer(cut: number): string {
  return `polygon(${cut}px 0, calc(100% - ${cut}px) 0, 100% ${cut}px, 100% calc(100% - ${cut}px), calc(100% - ${cut}px) 100%, ${cut}px 100%, 0 calc(100% - ${cut}px), 0 ${cut}px)`;
}

export function Panel({
  children, accent, header, id, status, statusColor, cut = 12, style, glow = true,
}: {
  children: ReactNode;
  accent?: string;
  header?: string;
  id?: string;
  status?: string;
  statusColor?: string;
  cut?: number;
  style?: CSSProperties;
  glow?: boolean;
}) {
  const chamfered = fx().brackets;
  const c = accent ?? theme.color.panelBorderHi;

  // Non-chamfered themes: plain rounded panel, done.
  if (!chamfered) {
    return (
      <div style={{
        position: 'relative', background: theme.color.panelHi,
        backdropFilter: `blur(${theme.blur})`, WebkitBackdropFilter: `blur(${theme.blur})`,
        borderRadius: theme.radius.lg, border: `1px solid ${hexA(c, 0.4)}`,
        boxShadow: glow ? theme.glow(c, 0.3) : 'none',
        display: 'flex', flexDirection: 'column', ...style,
      }}>
        <PanelInner c={c} glow={glow} header={header} id={id} status={status} statusColor={statusColor}>
          {children}
        </PanelInner>
      </div>
    );
  }

  // Chamfered: outer = the glowing rim (accent), inner = the fill inset by 1px.
  return (
    <div style={{
      position: 'relative',
      clipPath: chamfer(cut),
      background: hexA(c, 0.55),                          // the 1px rim color
      padding: 1,
      boxShadow: glow ? theme.glow(c, 0.35) : 'none',
      filter: glow ? `drop-shadow(0 0 6px ${hexA(c, 0.35)})` : undefined,
      display: 'flex', flexDirection: 'column', ...style,
    }}>
      <div style={{
        clipPath: chamfer(cut - 1),
        background: theme.color.panelHi,
        backdropFilter: `blur(${theme.blur})`, WebkitBackdropFilter: `blur(${theme.blur})`,
        display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
      }}>
        <PanelInner c={c} glow={glow} header={header} id={id} status={status} statusColor={statusColor}>
          {children}
        </PanelInner>
      </div>
    </div>
  );
}

function PanelInner({ children, c, glow, header, id, status, statusColor }: {
  children: ReactNode; c: string; glow: boolean;
  header?: string; id?: string; status?: string; statusColor?: string;
}) {
  return (
    <>
      {header && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 14px 7px 14px',
          borderBottom: `1px solid ${hexA(c, 0.28)}`,
          background: `linear-gradient(90deg, ${hexA(c, 0.16)}, transparent 72%)`,
        }}>
          <span style={{ color: c, fontSize: 11, lineHeight: 1, filter: `drop-shadow(0 0 4px ${hexA(c, 0.7)})` }}>◤</span>
          <span style={{
            fontFamily: theme.font.mono, fontSize: 13, fontWeight: 700, letterSpacing: 1.5,
            color: theme.color.text, textShadow: glow ? `0 0 8px ${hexA(c, 0.5)}` : undefined,
          }}>{header}</span>
          {status && (
            <span style={{
              fontFamily: theme.font.mono, fontSize: 9.5, letterSpacing: 1.5, fontWeight: 700,
              textTransform: 'uppercase', color: statusColor ?? c,
              textShadow: `0 0 6px ${hexA(statusColor ?? c, 0.6)}`,
            }}>// {status}</span>
          )}
          <span style={{ flex: 1 }} />
          {id && (
            <span style={{ fontFamily: theme.font.mono, fontSize: 9.5, letterSpacing: 1, color: theme.color.textFaint }}>{id}</span>
          )}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {children}
      </div>
    </>
  );
}
