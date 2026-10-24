# Architecture — interfaces client Nokker

> Nom commercial : **Nokker** (nokker.ai, déposé 15.10.2026), binaire CLI `nokker` — centralisé dans
> `packages/brand/brand.ts` (voir ce fichier pour la liste complète des constantes et la procédure
> de renommage, si jamais il devait y en avoir un autre). Contrat qui fait foi :
> le serveur [`nokker/api/`](https://github.com/nokker-ai/nokker/tree/main/nokker/api) du dépôt nokker. Seul
> `/v1/chat/completions` existe aujourd'hui côté noyau (`nokker/api/server.py`) ; tout le reste de
> ce monorepo est développé contre `packages/mock-server`, qui implémente le contrat en mémoire.

## 1. Vue d'ensemble

```
packages/brand        — une constante par identité (nom, binaire CLI, thème…), tout le reste l'importe
packages/sdk          — client TypeScript du contrat, SANS dépendance au DOM (Node + navigateur + RN)
packages/mock-server  — serveur de dev qui implémente le contrat en mémoire (SSE simulé, démo d'approbation)
apps/cli              — Ink (React pour terminal)
apps/web              — React + Vite, WebAuthn/passkey pour les approbations
(à venir)
apps/desktop          — Tauri 2 autour d'apps/web (§2)
apps/mobile           — Expo/React Native + modules natifs Swift pour iPhone Duo (§3)
```

Un seul SDK (`packages/sdk`), cinq surfaces. C'est le choix structurant de ce chantier : toute la
logique de contrat (auth, SSE, canonicalisation JSON, reconnexion) vit UNE fois ; chaque app n'écrit
que son rendu et son stockage de clé (trousseau OS pour la CLI, WebAuthn pour le web, Keychain/
Keystore pour le mobile, Secure Enclave/TPM pour le desktop).

## 2. Desktop (Linux/macOS/Windows) — Tauri 2, recommandé

**Recommandation : Tauri 2**, pas Electron.

| | Tauri 2 | Electron |
|---|---|---|
| Runtime | WebView système (WebView2/WebKitGTK/WKWebView) | Chromium embarqué |
| Taille d'installeur | ~3-10 Mo (le binaire ; la webview est déjà sur l'OS) | ~80-150 Mo (Chromium + Node embarqués) |
| RAM au repos | Nettement plus bas (pas de Chromium dédié par fenêtre) | Un procédé Chromium complet par fenêtre |
| Accès natif | Rust, via des *plugins* (fs, notification, autostart, clipboard, deep-link…) + commandes `#[tauri::command]` custom | Node.js complet côté main process |
| Mises à jour | `tauri-plugin-updater` (signé) | `electron-updater`/Squirrel |
| Surface d'attaque | Pas de Node intégré au renderer (IPC explicite `invoke`) | Node accessible si mal isolé (`contextIsolation` à bien poser) |

Pourquoi c'est le bon choix ici précisément :
- **`apps/web` se réutilise tel quel** comme contenu de la fenêtre Tauri (`tauri.conf.json` pointe sur
  le build Vite) — zéro réécriture de l'UI, seulement un pont natif pour ce que le web ne peut pas
  faire : notifications système persistantes (approbation en attente), icône de barre de tâches/menu
  bar, lancement au démarrage, et surtout un **trousseau natif réel** (`keyring` côté Rust, qui couvre
  macOS Keychain/libsecret/Windows Credential Manager en une seule API — contrairement au contournement
  en sous-processus de `apps/cli/src/keychain.ts`, ici pas besoin de shell-out).
- Un poste à 12 Go de RAM est un bon proxy du type de machine où ça compte : Electron multiplie les procédés Chromium, Tauri n'en ajoute aucun.
- **Signature des approbations `strong` en desktop** : via `tauri-plugin-biometric` (empreinte/visage
  du poste quand dispo) ou, à défaut, une clé stockée dans le trousseau natif + confirmation locale —
  même tension que `apps/cli` (pas de Secure Enclave garanti sur Linux), donc même doctrine : clé
  extractible rangée dans le trousseau OS, jamais en clair sur disque.

