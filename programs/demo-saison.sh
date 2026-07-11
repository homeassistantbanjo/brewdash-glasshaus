#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# GlassHaus — SAISON PROFILE demo (accelerated, real setpoint writes) on tank_2.
#
# Walks the REAL French Saison temp arc live: cool pitch 68°F → aggressive free-rise
# ramp (+2°F/12h) to the mid-80s phenolic peak (86°F) → hot diastatic hold 86°F →
# conditioning 72°F → confirm-gated cold crash to 38°F. TIME_SCALE=3600 (one
# phase-hour per real second) so it flows in ~90s. The plan's real advances are
# attenuation-gated (which stall on the out-of-liquid test Tilt), so THIS DEMO swaps
# them for short elapsed gates purely so you can watch the temp arc — the shipped
# generator still uses the real attenuation gates.
#
# Safety: tank_2 only; pauses the normal programs container; records + RESTORES the
# original setpoint + program and resumes the container on exit.
# Usage (on Unraid):  bash /tmp/demo-saison.sh [DURATION_SECONDS]
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

TANK=tank_2
DURATION="${1:-110}"
IMG=ghcr.io/homeassistantbanjo/brewdash-glasshaus-programs:latest
DEMO_NAME=glasshaus-programs-demo

HA=http://192.168.50.127:8123
TOK=$(docker exec glasshaus sh -c 'grep -oE "haToken: \"[^\"]+\"" /usr/share/nginx/html/config.js | sed "s/haToken: \"//;s/\"//"')
H=(-H "Authorization: Bearer $TOK" -H 'content-type: application/json')
hh() { curl -s -m 12 "${H[@]}" "$@"; }

ORIG_SETPOINT_RAW=$(hh "$HA/api/states/number.${TANK}_setpoint_raw" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{try{console.log(JSON.parse(r).state)}catch(e){console.log("")}})')
ORIG_PROGRAM=$(hh "$HA/api/states/input_select.${TANK}_program" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{try{console.log(JSON.parse(r).state)}catch(e){console.log("None")}})')
echo "captured: ${TANK} setpoint_raw=${ORIG_SETPOINT_RAW} program=${ORIG_PROGRAM}"

cleanup() {
  echo
  echo "== RESTORING =="
  docker rm -f "$DEMO_NAME" >/dev/null 2>&1 || true
  hh -X POST "$HA/api/services/input_select/select_option" \
    -d "{\"entity_id\":\"input_select.${TANK}_program\",\"option\":\"${ORIG_PROGRAM:-None}\"}" >/dev/null || true
  if [ -n "${ORIG_SETPOINT_RAW}" ] && [ "${ORIG_SETPOINT_RAW}" != "unknown" ]; then
    hh -X POST "$HA/api/services/number/set_value" \
      -d "{\"entity_id\":\"number.${TANK}_setpoint_raw\",\"value\":${ORIG_SETPOINT_RAW}}" >/dev/null || true
    echo "  ${TANK} setpoint_raw restored to ${ORIG_SETPOINT_RAW}"
  fi
  docker start Glasshaus-programs >/dev/null 2>&1 && echo "  Glasshaus-programs resumed" || true
  echo "done."
}
trap cleanup EXIT INT TERM

# The REAL saison temp arc, with elapsed gates (short) so it flows for the demo.
# ramp phase = the +2°F/12h free-rise you watch step 68→86. coldCrash phase keeps
# requiresConfirm (runner forces it) so you SEE it await your confirmation.
echo "== writing SAISON demo plan → sensor.${TANK}_program_plan =="
PLAN='{"state":"DEMO — French Saison (peppery)","attributes":{"friendly_name":"'"${TANK}"' program plan","tank":"'"${TANK}"'","plan":{"label":"DEMO — French Saison (peppery)","clamp":{"minF":40,"maxF":88},"expectedAtten":80,"phases":[{"name":"Cool Pitch & Early Control","kind":"hold","tempF":68,"advance":{"type":"elapsed","hours":18}},{"name":"Free-Rise to Phenolic Peak","kind":"ramp","tempF":68,"targetF":86,"stepF":2,"everyHours":12,"advance":{"type":"elapsed","hours":84}},{"name":"Hot Diastatic Hold","kind":"hold","tempF":86,"advance":{"type":"elapsed","hours":48}},{"name":"Conditioning Hold","kind":"hold","tempF":72,"advance":{"type":"elapsed","hours":48}},{"name":"Cold Crash","kind":"coldCrash","targetF":38,"stepF":2,"everyHours":6,"requiresConfirm":true,"advance":{"type":"confirm"}}]}}}'
hh -X POST "$HA/api/states/sensor.${TANK}_program_plan" -d "$PLAN" >/dev/null && echo "  plan written"

hh -X POST "$HA/api/services/input_number/set_value" -d "{\"entity_id\":\"input_number.${TANK}_program_phase\",\"value\":0}" >/dev/null
hh -X POST "$HA/api/services/input_datetime/set_datetime" -d "{\"entity_id\":\"input_datetime.${TANK}_program_phase_started\",\"datetime\":\"$(date -u +%Y-%m-%dT%H:%M:%S+00:00)\"}" >/dev/null
hh -X POST "$HA/api/services/input_select/select_option" -d "{\"entity_id\":\"input_select.${TANK}_program\",\"option\":\"Generated\"}" >/dev/null
echo "  ${TANK} program → Generated, phase 0, clock reset"

echo "== pausing normal runner, launching saison demo runner (tank_2 only, REAL writes, 3600x) =="
docker stop Glasshaus-programs >/dev/null 2>&1 || true
docker rm -f "$DEMO_NAME" >/dev/null 2>&1 || true
docker run -d --name "$DEMO_NAME" \
  -e HA_URL="$HA" -e HA_TOKEN="$TOK" \
  -e TANKS="$TANK" -e DRY_RUN=false -e TIME_SCALE=3600 -e TICK_MINUTES=0.05 \
  "$IMG" >/dev/null && echo "  demo runner up (tick ~3s)"

echo
echo "== LIVE — watch the Tank 2 card. setpoint & phase for ${DURATION}s =="
END=$((SECONDS + DURATION))
LAST=""
while [ $SECONDS -lt $END ]; do
  LINE=$(hh "$HA/api/states/sensor.${TANK}_program_status" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{try{const j=JSON.parse(r);const a=j.attributes||{};console.log(`phase ${a.phaseIndex} · ${a.phase} · setpoint ${a.setpointF}F · ${a.awaitingConfirm?"AWAITING CONFIRM":(a.done?"DONE":a.note||"")}`)}catch(e){console.log("(no status yet)")}})')
  if [ "$LINE" != "$LAST" ]; then echo "  [$(date +%H:%M:%S)] $LINE"; LAST="$LINE"; fi
  sleep 2
done
echo "== window elapsed =="
echo "-- demo runner log (temp arc) --"
docker logs "$DEMO_NAME" 2>&1 | grep -iE "${TANK}|setpoint|phase|advance|confirm" | tail -24
