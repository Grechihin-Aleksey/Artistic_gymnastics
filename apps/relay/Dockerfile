# Облачный ретранслятор. Сборка из корня репозитория:
#   docker build -f apps/relay/Dockerfile -t ag-relay .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @ag/relay... --filter @ag/scoreboard... build \
  && pnpm deploy --filter @ag/relay --prod --legacy /out \
  && cp -r apps/relay/dist apps/relay/public /out/ \
  && cp -r apps/scoreboard/dist /out/widget

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV WIDGET_DIST=/app/widget
ENV DATA_DIR=/data
COPY --from=build /out /app
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/main.js"]
