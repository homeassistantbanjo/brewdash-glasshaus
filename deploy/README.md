# GlassHaus — Unraid kiosk deployment

Serves the GlassHaus dashboard for the wall/staging tablet. GitHub Actions builds
a **token-free** image on every push to `main` and publishes it to the GitHub
Container Registry; Unraid **pulls the prebuilt image**. The HA URL/token are
injected at container startup from env vars (written into `config.js`), so no
secret ever lives in git or the registry image.

Image: `ghcr.io/homeassistantbanjo/brewdash-glasshaus:latest`

**Architecture:** GlassHaus is a static SPA — the tablet's *browser* talks
directly to Home Assistant's WebSocket using the token from `config.js`. The
container only serves files. Because the token reaches the browser, keep
everything on **Tailscale / LAN only** — never expose to the internet.

## One-time: make the ghcr image pullable

1. In GitHub, the image is published under the repo's Packages. If the package is
   **private** (default), Unraid needs a token to pull it: create a
   **fine-grained PAT** (or classic token) with `read:packages`, or make the
   package public (Repo → Packages → package → Package settings → change visibility).
   Simplest for a home setup: **make the package public** — the image is
   token-free, so nothing sensitive is exposed by a public *image*.

## Add the container on Unraid (Docker tab → Add Container)

- **Name:** `glasshaus`
- **Repository:** `ghcr.io/homeassistantbanjo/brewdash-glasshaus:latest`
- **Network:** Bridge
- **Port:** add a port mapping — Container `80` → Host `8099`
- **Env variables** (Add another Path/Port/Variable → Variable):
  - `VITE_HA_URL` = `http://192.168.50.127:8123`
  - `VITE_HA_TOKEN` = `<your long-lived HA token>`
- (If the ghcr package stayed private) under **Registry authentication**, or via
  `docker login ghcr.io` on Unraid first, provide a `read:packages` token.
- Apply. First pull + start takes a moment; then browse `http://<unraid-ip>:8099/`.

## Point the tablet at it (Fully Kiosk Browser recommended)

- Start URL: `http://<unraid-tailscale-name-or-ip>:8099/`
- Enable: keep screen on, launch on boot, auto-reload on connection loss
- Tablet must be on the tailnet / same LAN.

## Auto-update

Push to `main` → GitHub Actions rebuilds + republishes `:latest`. To pull the new
image on Unraid: click **Force update** on the container (or install the
**CA Auto Update Applications** plugin to auto-pull `:latest` on a schedule).

## Notes
- Anton webfont (banner) loads from Google Fonts → tablet needs internet at page
  load (falls back to JetBrains Mono offline). Self-host the font for full offline.
- Consider a dedicated, scoped HA user/token for GlassHaus to limit blast radius.
- `deploy/docker-compose.yml` is provided too, if you use the Compose Manager plugin.