Coût réel : écrire les commandes Rust pour fs/notifications/trousseau (quelques dizaines de lignes
chacune, `packages/sdk` reste inchangé car il ne dépend déjà pas du DOM). Electron aurait été plus
rapide à démarrer (Node direct) mais plus lourd à vie et moins sûr par défaut — mauvais compromis
pour un produit qui tourne sur des postes de travail ordinaires (ressources comptées).

## 3. Mobile (iOS/Android, tablettes, iPhone Duo) — Expo/React Native, avec modules natifs Swift ciblés

**Recommandation : Expo (React Native) comme base, modules natifs Swift pour ce que RN ne couvre
pas (en particulier l'iPhone Duo)**, PAS une app 100% SwiftUI native.

| | Expo/RN + modules Swift | SwiftUI natif (iOS) + Kotlin natif (Android) |
|---|---|---|
| Code partagé iOS/Android | ~90% (UI, logique, `packages/sdk` tel quel) | 0% — deux bases de code complètes |
| Vitesse de livraison | Une équipe, un cycle de release | Deux équipes ou un développeur qui bascule de stack |
| Accès plateforme | Modules natifs à la demande (Swift/Kotlin) via l'API de modules Expo | Total, natif par construction |
| Secure Enclave / StrongBox | `expo-secure-store` + modules natifs pour la biométrie (Face ID/Touch ID, BiometricPrompt) | Natif direct |
| iPhone Duo (pliable, 2 écrans) | PAS supporté par les API React Native stock (pas de notion de pli/multi-écran) → **module natif Swift dédié** | Natif direct, mais alors Android perd le bénéfice du code partagé |

Pourquoi ce choix précisément pour Nokker :
- Les quatre autres surfaces (web, CLI, desktop) partagent déjà `packages/sdk`. Une appli 100% native
  dupliquerait l'auth par signature d'appareil, le parseur SSE, la reconnexion — exactement le code
  qu'on vient de centraliser. RN permet de réutiliser `packages/sdk` directement (il ne dépend pas du
  DOM — c'est pour ça que `packages/sdk` a été écrit sans `EventSource` ni API DOM : RN a `fetch` et
  `TextDecoder`/`TextEncoder` avec les polyfills standards, ou nativement sur Hermes récent).
