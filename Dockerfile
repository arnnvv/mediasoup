FROM node:24.1-alpine3.21 AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run b
RUN pnpm prune --prod
FROM node:24.1-alpine3.21
WORKDIR /app
COPY --from=builder --chown=node:node /app/node_modules ./node_modules/
COPY --from=builder --chown=node:node /app/dist ./dist/
USER node
ENTRYPOINT ["node", "dist/index.js"]
