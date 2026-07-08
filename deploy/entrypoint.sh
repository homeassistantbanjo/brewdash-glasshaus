#!/bin/sh
# GlassHaus kiosk host — self-contained: clone/pull the private repo, build with
# the HA token env var, serve dist/, and re-pull+rebuild on a poll interval.
# Designed for an Unraid Docker container. All config via env vars (set in the
# Unraid template) so no secrets live in the image or git.
set -eu

# ---- required env (set in Unraid Docker config) --------------------------------
: "${GIT_REPO:?set GIT_REPO, e.g. https://github.com/homeassistantbanjo/brewdash-glasshaus.git}"
: "${VITE_HA_URL:?set VITE_HA_URL, e.g. http://192.168.50.127:8123}"
: "${VITE_HA_TOKEN:?set VITE_HA_TOKEN (long-lived HA token — stays only on Unraid)}"
GIT_BRANCH="${GIT_BRANCH:-main}"
POLL_SECONDS="${POLL_SECONDS:-300}"          # re-check git every 5 min by default
SERVE_PORT="${SERVE_PORT:-8080}"
APP_DIR=/app/glasshaus
DIST_DIR="$APP_DIR/dist"
# Optional: private-repo auth. Prefer a fine-grained token or deploy key.
#   GIT_TOKEN = a GitHub PAT with read access → injected into the clone URL.
GIT_TOKEN="${GIT_TOKEN:-}"

log() { echo "[glasshaus-host $(date '+%H:%M:%S')] $*"; }

# Build an authenticated clone URL if a token is supplied (https only).
repo_url() {
  if [ -n "$GIT_TOKEN" ]; then
    echo "$GIT_REPO" | sed "s#https://#https://x-access-token:${GIT_TOKEN}@#"
  else
    echo "$GIT_REPO"
  fi
}

clone_or_pull() {
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" remote set-url origin "$(repo_url)"
    git -C "$APP_DIR" fetch --quiet origin "$GIT_BRANCH"
    LOCAL=$(git -C "$APP_DIR" rev-parse HEAD)
    REMOTE=$(git -C "$APP_DIR" rev-parse "origin/$GIT_BRANCH")
    if [ "$LOCAL" = "$REMOTE" ]; then
      return 1   # no change
    fi
    log "new commit $REMOTE — pulling"
    git -C "$APP_DIR" reset --hard "origin/$GIT_BRANCH" --quiet
    return 0
  else
    log "cloning $GIT_REPO ($GIT_BRANCH)"
    git clone --branch "$GIT_BRANCH" --depth 1 "$(repo_url)" "$APP_DIR"
    return 0
  fi
}

build() {
  log "npm ci + build (this can take a few minutes on first run)"
  cd "$APP_DIR"
  npm ci --no-audit --no-fund
  # VITE_HA_URL / VITE_HA_TOKEN are read from the environment by Vite at build time
  npm run build
  log "build complete → $DIST_DIR"
}

# ---- initial clone + build -----------------------------------------------------
clone_or_pull || true
build

# ---- serve dist in the background ---------------------------------------------
# `serve` is a tiny static server; -s = SPA fallback (all routes → index.html)
log "serving on :$SERVE_PORT"
npx --yes serve -s "$DIST_DIR" -l "$SERVE_PORT" &
SERVE_PID=$!

# ---- poll loop: rebuild on new commits ----------------------------------------
while true; do
  sleep "$POLL_SECONDS"
  if clone_or_pull; then
    build
    log "rebuilt from new commit; static server keeps serving updated files"
  fi
done
