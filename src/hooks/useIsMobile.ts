import { useSyncExternalStore } from 'react';

/**
 * Reactive "is this a phone-sized viewport?" hook.
 *
 * The tablet/desktop GlassHaus (Overview) is a fixed single-screen kiosk layout
 * tuned for the bar-top display; it is NOT responsive on purpose. Rather than
 * bolt breakpoints onto it, we branch at the App root: a phone gets a dedicated
 * MobileView, everything else keeps the untouched Overview. This hook is that
 * switch — matchMedia so it reacts live to rotation / window resize.
 *
 * Breakpoint: 900px OR a coarse (touch) pointer on a not-wide screen. The width
 * test alone missed some Android phones (Chrome can report a larger CSS width on
 * high-DPI / desktop-site setups), leaving them on the crushed kiosk grid. Adding
 * `(pointer: coarse) and (max-width: 1180px)` catches any touch device that isn't a
 * genuinely large tablet — so a phone always gets the mobile layout regardless of
 * its reported width, while the ≥1180px bar-top touchscreen keeps the kiosk view.
 * (Either condition matching → mobile.)
 */
const MOBILE_QUERY = '(max-width: 900px), (pointer: coarse) and (max-width: 1180px)';

function subscribe(cb: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia(MOBILE_QUERY);
  // addEventListener('change') is the modern API; addListener is the Safari<14 fallback.
  if (mql.addEventListener) { mql.addEventListener('change', cb); return () => mql.removeEventListener('change', cb); }
  mql.addListener(cb); return () => mql.removeListener(cb);
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

export function useIsMobile(): boolean {
  // server snapshot = false (SSR-safe; this app is client-rendered anyway)
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
