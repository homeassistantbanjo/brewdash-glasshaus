#!/bin/sh
# Deploy Glasshaus-programs (LIVE TANK CONTROL). Preserves the running container's env
# EXACTLY (DRY_RUN=false + HA_TOKEN) via an on-box env-file — the token never leaves the box
# and is never printed. Rename-aside recreate; verify the runner ticks; roll back on failure.
set -e
C=Glasshaus-programs
IMG=glasshaus-programs:new
SRC=/tmp/programs-src.tar.gz
BUILD=/tmp/programs-build

echo "== extracting source =="
rm -rf "$BUILD"; mkdir -p "$BUILD"
tar xzf "$SRC" -C "$BUILD"

echo "== capturing current env (masked) + verifying DRY_RUN =="
ENVFILE=/tmp/.programs.env
docker inspect "$C" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -vE '^(PATH|NODE_VERSION|YARN_VERSION|HOME|HOSTNAME)=' > "$ENVFILE"
if ! grep -q '^DRY_RUN=false$' "$ENVFILE"; then
  echo "!! ABORT: current container is not DRY_RUN=false — refusing to guess. Env keys:"
  sed -E 's/=(.*)/=<val>/' "$ENVFILE"
  exit 1
fi
echo "  env keys preserved: $(sed -E 's/=.*//' "$ENVFILE" | tr '\n' ' ')"
echo "  DRY_RUN=false confirmed ✓"

echo "== building image =="
docker build -q -t "$IMG" -f "$BUILD/programs/Dockerfile" "$BUILD/programs" >/dev/null
echo "  BUILD OK"

echo "== rename-aside + recreate =="
docker rename "$C" "${C}_old"
docker stop "${C}_old" >/dev/null
if ! docker run -d --name "$C" --restart unless-stopped --env-file "$ENVFILE" "$IMG" >/dev/null; then
  echo "!! run failed — rolling back"
  docker rm -f "$C" 2>/dev/null || true
  docker rename "${C}_old" "$C"; docker start "$C" >/dev/null
  echo "ROLLED BACK"; exit 1
fi

echo "== verify: runner boots + ticks (wait up to 40s) =="
ok=0
i=0
while [ $i -lt 8 ]; do
  sleep 5; i=$((i+1))
  L=$(docker logs "$C" 2>&1)
  echo "$L" | grep -q 'runner up' && echo "  boot: $(echo "$L" | grep 'runner up' | head -1)"
  if echo "$L" | grep -qE '\[metrics\] wrote|tilt-ctl|setpoint|derive|program complete|\[.*\] '; then ok=1; fi
  if echo "$L" | grep -qiE 'Error: missing env|Cannot find module|SyntaxError'; then ok=0; break; fi
  [ $ok -eq 1 ] && break
done

if [ $ok -ne 1 ]; then
  echo "!! runner did not report a healthy tick — rolling back. last logs:"
  docker logs "$C" 2>&1 | tail -15
  docker rm -f "$C"
  docker rename "${C}_old" "$C"; docker start "$C" >/dev/null
  echo "ROLLED BACK"; exit 1
fi

echo "  HEALTHY — runner ticking"
docker rm -f "${C}_old" >/dev/null
rm -f "$ENVFILE"
echo "== DEPLOYED: $C on $IMG, DRY_RUN=false preserved =="
docker logs "$C" 2>&1 | tail -6
