# Nokker pour VS Code

Une session de code Nokker Lokkal dans VS Code : un panneau de chat sur le dossier ouvert, contre le noyau qui tourne sur
votre machine. Même session, mêmes règles et mêmes cartes d'approbation que la commande `nokker` dans un terminal.

> **Marketplace : bientôt.** L'extension n'est publiée ni sur le Visual Studio Marketplace ni sur Open VSX ; elle
> s'installe pour l'instant depuis un paquet `.vsix` construit localement (ci-dessous).

## Ce que fait le panneau

- **Session du dossier ouvert** : à l'ouverture, le panneau reprend le fil le plus récent de ce dossier
  (`GET /v1/local/sessions`), sinon en ouvre un (`POST /v1/local/sessions {cwd}`). Bouton « + » : nouveau fil sur le même
  dossier. Le dossier doit être sous une racine déclarée de Lokkal, sinon le panneau le dit.
- **Réponses en direct**, appels d'outil avec leur effet (`lecture`, `écriture`, `destructif`…), aperçu du résultat
  replié, sous-agents indentés.
- **Patchs dans le diff natif** : sous chaque `patch` / `write_file`, « Voir le diff » ouvre l'éditeur de diff de VS Code
  (avant ↔ fichier actuel). Le texte « avant » est lu sur le disque au moment de l'appel ; à défaut, il est refait à partir
  du passage remplacé, seulement s'il est sans ambiguïté (jamais deviné, jamais tiré d'un argument tronqué).
- **Cartes d'approbation** : mêmes choix et même ordre que la CLI — `1. Une fois · 2. Pour cette session · 3. Toujours cette
  commande · 3b. Toujours les commandes qui commencent par … · 4. Refuser` (pour une commande de test, « Pour cette
  session » passe en premier) ; la règle exacte qui sera écrite s'affiche sous « Toujours ». Décision par
  `POST /v1/local/approvals/{id}/decide`, une seule fois par carte, et au plus 25 décisions par tour. Une **carte forte**
  n'a pas de bouton ; elle dit où elle attend : « Action forte : elle attend ton téléphone » si elle est partie chez
  nokker.ai (machine liée), sinon « Action forte : à décider dans le terminal (`nokker`) ». Panneau caché : une
  notification VS Code signale la carte.
- **Ligne de coût** sous chaque tour (`12,4 k jetons · 0,03 €`, mise en forme `formatCostLine` du SDK, partagée avec la CLI
  et le web) ; jetons seuls quand le modèle n'a pas de prix.
- **Envoyer la sélection** (menu contextuel de l'éditeur, palette « Nokker : Envoyer la sélection à Nokker »,
  `Ctrl+Alt+N` / `Cmd+Alt+N`) : le fichier et les lignes rejoignent le prochain message comme bloc de contexte
  (`src/app.py:10-24`), retirable avant l'envoi.
- **Images** : `@capture.png` dans le message joint l'image du dossier (le noyau la lit, rien n'est encodé côté éditeur).
- **Arrêter** (ou Échap dans la zone de saisie) : `POST /v1/threads/{id}/cancel`.

Un tour dure jusqu'au bout de ses suites : sur le noyau, une carte rend la main au modèle ; une approbation exécute l'outil
(sa vraie sortie ferme l'appel) puis lance un tour de suite, un refus ne lance rien ; le panneau reste « occupé » tant
qu'une carte est ouverte, qu'une décision est en vol, qu'un outil approuvé attend son résultat ou qu'un tour de suite tourne.

## Connexion et jeton

L'extension lit **exactement les mêmes fichiers que la CLI** (code partagé) :

- noyau : réglage `nokker.serverUrl` (portée machine, jamais synchronisé) > `$NOKKER_SERVER_URL` > `api_url` de
  `~/.config/nokker/lokkal.json` (écrit par l'installeur) > `http://127.0.0.1:8742` ;
- jeton local : `token_path` de `lokkal.json`, à défaut `~/.config/nokker/local-token`.

Le jeton n'est **jamais** dans les réglages de VS Code (Settings Sync les copie entre machines) et n'est envoyé qu'à un
noyau en boucle locale (`127.0.0.1`, `localhost`). Il ne quitte pas l'hôte d'extension : le panneau (webview) n'a ni jeton
ni accès réseau. Problème de connexion : `nokker doctor` dans un terminal.

## Sécurité du panneau

- CSP stricte : `default-src 'none'`, un seul script (nonce), une seule feuille servie par VS Code, `connect-src 'none'`,
  aucun style ni script en ligne, aucune ressource distante.
- Tout texte venu du noyau est posé par `textContent` (Markdown minimal construit en nœuds, jamais en HTML).
- L'extension exige un dossier de confiance (`untrustedWorkspaces: false`).

## Construire, tester, empaqueter

```sh
pnpm install --frozen-lockfile
pnpm --filter nokker-vscode build          # dist/extension.cjs + dist/webview.js (esbuild)
pnpm --filter nokker-vscode test           # unitaires (vitest, contre le mock-server)
pnpm --filter nokker-vscode test:electron  # vrai VS Code sous xvfb (@vscode/test-electron, télécharge VS Code)
pnpm --filter nokker-vscode package        # nokker-vscode-0.1.0.vsix (local, aucune publication)
code --install-extension apps/vscode/nokker-vscode-0.1.0.vsix
```

`test:electron` démarre le mock-server, ouvre un dossier jetable dans VS Code avec l'extension en développement, puis
vérifie : activation, commandes, connexion par le jeton local, envoyer la sélection, un tour avec deux cartes (décidées par
l'API, bornées), diff natif ouvert sur le bon fichier, nouveau fil. Version de VS Code : `$NOKKER_VSCODE_VERSION`
(défaut `stable` ; essayé aussi sur 1.95.3, minimum déclaré). `NOKKER_E2E_SHOT=<fichier.png>` (écran xvfb
`-s "-screen 0 1400x900x24"`) enregistre des captures du panneau.

## Fichiers

| Fichier | Rôle |
|---|---|
| `src/extension.ts` | branchement VS Code : vue webview, commandes, diff natif, notifications |
| `src/controller.ts` | logique du panneau, sans l'API VS Code (testée contre le mock) |
| `src/connection.ts` | noyau et jeton, par le code de la CLI (`apps/cli/src/lokkal.ts`) |
| `src/webview/` | panneau (DOM, Markdown en arbre) |
| `src/html.ts` | page et CSP |
| `src/selection.ts` | « envoyer la sélection » |
| `packages/sdk/src/editor-session.ts` | tour vu d'un éditeur, partagé avec `nokker acp` |
