import { useEffect } from 'react';
import { HassConnect } from '@hakit/core';
import { Overview } from './components/Overview';
import { ToastProvider } from './components/Toasts';
import { theme, hexA, useThemeName, applyBodyBg, fx } from './theme/tokens';
import { HA_URL, HA_TOKEN } from './config';

export default function App() {
  // re-render on theme switch; keep the <body> background in sync so the blurred
  // glass panels always have the right depth behind them.
  useThemeName();
  useEffect(() => { applyBodyBg(); }, []);
  const animated = fx().animatedGrid;

  return (
    <div style={{
      minHeight: '100vh', position: 'relative',
      background: theme.color.bgBase,
      color: theme.color.text,
      fontFamily: theme.font.sans,
      overflow: 'hidden',
    }}>
      {/* ambient depth glows (fixed) */}
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
        backgroundImage: `
          radial-gradient(1000px 560px at 80% -10%, ${hexA(theme.color.cyan, 0.10)}, transparent 60%),
          radial-gradient(760px 440px at 8% 112%, ${hexA(theme.color.purple, 0.07)}, transparent 60%)`,
      }} />
      {/* the grid — slowly drifts on animated themes, static otherwise */}
      <div style={{
        position: 'fixed', inset: '-64px', pointerEvents: 'none', zIndex: 0,
        backgroundImage: `
          linear-gradient(${theme.color.bgGrid} 1px, transparent 1px),
          linear-gradient(90deg, ${theme.color.bgGrid} 1px, transparent 1px)`,
        backgroundSize: '38px 38px, 38px 38px',
        animation: animated ? 'ghgrid 24s linear infinite' : 'none',
      }} />
      <style>{`@keyframes ghgrid { from { transform: translate(0,0); } to { transform: translate(38px,38px); } }`}</style>

      <div style={{ position: 'relative', zIndex: 1 }}>
        <HassConnect hassUrl={HA_URL} hassToken={HA_TOKEN}>
          <ToastProvider>
            <Overview />
          </ToastProvider>
        </HassConnect>
      </div>
    </div>
  );
}
