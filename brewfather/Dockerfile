# GlassHaus Brewfather write service — holds the BF API key server-side and
# exposes a small HTTP API the dashboard calls to write brew-day measurements back
# to Brewfather. No npm deps (Node 22 built-in fetch + http). Built by GitHub
# Actions → ghcr; Unraid pulls it. Config via env (NEVER git):
#   BF_USERID, BF_APIKEY, [PORT=8093], [ALLOW_ORIGIN=*]
FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
EXPOSE 8093
CMD ["node", "server.mjs"]
