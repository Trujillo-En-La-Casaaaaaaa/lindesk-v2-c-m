# Deterministic local notification-provider emulator.
#
# Single stage on purpose: the runtime dependency set is empty, so there is nothing to
# build, and `npm ci` only validates the committed lockfile. The service runs as the
# non-root `node` user that the official Node.js image ships.
FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

# Lockfile-verified install first so the layer is cached across source edits.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

USER node

EXPOSE 4010

CMD ["node", "src/server.mjs"]
