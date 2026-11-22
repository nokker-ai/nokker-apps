# App Nokker (web propre + coque native) — contrats demandés au noyau et au relais

Rédigé par nokker-front le 06.11.2026 pour nokker `docs/LOKKAL-PHONE.md` §1.1 (W1) et §1.2 (liste unique). Ce sont
les formes dont le web et l'app ont besoin ; le noyau peut les nommer autrement s'il le dit. Rien ici n'expose le
contenu d'un fil Lokkal chez nokker.ai.

Origines de l'app : `capacitor://localhost` (iOS), `https://localhost` (Android). Le web de prod : `https://app.nokker.ai`.

## C1. CORS du noyau cloud (app.nokker.ai) — lot P0

La coque appelle `https://app.nokker.ai/v1/*` depuis une autre origine. En-têtes que le SDK ENVOIE : `Authorization`
(Bearer), `Content-Type: application/json`, `User-Agent`, `X-Session-Id`, `X-Nokker-Stream-Tokens`, `Last-Event-ID`
(reprise de `/v1/events`). En-tête qu'il LIT : `Retry-After`.

- Liste blanche EXACTE des origines : `capacitor://localhost`, `https://localhost` (configurable, par exemple
  `cloud.cors_origins`). Toute autre origine : aucun en-tête CORS (le navigateur bloque).
