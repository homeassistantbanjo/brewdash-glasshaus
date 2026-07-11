#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# GlassHaus — ACCELERATED FERM-PROGRAM DEMO (run on the Unraid host)
#
# Drives tank_2 through a short demo fermentation plan with REAL setpoint writes,
# at TIME_SCALE=3600 (one phase-hour per real second) so you watch the runner set
# a temp → call the controller → advance to the next phase/temp live in the UI —
# without waiting for real temperatures to be reached.
#
# Safety: targets tank_2 ONLY (a test bed, no real beer). Pauses the normal programs
# container for the duration so the two runners don't fight over tank_2, records the
# original tank_2 setpoint, and RESTORES both on exit (even on Ctrl-C / error).
#
# Usage (on Unraid):  bash /tmp/demo-accelerated.sh [DURATION_SECONDS]
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

TANK=tank_2
DURATION="${1:-100}"           # how long to let the demo run (s); full plan ≈ 72s
IMG=ghcr.io/homeassistantbanjo/brewdash-glasshaus-programs:latest
DEMO_NAME=glasshaus-programs-demo

HA=http://192.168.50.127:8123
TOK=$(docker exec glasshaus sh -c 'grep -oE "haToken: \"[^\"]+\"" /usr/share/nginx/html/config.js | sed "s/haToken: \"//;s/\"//"')
H=(-H "Authorization: Bearer $TOK" -H 'content-type: application/json')
hh() { curl -s -m 12 "${H[@]}" "$@"; }

# ---- capture original state so we can restore ----
ORIG_SETPOINT_RAW=$(hh "$HA/api/states/number.${TANK}_setpoint_raw" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{try{console.log(JSON.parse(r).state)}catch(e){console.log("")}})')
ORIG_PROGRAM=$(hh "$HA/api/states/input_select.${TANK}_program" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{try{console.log(JSON.parse(r).state)}catch(e){console.log("None")}})')
echo "captured: ${TANK} setpoint_raw=${ORIG_SETPOINT_RAW} program=${ORIG_PROGRAM}"

cleanup() {
  echo
  echo "== RESTORING =="
  docker rm -f "$DEMO_NAME" >/dev/null 2>&1 || true
  # program back to its original value (usually None)
  hh -X POST "$HA/api/services/input_select/select_option" \
    -d "{\"entity_id\":\"input_select.${TANK}_program\",\"option\":\"${ORIG_PROGRAM:-None}\"}" >/dev/null || true
  # setpoint back to what it was
  if [ -n "${ORIG_SETPOINT_RAW}" ] && [ "${ORIG_SETPOINT_RAW}" != "unknown" ]; then
    hh -X POST "$HA/api/services/number/set_value" \
      -d "{\"entity_id\":\"number.${TANK}_setpoint_raw\",\"value\":${ORIG_SETPOINT_RAW}}" >/dev/null || true
    echo "  ${TANK} setpoint_raw restored to ${ORIG_SETPOINT_RAW}"
  fi
  # resume the normal programs container
  docker start Glasshaus-programs >/dev/null 2>&1 && echo "  Glasshaus-programs resumed" || true
  echo "done."
}
trap cleanup EXIT INT TERM

# ---- write the demo plan into the tank's plan sensor (attributes) ----
echo "== writing demo plan → sensor.${TANK}_program_plan =="
PLAN='{"state":"DEMO — accelerated ferment","attributes":{"friendly_name":"'"${TANK}"' program plan","tank":"'"${TANK}"'","plan":{"label":"DEMO — accelerated ferment (Piwo)","clamp":{"minF":54,"maxF":90},"expectedAtten":81,"phases":[{"name":"Cool Pitch","kind":"hold","tempF":60,"advance":{"type":"elapsed","hours":12}},{"name":"Primary Free-Rise","kind":"hold","tempF":65,"advance":{"type":"elapsed","hours":24}},{"name":"Diacetyl Rest","kind":"hold","tempF":68,"advance":{"type":"elapsed","hours":12}},{"name":"Conditioning Hold","kind":"hold","tempF":72,"advance":{"type":"elapsed","hours":24}},{"name":"Done — Cold Hold","kind":"hold","tempF":55,"advance":{"type":"elapsed","hours":9999}}]}}}'
hh -X POST "$HA/api/states/sensor.${TANK}_program_plan" -d "$PLAN" >/dev/null && echo "  plan written"

# ---- reset phase to 0 + stamp phase_started = NOW so the accel clock starts fresh ----
hh -X POST "$HA/api/services/input_number/set_value" -d "{\"entity_id\":\"input_number.${TANK}_program_phase\",\"value\":0}" >/dev/null
hh -X POST "$HA/api/services/input_datetime/set_datetime" -d "{\"entity_id\":\"input_datetime.${TANK}_program_phase_started\",\"datetime\":\"$(date -u +%Y-%m-%dT%H:%M:%S+00:00)\"}" >/dev/null
# ---- activate the Generated program ----
hh -X POST "$HA/api/services/input_select/select_option" -d "{\"entity_id\":\"input_select.${TANK}_program\",\"option\":\"Generated\"}" >/dev/null
echo "  ${TANK} program → Generated, phase 0, clock reset"

# ---- pause the normal runner (avoid two runners on tank_2), start the demo runner ----
echo "== pausing normal programs container, launching demo runner (tank_2 only, REAL writes, 3600x) =="
docker stop Glasshaus-programs >/dev/null 2>&1 || true
docker rm -f "$DEMO_NAME" >/dev/null 2>&1 || true
docker run -d --name "$DEMO_NAME" \
  -e HA_URL="$HA" -e HA_TOKEN="$TOK" \
  -e TANKS="$TANK" -e DRY_RUN=false -e TIME_SCALE=3600 -e TICK_MINUTES=0.05 \
  "$IMG" >/dev/null && echo "  demo runner up (tick ~3s)"

# ---- stream the demo: show setpoint + phase every few seconds ----
echo
echo "== LIVE (watch the card too) — setpoint & phase for ${DURATION}s =="
END=$((SECONDS + DURATION))
LAST=""
while [ $SECONDS -lt $END ]; do
  SNAP=$(hh "$HA/api/states/sensor.${TANK}_program_status")
  LINE=$(echo "$SNAP" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{try{const j=JSON.parse(r);const a=j.attributes||{};console.log(`phase ${a.phaseIndex} · ${a.phase} · setpoint ${a.setpointF}F · ${a.done?"DONE":a.note||""}`)}catch(e){console.log("(no status yet)")}})')
  if [ "$LINE" != "$LAST" ]; then echo "  [$(date +%H:%M:%S)] $LINE"; LAST="$LINE"; fi
  sleep 2
done
echo "== demo window elapsed =="
echo "-- demo runner log --"
docker logs "$DEMO_NAME" 2>&1 | grep -iE "${TANK}|setpoint|phase|advance" | tail -20
# cleanup() runs on EXIT
