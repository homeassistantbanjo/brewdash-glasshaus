# GlassHaus — prebuilt image for Unraid. Built by GitHub Actions (see
# .github/workflows/build-image.yml) and published to ghcr.io; Unraid just PULLS it.
#
# The image is TOKEN-FREE and safe to store in the registry: the HA URL/token are
# injected at CONTAINER STARTUP from env vars into /usr/share/nginx/html/config.js
# (see docker-entrypoint.sh). One image serves any brewery.

# ---- build stage: compile the SPA (no secrets) --------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Build with NO VITE_HA_* env → token is NOT inlined. Runtime config.js supplies it.
RUN npm run build

# ---- serve stage: nginx serving the static dist ------------------------------
FROM nginx:alpine
# SPA routing: all paths → index.html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/docker-entrypoint.sh /docker-entrypoint.d/40-glasshaus-config.sh
RUN chmod +x /docker-entrypoint.d/40-glasshaus-config.sh
EXPOSE 80
# nginx:alpine's own entrypoint runs /docker-entrypoint.d/*.sh then starts nginx,
# so our config-writer runs first automatically.