- Préflight `OPTIONS /v1/*` (origine autorisée) → `204`, `Access-Control-Allow-Origin: <origine>` (jamais `*`),
  `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE`,
  `Access-Control-Allow-Headers: Authorization, Content-Type, X-Session-Id, X-Nokker-Stream-Tokens, Last-Event-ID`,
  `Access-Control-Max-Age: 600`, `Vary: Origin`. Sans authentification (le préflight n'en porte jamais).
- Réponses (y compris les erreurs 4xx/5xx et les flux SSE de `/v1/chat/completions` et `/v1/events`) :
  `Access-Control-Allow-Origin: <origine>`, `Access-Control-Expose-Headers: Retry-After`, `Vary: Origin`.
- **Jamais** `Access-Control-Allow-Credentials` (aucun cookie : tout passe par `Authorization`).
- Hors champ : `/v1/gateway/authorize` et les pages HTML ; les webhooks (Stripe, Telegram) ne prennent jamais de CORS.
- Test : préflight d'une origine autorisée → 204 et en-têtes ; d'une origine inconnue → pas d'`Allow-Origin` ; un POST
  `/v1/chat/completions` en flux depuis `capacitor://localhost` → en-têtes présents sur la réponse 200.

## C2. CORS du relais `<nom>.nokker.app/v1/*` — lot P1 (relais : le navigateur partagé)

Le web d'app.nokker.ai et l'app parlent DIRECTEMENT au noyau de chaque machine (liste unique, §1.2 point 1).

- Origines exactes : `https://app.nokker.ai`, `capacitor://localhost`, `https://localhost`.
- Mêmes règles que C1 (préflight 204, méthodes, en-têtes, `Expose-Headers: Retry-After`, `Vary: Origin`, jamais de
  `Allow-Credentials`), appliquées par le relais sur `/v1/*` seulement ; `/_gw/*` et les pages servies : sans CORS.
- Le préflight n'atteint pas la machine s'il peut être servi par le relais (la machine éteinte ne doit pas casser le
  préflight : 204 quand même ; la requête réelle dira 502/504).
- Jeton : `Authorization: Bearer <access_token>` de `POST /v1/gateway/token {host}` (existe : session du compte,
  900 s). Le client le renouvelle à 80 % de `expires_in`.

## C3. Recherche dans les fils — `GET /v1/threads/search` (cloud ET noyau local) — lot P1

`GET /v1/threads/search?q=<texte>&limit=20` → `200 {results: [Result], truncated: bool}`.

`Result` = `{thread_id, title, snippet, turn_index, at, channel}` :
- `title` : titre du fil (ou `null`) ; `snippet` : ≤ 160 caractères autour de la première occurrence, **caviardé**
  (mêmes règles que le miroir : secrets connus, mots de passe capturés) ; `turn_index` : tour où le texte apparaît
  (`null` si c'est le titre) ; `at` : ISO 8601 du tour ; `channel` : `api | telegram | code | agent`.
- Portée : les fils du compte (cloud) ou du propriétaire de la machine (local), jamais ceux d'un autre membre.
- `q` : 2 à 200 caractères, insensible à la casse et aux accents ; sinon `400 bad_query`. `limit` ≤ 50.
- Tri : plus récent d'abord. Délai côté serveur ≤ 2 s (le client coupe à 3 s par origine et dit « <machine> n'a pas
  répondu »).
- Aucune écriture, aucun journal du texte cherché au-delà des compteurs habituels.

## C4. Notification sans contenu — `POST /v1/gateway/notify` (machine → nokker.ai) — lot P1

Appel de la machine (jeton de machine, comme le battement) :
`{kind: "turn_done" | "awaiting_approval" | "agent_failed" | "agent_done", thread_id, title: string | null}` →
`202 {queued: true}` ; `429` au-delà de 30/min par machine (`Retry-After`) ; `400 bad_kind`.

- `title` soumis à la règle du miroir (envoyé seulement si les fils de la machine sont en miroir, sinon `null`).
- nokker.ai pousse vers les appareils du PROPRIÉTAIRE de la machine : notifications de l'app (P4), Web Push, Telegram
  s'il est appairé. Texte vu sur l'écran verrouillé : « <nom de la machine> : ta session « <titre> » a fini »
  (ou « … attend ton accord », « … un agent a échoué », « … un agent a fini ») ; sans titre : « ta session ». Jamais
  un extrait.
- Lien de la notification : `https://app.nokker.ai/t/<machine_id>/<thread_id>` (le web l'ouvre dans la liste unique).
- `GET /v1/notifications` (existe) porte aussi ces entrées : `{kind, machine_id, machine_name, thread_id, title, at}`.

## C5. Deck v2 — `GET /v1/link/deck` (cloud) — lot P1

Ajout (rétrocompatible : `v: 2` en tête) par machine `DeckMachine` :

```
threads: [{thread_id, state: "idle" | "working" | "awaiting_approval", updated_at, channel, title | null}]
```

- Les 100 fils les plus récents de la machine, pas seulement les sessions de code ; `title` sous la règle du miroir.
- Sert à la liste unique quand la machine est **hors ligne** (grisés, « hors ligne depuis <âge du deck> »).
- `mirror: bool` par machine : le miroir est allumé (le web propose alors « Continuer dans le cloud » et la copie en
  lecture seule `lokkal-<machine>-<fil>`).

## C6. Liens profonds de l'app (P2, pour mémoire)

`https://app.nokker.ai/.well-known/apple-app-site-association` et `/.well-known/assetlinks.json` (déjà routés par
nginx du web) : chemins `/t/*`, `/approve/*`, `/sites/r/*`, `/sites/h/*`, `/nfc/*`. Identifiant `ai.nokker.app`
(question 4 de LOKKAL-PHONE §8).

## Écarts retenus par le noyau (p2/app-core 9827885, 06.11)

- C1 : la liste se règle par `cloud_link.cors_origins` ; `Allow-Headers` inclut aussi `User-Agent`.
- C3 : une copie en miroir trouvée par la recherche cloud porte `copy_of {machine_id, thread_id}` et `title: null` ; le
  web la rend à sa machine (une seule ligne si la machine l'a trouvée aussi).
- C4 : réponse `202 {queued, channels}` ; l'état de la bulle notify porte aussi `link`.
- C5 : `deck_v` par machine (1 : sessions de code seulement ; 2 : `threads`).
