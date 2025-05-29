FROM node:23.11-alpine3.21 AS builder
WORKDIR /app
#Install whateve's needed
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
WORKDIR /app/node_modules/mediasoup
RUN pnpm run worker:build
WORKDIR /app
COPY . .
RUN pnpm run b
RUN pnpm prune --prod
FROM node:23.11-alpine3.21
WORKDIR /app
COPY --from=builder --chown=node:node /app/node_modules ./node_modules/
COPY --from=builder --chown=node:node /app/dist ./dist/
USER node
ENTRYPOINT ["node", "dist/index.js"]
