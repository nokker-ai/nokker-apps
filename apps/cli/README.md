# nokker — client terminal

Client terminal de Nokker Lokkal : une session de code dans le dossier courant, contre le noyau (ou le
`mock-server` pour développer). Ink 8 + React 19, bin `nokker`, parle au noyau par `@nokker-apps/sdk`.

## Usage

```
nokker                          session de code sur le dossier courant (reprend le fil de ce dossier)
nokker -p "demande"             un tour, réponse sur stdout (mode non interactif)
nokker -p "demande" --json      {reply, thread_id, cwd, pending_approvals, refused, cancelled}
nokker doctor [--fix]           contrôles : docker, compose Lokkal, serveur, authentification, version, git
nokker logs [-f] [-n N] [--since 1h|30m|2d] [--component core|cli]
nokker update [--check]         met à jour le noyau (install.sh --update, sinon env_file + compose pull/up) puis remplace le binaire ;
                                --check compare la version installée à la dernière release lokkal-v*
nokker --server <url>           serveur (priorité : --server > $NOKKER_SERVER_URL > api_url de lokkal.json > http://127.0.0.1:8742)
nokker --sound                  sonnette terminal sur les bulles (coupée par défaut)
```

`doctor`, `logs` et `update` expliquent proprement l'absence de docker ou de compose connu (pas de trace de pile) ;
`logs --component cli` et `doctor` marchent sans docker.

### En session

- Chaque appel d'outil : `⟳ patch src/app.py (écriture)` puis `✓ patch src/app.py 120 ms`. Effets en clair :
  lecture / écriture / destructif / envoi / dépense / secret. Aperçu du résultat sur 3 lignes, replié : `o` (champ de
  saisie vide) ou `/out` le déplie ; `/tools` déplie tout. Les sous-agents sont des lignes indentées.
- Mode par défaut d'une session locale : `accept_edits` — `write_file`/`patch` dans le dossier passent sans carte ;
  les commandes `terminal` (tests, build) demandent une carte locale ; le destructif une carte « forte-locale »
  (sans « Toujours »). Une commande interdite (hardline : `rm -rf /`, mkfs…) est refusée sans carte : la ligne d'outil
  s'affiche en refus.
