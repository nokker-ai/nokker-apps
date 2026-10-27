# nokker-apps

Interfaces client de **Nokker** (nom commercial centralisé dans `packages/brand/brand.ts`, binaire
CLI `nokker`). Contrat réseau qui fait foi : le serveur
[`nokker/api/`](https://github.com/nokker-ai/nokker/tree/main/nokker/api) du dépôt nokker. Détails et choix d'architecture : `docs/ARCHITECTURE.md`.

## Démarrage

```sh
corepack enable  # si pnpm n'est pas déjà dispo
pnpm install
```

### Mock-server (implémente le contrat en mémoire, pour développer sans le noyau)

```sh
pnpm --filter @nokker-apps/mock-server dev
# écoute sur http://127.0.0.1:4310 — scénario de démo des bulles (valeurs « demo », contenu en anglais), demandes en
# français ou en anglais : « disque » / "disk", « cherche … » / "search …", "timer 5 min", « lance le backup » /
# "run the backup", « montre la vidéo » / "show the video", « crée un agent qui … » / "create an agent that …",
# « envoie / copie la bulle X à <session> » / "send / copy the X bubble to <session>", « demande à Accounting de … » /
# "ask Accounting to …" ; Accounting notifie ~12 s après la première connexion SSE.
```

### CLI (terminal)

```sh
pnpm --filter @nokker-apps/cli start
```

### Web (React + Vite) — chat, tiroir de sessions, bulles flottantes, Crew

```sh
pnpm --filter @nokker-apps/web dev                     # http://127.0.0.1:5173
pnpm --filter @nokker-apps/web exec vite --host <IP>   # exposé sur une IP (Tailscale), mock resté en loopback
```

Vite relaie `/v1` et `/healthz` vers le mock (`NOKKER_SERVER_URL` pour une autre cible). Connexion : clé
d'appareil WebCrypto non extractible (IndexedDB) en contexte sécurisé, passkey avec `VITE_NOKKER_AUTH=passkey`,
jeton de démo `POST /v1/dev/demo-session` (mock seulement) en http sur une IP. Contrat : `nokker/docs/BUBBLES.md`.

## Build / tests (tout le monorepo, séquentiel — machine à 12 Go de RAM)

```sh
pnpm build   # tsc sur chaque package, en série (workspace-concurrency=1)
pnpm test    # vitest sdk + intégration cli↔mock-server, en série
```

## Structure

```
packages/brand        — source unique de la marque (PRODUCT_NAME, CLI_NAME, thème…)
packages/sdk          — client TypeScript du contrat (sans dépendance DOM : Node + navigateur + RN)
packages/mock-server  — serveur de dev en mémoire (SSE simulé, démo d'approbation)
apps/cli              — Ink (React terminal)
apps/web              — React + Vite
docs/ARCHITECTURE.md  — desktop (Tauri 2), mobile (Expo/RN + modules Swift), partage du SDK
docs/adr/0001-*        — écart WebAuthn/passkey vs signature ECDSA brute du contrat
```
