# GlassHaus insight analyzer — scheduled service (NOT a web app; just a webhook +
# digest timer). No npm deps: uses Node 22 built-in fetch + http. Built by GitHub
# Actions → ghcr; Unraid pulls it. Config via env (never git):
#   HA_URL, HA_TOKEN, ANTHROPIC_API_KEY, [ANTHROPIC_MODEL], [DIGEST_HOURS],
#   [MIN_INTERVAL_SEC], [WEBHOOK_TOKEN], [INSIGHT_ENTITY], [PORT]
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY analyze.mjs server.mjs ./
EXPOSE 8091
CMD ["node", "server.mjs"]
