# Image web de Nokker : build Vite statique servi par nginx (repli SPA, healthz, cache long sur /assets).
# Pas de proxy : /v1/ est routé vers le noyau à l'ingress (même origine, sans CORS).
# Contexte de build = racine de nokker-apps : docker build -f deploy/web/Dockerfile -t nokker-web .
# Kill-switch PWA : --build-arg PWA_KILL=1 (voir deploy/web/README.md).
FROM node:22-alpine AS build
ARG PWA_KILL=0
ENV VITE_PWA_KILL=$PWA_KILL
RUN corepack enable
WORKDIR /w
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @nokker-apps/brand build \
 && pnpm --filter @nokker-apps/sdk build \
 && pnpm --filter @nokker-apps/web build \
 && if [ "$PWA_KILL" = "1" ]; then cp deploy/web/sw-kill.js apps/web/dist/sw.js; fi

FROM nginx:1.27-alpine
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /w/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
