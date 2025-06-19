FROM node:24.2.0 AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run b
RUN pnpm prune --prod
FROM node:24.2.0-slim
WORKDIR /app
RUN apt-get update && apt-get install -y \
    libstdc++6 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder --chown=node:node /app/node_modules ./node_modules/
COPY --from=builder --chown=node:node /app/dist ./dist/
COPY --chown=node:node server/ssl/ ./server/ssl/
USER node
ENTRYPOINT ["node", "dist/index.js"]
