// Runtime config stub. In LOCAL DEV this stays empty and the app falls back to
// .env.local (Vite build-time env). In the PREBUILT CONTAINER, the entrypoint
// OVERWRITES this file at startup from env vars, e.g.:
//   window.__GLASSHAUS_CONFIG__ = { haUrl: "...", haToken: "..." };
// Never commit real values here — this stub is intentionally empty.
window.__GLASSHAUS_CONFIG__ = window.__GLASSHAUS_CONFIG__ || {};
