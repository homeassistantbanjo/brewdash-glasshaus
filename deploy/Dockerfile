# GlassHaus kiosk host — self-contained build+serve container for Unraid.
# Clones the private repo, builds with the HA token (env var), serves dist/,
# and re-pulls+rebuilds on a poll interval. See deploy/entrypoint.sh.
#
# Build:  docker build -t glasshaus-host -f deploy/Dockerfile .
# (or point Unraid at this image / a registry copy)
FROM node:22-alpine

# git for pulling the repo; the rest ships with the node image
RUN apk add --no-cache git

WORKDIR /app
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# static server port (override with SERVE_PORT)
EXPOSE 8080

# All real config comes from env vars at runtime (Unraid template):
#   GIT_REPO, GIT_BRANCH, GIT_TOKEN, VITE_HA_URL, VITE_HA_TOKEN, POLL_SECONDS, SERVE_PORT
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
