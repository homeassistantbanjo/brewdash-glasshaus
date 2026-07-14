# GlassHaus keg-management service.
#
# Two stages: a BUILD stage generates the verified-scannable QR SVGs (using the mature
# `qrcode` + `jsqr` libs, self-verifying each by decoding) — these deps exist ONLY at build
# time. The RUNTIME stage copies the generated SVGs and runs a zero-dep Node service
# (node:sqlite + http), matching the other GlassHaus sidecars. Config via env (NEVER git):
#   HA_URL, HA_TOKEN (HA mirror; omit to disable), BASE_URL (tailnet URL in the QR codes),
#   [PORT=8097], [SEED_KEGS=10], [DB_PATH=/data/kegs.db], [ALLOW_ORIGIN=*]

# ── build: generate + verify QR svgs ──
FROM node:22-alpine AS qrgen
WORKDIR /gen
COPY gen-qr.mjs ./
# transient build deps only; not carried into the runtime image
RUN npm init -y >/dev/null 2>&1 && npm install --no-save qrcode@1 jsqr@1
# BASE_URL bakes the tailnet host into the sticker URLs; COUNT matches the fleet size
ARG BASE_URL=https://unraid.tail229434.ts.net
ARG KEG_COUNT=10
RUN BASE_URL=$BASE_URL COUNT=$KEG_COUNT node gen-qr.mjs

# ── runtime: zero-dep service ──
FROM node:22-alpine
WORKDIR /app
# copy package.json + ALL runtime .mjs (test files are excluded by .dockerignore, and a
# glob avoids the "added a module, forgot to list it → crash-loop" trap).
COPY package.json ./
COPY *.mjs ./
RUN rm -f gen-qr.mjs        # build-only tool (runs in the qrgen stage); not needed at runtime
COPY --from=qrgen /gen/qr-svg ./qr-svg
EXPOSE 8097
CMD ["node", "server.mjs"]