- **Carte « Action à approuver »** (outil, effet, commande ou chemin) : `1. Une fois · 2. Pour cette session ·
  3. Toujours cette commande · 3b. Toujours les commandes qui commencent par …* · 4. Refuser` ; ↑/↓, chiffres, Entrée.
  Pour une **commande de test** (`pytest|unittest|npm test|pnpm test|yarn test|go test|cargo test|make test|vitest|jest`)
  l'ordre devient `1. Pour cette session · 2. Une fois · 3. Toujours… · 4. Refuser` (la touche affichée est la touche).
  « 3 »/« 3b » montrent la règle exacte qui sera écrite dans vos réglages Nokker (`settings.json` du dossier d'état) avant que Entrée la
  valide. Pas de 3 sur une carte forte ni destructive ; la règle envoyée est toujours l'une des `suggested_rules` de la carte.
  Échap ne décide pas ; Ctrl+C = refus (puis annulation du tour) ; compte à rebours de 300 s puis refus « expirée » ;
  une ligne résumé reste dans le fil.
- Carte `strong` (web) : à décider sur téléphone ; la CLI ne signe plus avec sa clé logicielle (refusé par le noyau).
- Ce qui est tapé pendant « connexion… » est mis en attente et envoyé une fois la session ouverte (`/confirm`, `/quit` et
  `/help` s'exécutent tout de suite). L'en-tête tronque le titre du fil à 32 caractères ; le compte à rebours d'une carte
  s'affiche « 24 h », « 59 min » puis « m:ss ».
- Échap pendant un tour = `POST /v1/threads/{id}/cancel` (le noyau arrête le tour), pas seulement l'affichage.
- Commandes : `/sessions` (dossiers), `/threads`, `/goto`, `/thread [titre]` (nouveau fil ; `/new` est réservé à la
  frontière d'épisode du noyau), `/cancel`, `/out`, `/tools`, `/bubbles`, `/bubble`, `/send`, `/ask`, `/approvals`,
  `/confirm <TOTP>`, `/login`, `/help`, `/quit`, et, **en session de code** (ailleurs : « disponible dans une session de
  code (nokker dans un dossier) ») :

  | Commande | Outil du noyau | Rendu |
  |---|---|---|
  | `/diff [hash\|n]` | `checkpoint_diff` | diff vert/rouge dans le fil, tronqué à 300 lignes (mention du reste) |
  | `/checkpoints` | `checkpoint_list` | hash court, heure, raison, fichiers (n°1 = le plus récent) |
  | `/rollback [hash\|n]` | `checkpoint_restore {safe:true}` | carte « Action à approuver » (même carte qu'une commande destructive), puis fichiers restaurés / conservés ; sans argument : le dernier point |
  | `/skills [nom]` | `skill_list` / `skill_view` | tableau par famille / corps Markdown rendu |
  | `/plan` | `todo` | liste à puces avec état (`[x]` fait, `[~]` en cours, `[ ]` à faire) |
  | `/agents` | (événements `subagent.*`) | child_id, état, but tronqué, dernier outil, durée |

### Route locale d'appel d'outil (PROPOSÉE au noyau)

`POST /v1/local/tools/call {thread_id, name, arguments}` (jeton local ; fil de session locale seulement, sinon 404).
Liste blanche `checkpoint_list|checkpoint_diff|checkpoint_create|checkpoint_restore|skill_list|skill_view|todo` (autre nom : 403 ; `todo` est en lecture seule : `arguments` doit être `{}`, sinon 400 ; 409 si un tour est en cours sur le fil, la CLI affiche « un tour est en cours, réessayez après »).
`200 {content, is_error}` si l'outil est autorisé (READ/WRITE) ; un refus par règle ou par le mode plan est aussi un `200 {content, is_error: true}` ; `202 {approval_id}` si l'effet exige une carte
(`checkpoint_restore` : DESTRUCTIVE) : la carte suit le chemin normal (`approval.requested`, `GET /v1/local/approvals`,
`decide`) et le résultat (rejet de la carte compris : `is_error: true`) arrive dans UN événement `tool.result {thread_id, approval_id, content, is_error}`, sans tour modèle ni autre événement.
`content` est le texte du résultat tel quel (formes mesurées sur le noyau) : `checkpoint_list` = liste JSON NUE
`[{hash, short_hash, timestamp, reason, files_changed, insertions, deletions}]` (la CLI tolère aussi `{checkpoints}`) ;
`checkpoint_diff` = `{stat, diff, message?}` ; `checkpoint_restore` = `{success, restored_files, skipped_user_edits}` ;
`skill_list` = `{skills:[…]}` ; `skill_view` = Markdown ; `todo` = `{todos, revision, summary}`. `checkpoint_create` répond
202 (carte) en attendant un 200 en accept_edits : la CLI gère les deux. La carte d'un appel direct a `channel: "local-direct"` ;
le `tool.result` n'a pas de `call_id` (apparié par `approval_id`). Erreurs : 400 `arguments invalides (todo : lecture seule,
sans argument)`, 403 `outil non appelable directement : <nom>` (la CLI affiche `error.message` tel quel). Le chemin vit dans
`LOCAL_TOOL_CALL_PATH` (`packages/sdk/src/client.ts`) ; SDK : `callLocalTool(threadId, name, args)`. Le mock simule 3 points
de retour, 4 skills et un plan de 3 étapes.

### Mode non interactif et erreurs d'usage

Un argument ou drapeau inconnu (`nokker status`) sort avec « argument inconnu : … (nokker --help) » sur stderr, code 2. Sans
terminal (stdin ou stdout non-TTY) la TUI ne démarre jamais : « mode interactif impossible sans terminal ; utilisez nokker
-p "…" », code 2.

Dans une session locale, personne ne peut décider une carte : tout effet que le noyau n'a pas déjà couvert par une
règle est **refusé par défaut** (mode sans surveillance) et listé dans `refused` (`tool`, `effect`, `target`).
Les cartes d'un fil ordinaire restent `pending` (`pending_approvals`).

## Connexion

1. Serveur local (127.0.0.1/localhost) et jeton local présent (à `token_path` de lokkal.json, sinon `~/.config/nokker/local-token`) : le jeton est présenté en
   `Authorization: Bearer` (aucun enrôlement ; vérifié par un appel, sinon repli sur 2).
2. Sinon, flux d'appareil : clé P-256 (trousseau ou fichier 0600), enrôlement avec `user` déclaré
   (`$NOKKER_USER`, sinon l'utilisateur du système). Si l'appareil est `pending`, le **code** s'affiche et la CLI
   attend la confirmation (sur l'hôte, ou `/confirm <TOTP>` / `NOKKER_TOTP` en `-p`), puis ouvre la session de 12 h.

## Variables et fichiers

| Nom | Rôle |
|---|---|
| `NOKKER_SERVER_URL` | serveur (défaut `http://127.0.0.1:8742` ; le mock de dev tourne sur 4310) |
| `NOKKER_CONFIG_DIR_OVERRIDE` | remplace `~/.config/nokker` (tests, isolation) |
| `NOKKER_USER` | utilisateur déclaré à l'enrôlement d'appareil |
| `NOKKER_TOTP` | confirme l'appareil tout de suite en mode `-p` |
| `token_path` (lokkal.json) | jeton local écrit par le noyau (0600), ex. `~/.nokker/state/local-token` ; à défaut `~/.config/nokker/local-token` |
| `settings.json` (dossier d'état du noyau) | `{"permissions": {"mode", "allow", "ask", "deny"}}` ; « Toujours » y ajoute une règle `allow` (avec le compose : `~/.nokker/state/settings.json`) |
| `~/.config/nokker/lokkal.json` (Windows : `%USERPROFILE%\.config\nokker`, Linux/macOS : `$XDG_CONFIG_HOME/nokker` si défini) | écrit en 0600 par install.sh (schéma ci-dessous ; `install_dir`, et `wsl_distro` sous Windows) |
| `~/.config/nokker/cli.log` | journal du client (`nokker logs --component cli`) |

### lokkal.json

Le dossier de config est le même sur les 3 OS (celui de l'installeur). Repli en LECTURE sur les anciens emplacements (macOS
`~/Library/Application Support/nokker`, Windows `%APPDATA%\nokker`) ; `doctor` avertit s'il y trouve un fichier.

```json
{"compose": "/abs/docker-compose.yml", "project": "nokker", "version": "0.1.0", "core_service": "core",
 "api_url": "http://127.0.0.1:8742", "web_url": "http://127.0.0.1:7420",
 "token_path": "/abs/.nokker/state/local-token", "env_file": "/abs/.nokker/.env", "install_dir": "/abs/.nokker"}
```

Lokkal.json a 9 clés : les 8 ci-dessus (obligatoires ; compose, token_path, env_file absolus) plus `install_dir` (chemin de `~/.nokker`, toujours écrit par install.sh, requis sous WSL), et `wsl_distro` en option (Windows). Une clé manquante donne un message clair
(`doctor`, `logs`, `update`). Le port de l'API n'est pas fixe (`NOKKER_API_PORT`) : install.sh écrit le vrai dans
`api_url`. `doctor` contrôle aussi `GET <web_url>/healthz`. `logs` = `docker compose -p <project> -f <compose> logs <core_service>`.

### Windows (WSL 2)

Lokkal tourne dans WSL 2 ; `nokker.exe` est dans `%LOCALAPPDATA%\Nokker\bin`, `lokkal.json` dans
`%USERPROFILE%\.config\nokker\`. Avec `"wsl_distro": "<distro>"` : `compose`, `env_file` et `install_dir` sont des
chemins Linux, `token_path` un chemin UNC (`\\wsl.localhost\<distro>\home\…\local-token`) lu tel quel, et
`update`, `logs` et le contrôle docker de `doctor` passent par `wsl.exe -d <distro> -- …`
(`update` = `wsl.exe -d <distro> -- sh <install_dir>/install.sh --update`). `api_url`/`web_url` en 127.0.0.1 marchent
tels quels. Ailleurs, `install_dir` (`~/.nokker`) est aussi écrit : `<install_dir>/install.sh --update` est préféré.

### update

`nokker update` : `install.sh --update` s'il est à côté du compose (ou `~/.nokker/install.sh`), sinon réécrit
`NOKKER_VERSION=<cible>` dans `env_file` puis `docker compose -p … pull && up -d`, attend `/healthz`. Il finit par
remplacer le binaire par `nokker-<os>-<arch>` de la release `lokkal-v<version>` : `.sha256` (sortie `sha256sum`)
OBLIGATOIRE, `cosign verify-blob --bundle` en plus si `cosign` est installé (échec = pas de remplacement) ; écrit à côté
puis `rename` atomique (Windows : `nokker.exe.new`). Sans réseau, `--check` le dit et sort normalement.

Règles : `outil` ou `outil(motif)`, motif fnmatch sensible à la casse comparé à la commande entière (`terminal`) ou
au chemin normalisé (`write_file`, `read_file`, `patch`). Ordre du noyau : deny, plan, ask, allow, mode.

## Binaire autonome

```
pnpm -C apps/cli build:bin                 # dist/nokker-{linux-x64,linux-arm64,darwin-x64,darwin-arm64,windows-x64.exe,windows-arm64.exe} + .sha256
bash apps/cli/scripts/build-bin.sh linux-x64
```

`bun build --compile` (bun ≥ 1.4, `$BUN` ou `~/.bun/bin/bun`) via `scripts/build-bin.ts` : `react-devtools-core`
(import statique d'Ink, inutile hors DEV) est remplacé par un module vide ; la version est figée à la compilation
(`$NOKKER_RELEASE_VERSION`, sinon package.json). install.sh le pose dans `~/.nokker/bin/nokker`.

## Développer

```
pnpm -C packages/mock-server dev       # MOCK_PORT=4320 NOKKER_CONFIG_DIR_OVERRIDE=/tmp/cfg pour ne rien écraser
pnpm -C apps/cli start -- --server http://127.0.0.1:4320
pnpm -C apps/cli typecheck && pnpm -C apps/cli test
```

Mock : `MOCK_LOCAL_ROOTS` (racines séparées par `:`, défaut tout accepter), `MOCK_MIN_CLIENT_VERSION`,
`MOCK_DEVICE_PENDING=1` (appareils `pending` jusqu'au TOTP `000000`). Dans une session locale, « corrige le test X »
déclenche read_file → search_files → patch → pytest → `rm -rf build` (carte) ; « rm -rf / » déclenche une carte
hardline ; « sous-agent » déclenche `subagent.*`.

### Pilote pty de mesure (`test/pty_drive.py`)

Mode pas à pas (`pty_drive.py '<json>'`, voir l'en-tête) et mode scénario, qui joue une tâche de bout en bout sans jamais
rejouer une décision :

```
python3 apps/cli/test/pty_drive.py --task "corrige le test add" --server http://127.0.0.1:4320 \
  --cwd /work/projet --config-dir /tmp/cfg --max-decisions 3 --decide 1
# -> {"cards":[{"t":3.1,"tool":"terminal","command":"pytest -q …"}],"turns_user":1,"duration_s":9.4,"final_text":"…","bounded":false,"error":null}
```

Les cartes sont détectées UNIQUEMENT par `GET /v1/local/approvals` (nouvel id = une décision, jamais deux pour le même id) ;
le rendu de la carte est attendu sur le delta d'écran depuis la détection, jamais sur le tampon cumulé ; au-delà de
`--max-decisions` il s'arrête (`bounded: true`) sans décider ; il termine quand plus aucune carte n'attend et que l'écran est
muet depuis `--idle` s (12). `--decide` est la touche envoyée (1 ou 2 : l'ordre dépend de la carte, cf. commandes de test).
`turns_user` et `final_text` sont lus par `GET /v1/threads/{id}`. Ne jamais l'appeler contre le vrai noyau sans borne.
