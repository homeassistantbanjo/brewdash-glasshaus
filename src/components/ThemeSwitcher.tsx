/**
 * Theme picker in the header. Cycles/selects among the registered THEMES; the
 * choice persists to localStorage (see tokens.ts). Tiny footprint — a labeled
 * segmented control so a glance shows which skin is active.
 */
import { theme, hexA, setTheme, useThemeName } from '../theme/tokens';
import { THEME_ORDER, THEMES } from '../theme/themes';

export function ThemeSwitcher() {
  const active = useThemeName();
  return (
    <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}
      title="Display theme">
      {THEME_ORDER.map((name) => {
        const t = THEMES[name];
        const on = name === active;
        return (
          <button key={name} onClick={() => setTheme(name)} style={{
            fontFamily: theme.font.mono, fontSize: 9, letterSpacing: 1,
            textTransform: 'uppercase', padding: '3px 8px', borderRadius: 5,
            cursor: 'pointer', transition: 'all 0.12s',
            border: `1px solid ${on ? t.color.cyan : theme.color.panelBorder}`,
            background: on ? hexA(t.color.cyan, 0.15) : 'transparent',
            color: on ? t.color.cyan : theme.color.textDim,
          }}>{t.label}</button>
        );
      })}
    </div>
  );
}
