import { useEffect } from 'react';
import { HassConnect } from '@hakit/core';
import { Overview } from './components/Overview';
import { ToastProvider } from './components/Toasts';
import { theme, hexA, useThemeName, applyBodyBg } from './theme/tokens';
import { HA_URL, HA_TOKEN } from './config';

export default function App() {
  // re-render on theme switch; keep the <body> background in sync so the blurred
  // glass panels always have the right depth behind them.
  useThemeName();
  useEffect(() => { applyBodyBg(); }, []);

  return (
    <div style={{
      minHeight: '100vh',
      background: theme.color.bgBase,
      backgroundImage: `
        radial-gradient(900px 500px at 80% -10%, ${hexA(theme.color.cyan, 0.08)}, transparent 60%),
        radial-gradient(700px 400px at 10% 110%, ${hexA(theme.color.amber, 0.05)}, transparent 60%),
        linear-gradient(${theme.color.bgGrid} 1px, transparent 1px),
        linear-gradient(90deg, ${theme.color.bgGrid} 1px, transparent 1px)
      `,
      backgroundSize: '100% 100%, 100% 100%, 32px 32px, 32px 32px',
      color: theme.color.text,
      fontFamily: theme.font.sans,
    }}>
      <HassConnect hassUrl={HA_URL} hassToken={HA_TOKEN}>
        <ToastProvider>
          <Overview />
        </ToastProvider>
      </HassConnect>
    </div>
  );
}
