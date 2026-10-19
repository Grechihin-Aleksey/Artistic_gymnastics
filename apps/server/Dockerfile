# Сборка из корня репозитория: docker compose build
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @ag/server... --filter @ag/judge... --filter @ag/scoreboard... build \
  && pnpm deploy --filter @ag/server --prod --legacy /out \
  && cp -r apps/server/dist apps/server/drizzle /out/ \
  && cp -r apps/judge/dist /out/judge \
  && cp -r apps/scoreboard/dist /out/board

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV JUDGE_DIST=/app/judge
ENV BOARD_DIST=/app/board
COPY --from=build /out /app
EXPOSE 3000
CMD ["node", "dist/main.js"]
