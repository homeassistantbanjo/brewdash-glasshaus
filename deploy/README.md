# GlassHaus — Unraid kiosk deployment

Serves the GlassHaus dashboard for the wall/staging tablet. The container clones
this repo, builds it with your HA token, serves the static `dist/`, and re-pulls
+ rebuilds every few minutes so pushes to GitHub go live automatically.

**Architecture reminder:** GlassHaus is a static SPA. The tablet's *browser* talks
directly to Home Assistant over WebSocket using the token baked into the JS at
build time. This container never proxies HA — it only serves files. Because the
token is in the bundle, keep the whole thing on your **Tailscale tailnet / LAN
only** — never expose it to the public internet.

## Prerequisites
- Unraid with Docker (Compose Manager plugin recommended)
- Tailscale on Unraid + the tablet (already configured)
- A **private** GitHub repo `homeassistantbanjo/brewdash-glasshaus` (this code)
- A GitHub **fine-grained PAT**, read-only, scoped to just this repo (for cloning)
- Your HA URL + a long-lived HA token

## Steps

1. **Copy `deploy/` to Unraid** (or clone the repo there). Put a `.env` file next
   to `docker-compose.yml` with your real values (this `.env` is NOT in git):
   ```
   GIT_REPO=https://github.com/homeassistantbanjo/brewdash-glasshaus.git
   GIT_TOKEN=github_pat_xxxxx
   VITE_HA_URL=http://192.168.50.127:8123
   VITE_HA_TOKEN=eyJ...your-long-lived-HA-token...
   POLL_SECONDS=300
   ```

2. **Start it** (Compose Manager → add stack, or CLI):
   ```
   docker compose -f deploy/docker-compose.yml up -d --build
   ```
   First run clones + `npm ci` + builds (a few minutes). Watch logs:
   `docker logs -f glasshaus`

3. **Reach it** at `http://<unraid-tailscale-name>:8099/` (or the Unraid LAN IP).
   Confirm the dashboard loads and shows live tank data.

4. **Point the tablet** (Fully Kiosk Browser recommended) at that URL:
   - Start URL = `http://<unraid-tailscale-name>:8099/`
   - Enable: keep screen on, launch on boot, auto-reload on connection loss
   - Tablet must be on the tailnet.

## Auto-build
The container polls the repo every `POLL_SECONDS`. Push to `main` → within that
window it pulls, rebuilds, and the static server serves the new files. Force an
immediate update by restarting the container.

## Notes / gotchas
- **Webfont:** the "ICONOCLAST BREWING" banner uses Anton from Google Fonts, so
  the tablet needs internet at page load (falls back to JetBrains Mono offline).
  Self-host the font if the kiosk must work fully offline.
- **HA token scope:** consider a dedicated limited HA user for GlassHaus so the
  baked-in token has minimal blast radius if the page ever leaks.
- **Battery:** on a permanently-plugged wall tablet, cap charging ~80% if the
  device supports it (or power via a scheduled smart plug) to avoid swelling.
