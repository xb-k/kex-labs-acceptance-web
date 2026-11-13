# Build stage: install deps, typecheck, build SPA + bundle the server.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts postcss.config.js tailwind.config.js index.html ./
COPY src ./src
COPY server ./server
COPY seed-agents ./seed-agents
RUN npm run build && npm run build:server

# Runtime stage: only the built SPA and the single-file server.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    WEB_DATA_ROOT=/data \
    PORT=8088
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server/serve.mjs ./server/serve.mjs
COPY seed-agents ./seed-agents
EXPOSE 8088
CMD ["node", "server/serve.mjs"]
