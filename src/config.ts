/**
 * Runtime HA config resolution.
 *
 * Two modes:
 *  - LOCAL DEV (`npm run dev`): reads from Vite's `import.meta.env` (.env.local),
 *    so the existing dev workflow is unchanged.
 *  - PREBUILT CONTAINER (ghcr image on Unraid): the image is built token-FREE by
 *    CI. At container startup the entrypoint writes `/public/config.js` from env
 *    vars, which sets `window.__GLASSHAUS_CONFIG__`. This lets ONE public-safe
 *    image serve any brewery — the HA token only ever lives on the host, never
 *    baked into the JS bundle or the registry image.
 *
 * Precedence: runtime window config (container) → build-time env (dev) → default.
 */
interface GlassHausConfig {
  haUrl?: string;
  haToken?: string;
  analyzerUrl?: string;
  brewfatherUrl?: string;
}

declare global {
  interface Window {
    __GLASSHAUS_CONFIG__?: GlassHausConfig;
  }
}

const runtime = (typeof window !== 'undefined' && window.__GLASSHAUS_CONFIG__) || {};

export const HA_URL =
  runtime.haUrl || import.meta.env.VITE_HA_URL || 'http://192.168.50.127:8123';

export const HA_TOKEN =
  runtime.haToken || import.meta.env.VITE_HA_TOKEN || '';

// The analyzer container's HTTP API (full-plant Insights view). Same host as the
// dashboard is served from, port 8091, unless overridden at runtime/build time.
export const ANALYZER_URL =
  runtime.analyzerUrl || import.meta.env.VITE_ANALYZER_URL || 'http://192.168.50.118:8091';

// The Brewfather write service container (brew-day measurement write-back), :8093.
export const BREWFATHER_URL =
  runtime.brewfatherUrl || import.meta.env.VITE_BREWFATHER_URL || 'http://192.168.50.118:8093';
