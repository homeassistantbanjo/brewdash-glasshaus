import { CSSProperties, ReactNode } from 'react';
import { theme, hexA } from '../theme/tokens';

interface Props {
  children: ReactNode;
  accent?: string;      // left-edge accent stripe color
  onClick?: () => void;
  style?: CSSProperties;
  padded?: boolean;
}

/** The frosted-glass surface every widget sits on. */
export function GlassPanel({ children, accent, onClick, style, padded = true }: Props) {
  return (
    <div
      onClick={onClick}
      style={{
        background: theme.color.panelHi,
        backdropFilter: `blur(${theme.blur})`,
        WebkitBackdropFilter: `blur(${theme.blur})`,
        border: `1px solid ${theme.color.panelBorderHi}`,
        borderLeft: accent ? `3px solid ${accent}` : undefined,
        borderRadius: theme.radius.md,
        boxShadow: `0 8px 40px rgba(0,0,0,0.5), inset 0 1px 0 ${hexA('#ffffff', 0.04)}`,
        padding: padded ? '16px 18px' : 0,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'transform 0.15s ease, background 0.2s ease',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (onClick) e.currentTarget.style.transform = 'translateY(-2px)';
      }}
      onMouseLeave={(e) => {
        if (onClick) e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      {children}
    </div>
  );
}
