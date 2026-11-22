# Image web de Nokker : build Vite statique servi par nginx (repli SPA, healthz, cache long sur /assets).
# Pas de proxy : /v1/ est routé vers le noyau à l'ingress (même origine, sans CORS).
# Contexte de build = racine de nokker-apps : docker build -f deploy/web/Dockerfile -t nokker-web .
# Kill-switch PWA : --build-arg PWA_KILL=1 (voir deploy/web/README.md).
# Variables web lues AU BUILD (import.meta.env), toutes éteintes / vides par défaut. Chacune se lève par
#   --build-arg VITE_NOKKER_<NOM>=<valeur>   (ex. SHOW_ME=1 GUIDE=1 KIOSK=1 NINA_LIVE=1 PRESENTER=1 PRESENT_LIVE=1 ; ORB=0 et GLOW=0 éteignent)
# Exportées seulement si elles sont remplies : Vite fait passer l'environnement devant les fichiers .env, et une
# variable vide éteindrait un réglage posé ailleurs. Liste tenue complète par apps/web/test/dockerfile-flags.test.ts :
# toute variable VITE_* lue par le code web doit être déclarée ici (VITE_PWA_KILL passe par PWA_KILL).
FROM node:22-alpine AS build
ARG PWA_KILL=0
ENV VITE_PWA_KILL=$PWA_KILL
ARG VITE_APP_VERSION=""
ARG VITE_NOKKER_AUTH=""
ARG VITE_NOKKER_AUTHORIZE_URL=""
ARG VITE_NOKKER_GATEWAY=""
# V4 verre liquide et V5 Pretext : ALLUMÉS par défaut dans ce build (décision du propriétaire, 10.11) ; --build-arg VITE_NOKKER_GLASS=0 /
# VITE_NOKKER_PRETEXT=0 les éteignent. Sans rebuild : ?glass=off et ?pretext=0 dans l'adresse (mémorisé par navigateur).
ARG VITE_NOKKER_GLASS="1"
ARG VITE_NOKKER_GLOW=""
ARG VITE_NOKKER_GOOGLE=""
ARG VITE_NOKKER_GUIDE=""
ARG VITE_NOKKER_KIOSK=""
ARG VITE_NOKKER_NINA_LIVE=""
ARG VITE_NOKKER_ONBOARDING_AVATAR=""
ARG VITE_NOKKER_ORB=""
ARG VITE_NOKKER_PRESENTER=""
ARG VITE_NOKKER_PRETEXT="1"
ARG VITE_NOKKER_PRESENT_LIVE=""
ARG VITE_NOKKER_SERVER_URL=""
ARG VITE_NOKKER_SHOW_ME=""
ARG VITE_NOKKER_STORE_BUILD=""
RUN corepack enable
WORKDIR /w
COPY . .
RUN for v in VITE_APP_VERSION VITE_NOKKER_AUTH VITE_NOKKER_AUTHORIZE_URL VITE_NOKKER_GATEWAY VITE_NOKKER_GLASS VITE_NOKKER_GLOW \
      VITE_NOKKER_GOOGLE VITE_NOKKER_GUIDE VITE_NOKKER_KIOSK VITE_NOKKER_NINA_LIVE VITE_NOKKER_ONBOARDING_AVATAR \
      VITE_NOKKER_ORB VITE_NOKKER_PRESENT_LIVE VITE_NOKKER_PRESENTER VITE_NOKKER_PRETEXT VITE_NOKKER_SERVER_URL VITE_NOKKER_SHOW_ME VITE_NOKKER_STORE_BUILD; do \
      eval "val=\${$v:-}"; if [ -n "$val" ]; then export "$v"; else unset "$v"; fi; \
    done \
 && pnpm install --frozen-lockfile \
 && pnpm --filter @nokker-apps/brand build \
 && pnpm --filter @nokker-apps/sdk build \
 && pnpm --filter @nokker-apps/web build \
 && if [ "$PWA_KILL" = "1" ]; then cp deploy/web/sw-kill.js apps/web/dist/sw.js; fi

FROM nginx:1.27-alpine
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/web/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /w/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
