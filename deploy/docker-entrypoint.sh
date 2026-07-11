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
BREWFATHER_URL="${VITE_BREWFATHER_URL:-}"

cat > "$CONFIG_FILE" <<EOF
window.__GLASSHAUS_CONFIG__ = {
  haUrl: "${HA_URL}",
  haToken: "${HA_TOKEN}",
  analyzerUrl: "${ANALYZER_URL}",
  brewfatherUrl: "${BREWFATHER_URL}"
};
EOF

echo "[glasshaus] wrote runtime config (haUrl=${HA_URL:-<empty>}, haToken=${HA_TOKEN:+<set>}${HA_TOKEN:-<empty>}, analyzerUrl=${ANALYZER_URL:-<default>}, brewfatherUrl=${BREWFATHER_URL:-<default>})"

# Write the nginx HA proxy upstream from the runtime HA_URL, so the app can write to
# HA same-origin (/ha/... → HA) and dodge CORS. If HA_URL is unset, emit an empty
# include so nginx still starts (writes just won't proxy).
UPSTREAM_CONF=/etc/nginx/ha_upstream.conf
if [ -n "$HA_URL" ]; then
  cat > "$UPSTREAM_CONF" <<EOF
location /ha/ {
    proxy_pass ${HA_URL}/;
    proxy_set_header Host \$host;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 60s;
}
EOF
  echo "[glasshaus] wrote HA proxy → ${HA_URL} (browser uses /ha/ same-origin)"
else
  echo "# no VITE_HA_URL → no HA proxy" > "$UPSTREAM_CONF"
  echo "[glasshaus] WARNING: no VITE_HA_URL — /ha proxy disabled"
fi