- **iPhone Duo** (pliable, susceptible d'exposer deux zones d'affichage ou un pli à éviter pour le
  texte) n'a pas d'API cross-platform stable aujourd'hui : c'est un vrai argument pour garder RN comme
  socle et traiter le Duo comme **un module natif Swift isolé** (détection de la configuration
  d'écran, layout en deux panneaux fil/conversation sur le Duo déplié) plutôt que de renoncer à RN
  partout à cause d'un seul form factor. Android (tablette classique, pliables Samsung) reste couvert
  par les breakpoints CSS-like de RN (`useWindowDimensions`), pas de module natif nécessaire là.
- La biométrie pour les approbations `strong` (BiometricManager Android / Face ID-Touch ID iOS,
  APPROVALS.md §1) est exactement le cas d'usage visé par les modules natifs Expo — pas une raison de
  tout réécrire en natif, juste le module `secure-enclave-sign` (iOS, Swift, Secure Enclave) et son
  équivalent Android (StrongBox/Keystore) exposés avec la même interface TypeScript.
- Coût du choix inverse (natif pur) : deux bases de code, un contrat réimplémenté deux fois (surface
  d'erreur doublée sur exactement la partie la plus sensible — la signature cryptographique des
  approbations), et aucun bénéfice perceptible pour l'utilisateur sur 95% des écrans (liste de fils,
  conversation, carte d'approbation) qui n'ont rien de spécifique à la plateforme.

## 4. Partage du SDK entre toutes les cibles

`packages/sdk` n'a **aucune** dépendance DOM : `EventSource` est réimplémenté par-dessus `fetch` +
parseur SSE maison (`src/sse.ts`, `src/events.ts`), le hash canonique utilise `@noble/hashes` (JS pur,
pas `node:crypto`), la signature ECDSA passe par `crypto.subtle` (WebCrypto), standard sur Node ≥ 16,
tout navigateur, et React Native avec le polyfill habituel. Résultat :

| Cible | Transport réseau | Stockage clé d'appareil | Preuve d'approbation |
|---|---|---|---|
| CLI (Node) | `fetch` global (Node ≥ 18) | trousseau OS en sous-processus, sinon fichier 0600 | ECDSA P-256 brute (clé extractible, signée localement) |
| Web | `fetch` navigateur | `localStorage` (id d'appareil) + passkey (clé jamais exportée) | **WebAuthn** (voir ADR 0001) |
| Desktop (Tauri) | `fetch` de la WebView (même `apps/web`) | trousseau natif (`keyring` Rust) | ECDSA ou WebAuthn selon la plate-forme (Windows Hello expose WebAuthn) |
| Mobile (RN) | `fetch` RN (polyfill si besoin) | `expo-secure-store` / Keychain / Keystore | module natif (Secure Enclave/StrongBox) signant au format du contrat |

Seule la **preuve de signature** diverge par plate-forme — et c'est documenté comme un écart de
contrat, pas une improvisation : voir `docs/adr/0001-webauthn-vs-ecdsa-contrat.md`.

## 5. Trous de contrat identifiés pendant ce chantier (à trancher côté noyau)

1. **Obtention du défi de `POST /v1/sessions`** — CLIENT-API.md documente l'endpoint mais pas
   comment le client récupère le nonce à signer (contrairement aux approbations, qui ont
   `POST /v1/approvals/{id}/challenge`). `packages/mock-server` invente
   `POST /v1/devices/{id}/session-challenge` (clairement marqué extension non contractuelle dans le
   code) — à faire valider ou remplacer par le vrai format une fois le serveur de sessions écrit.
2. ~~**Reconnexion de `/v1/events` sans curseur**~~ — RÉGLÉ côté noyau (p1/bubbles) : `Last-Event-ID`, que
   `subscribeEvents` repose désormais à chaque reconnexion. Texte d'origine : — pas de `Last-Event-ID` ni de paramètre de rejeu
   documenté : `packages/sdk/src/events.ts` reconnecte "depuis maintenant", donc un client peut
   manquer des événements pendant une coupure réseau. Le SDK expose `onReconnected` pour que
   l'appelant re-tire l'état (`GET /v1/approvals?status=pending`) après coup, mais un vrai curseur
   côté serveur réglerait le problème à la source.
3. **Format de preuve WebAuthn** — voir ADR 0001.
4. **Collision de nom de binaire** — le noyau Python expose déjà une CLI `nokker` (`BRAND.md`,
   `prog="nokker"`). `apps/cli` de ce monorepo déclare aussi `bin: { nokker: ... }`. Tant que ce
   chantier reste en développement (lancé via `pnpm`, jamais installé globalement), il n'y a pas de
   collision réelle — mais la question "les deux CLI `nokker` fusionnent-elles, ou l'une des deux
   change de nom de binaire (ex. `nokker-cli` pour celle-ci en attendant) ?" reste ouverte et doit se
   trancher avant un premier `npm install -g`.

## 6. Tests

- `packages/sdk` : `vitest` — parseur SSE (découpe réseau arbitraire, commentaires, `[DONE]`),
  décodage UTF-8 par flux coupé au milieu d'un caractère multi-octets, JSON canonique (tri de clés,
  stabilité), reconnexion (`subscribeEvents` : backoff, `onReconnected`, `close()` qui stoppe bien la
  boucle).
- `apps/cli` : test d'intégration démarrant `packages/mock-server` en mémoire (port éphémère) et
  pilotant `src/session.ts`/`src/auth.ts` (le code que `ui/App.tsx` appelle) — enrôlement, connexion,
  conversation en flux, carte d'approbation déclenchée, décision par signature d'appareil ET par TOTP
  (correct et incorrect), garde-fou côté client qui refuse un TOTP sur une approbation `strong` AVANT
  même d'appeler le réseau. Choix délibéré : pas de test du rendu Ink lui-même (fragile, peu
  représentatif du contrat) — la logique testée est exactement celle que l'UI appelle.
