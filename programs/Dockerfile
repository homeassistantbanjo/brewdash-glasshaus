# GlassHaus fermentation-programs runner — scheduled control service. Ticks every
# TICK_MINUTES: reads program state + sensors from HA, runs the tested state machine,
# writes setpoints (unless DRY_RUN). No npm deps (Node 22 built-in fetch). Built by
# GitHub Actions → ghcr; Unraid pulls it. Config via env (NEVER git):
#   HA_URL, HA_TOKEN, [TICK_MINUTES=5], [DRY_RUN=true], [TANKS=tank_1,tank_2,tank_3]
FROM node:22-alpine
WORKDIR /app
COPY package.json presets.mjs statemachine.mjs derived.mjs runner.mjs ./
# DRY_RUN defaults TRUE in the image so a fresh deploy NEVER writes setpoints until
# the operator explicitly sets DRY_RUN=false after watching the logs. Safety first.
ENV DRY_RUN=true
CMD ["node", "runner.mjs"]
