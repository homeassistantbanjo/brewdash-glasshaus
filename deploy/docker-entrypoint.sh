#!/bin/sh
# Runtime config injection. Runs before nginx starts (nginx:alpine executes
# everything in /docker-entrypoint.d/). Writes config.js from env vars so the
# prebuilt, token-free image gets its HA URL/token ONLY at runtime, from the
# Unraid container config — never baked into the image or the git repo.
set -eu

CONFIG_FILE=/usr/share/nginx/html/config.js
HA_URL="${VITE_HA_URL:-}"
HA_TOKEN="${VITE_HA_TOKEN:-}"
ANALYZER_URL="${VITE_ANALYZER_URL:-}"

cat > "$CONFIG_FILE" <<EOF
window.__GLASSHAUS_CONFIG__ = {
  haUrl: "${HA_URL}",
  haToken: "${HA_TOKEN}",
  analyzerUrl: "${ANALYZER_URL}"
};
EOF

echo "[glasshaus] wrote runtime config (haUrl=${HA_URL:-<empty>}, haToken=${HA_TOKEN:+<set>}${HA_TOKEN:-<empty>}, analyzerUrl=${ANALYZER_URL:-<default>})"
