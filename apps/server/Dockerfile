# Сборка из корня репозитория: docker compose build
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @ag/server... build \
  && pnpm deploy --filter @ag/server --prod --legacy /out \
  && cp -r apps/server/dist apps/server/drizzle /out/

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out /app
EXPOSE 3000
CMD ["node", "dist/main.js"]
