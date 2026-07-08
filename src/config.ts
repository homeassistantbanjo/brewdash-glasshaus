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
