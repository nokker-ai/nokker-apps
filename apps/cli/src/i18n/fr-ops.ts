/**
 * Catalogue français (partie « exploitation ») : doctor, update, backup, logs, lokkal.json, coffre, authentification, pont ACP,
 * mode non interactif. Clé = libellé source anglais tel qu'écrit dans `t("…")`.
 */
export const FR_OPS: Record<string, string> = {
  // doctor : noms des lignes
  "memory": "mémoire",
  "Lokkal compose": "compose Lokkal",
  "config location": "emplacement de config",
  "web interface": "interface web",
  "server": "serveur",
  "authentication": "authentification",
  "client version": "version client",
  "repair": "réparation",
  "server (after)": "serveur (après)",
  "vault": "coffre",
  "model": "modèle",

  // doctor : premier réglage (Lokkal)
  "first setup not finished": "premier réglage pas terminé",
  "no default model chosen": "aucun modèle par défaut choisi",
  "default model is the nokker.ai Router but this machine is not linked": "le modèle par défaut est le Router de nokker.ai, mais cette machine n'est pas reliée",
  "default model {0} no longer exists": "le modèle par défaut {0} n'existe plus",
  "default model {0} has no key": "le modèle par défaut {0} n'a pas de clé",
  "default model {0} has no model name": "le modèle par défaut {0} n'a pas de nom de modèle",
  "{0} — open {1}": "{0} — ouvre {1}",
  "default {0}": "par défaut {0}",
  "setup unreadable ({0})": "réglage illisible ({0})",

  // doctor : mémoire longue
  "long-term memory ({0}) is down — {1}": "mémoire longue ({0}) en panne — {1}",
  "unknown reason": "raison inconnue",
  "long-term memory disabled (memory_mode: off): nothing is recalled from one thread to the next":
    "mémoire longue désactivée (memory_mode: off) : rien n'est rappelé d'un fil à l'autre",
  "long-term memory through MCP: status not checked here (the remote service has its own)":
    "mémoire longue par MCP : état non contrôlé ici (le service distant a le sien)",
  "unexpected mode {0}": "mode {0} inattendu",
  "direct": "directe",
  "{0} note(s)": "{0} note(s)",
  "embeddings {0} dim in {1} ms": "plongements {0} dim en {1} ms",
  "embeddings {0} dim": "plongements {0} dim",
  "last recall {0} ms": "dernier rappel {0} ms",
  " — last error: {0}": " — dernière erreur : {0}",
  "kernel without GET /v1/local/memory (predates direct memory)": "noyau sans GET /v1/local/memory (antérieur à la mémoire directe)",
  "cannot be checked without the local token": "non vérifiable sans le jeton local",
  "status unreadable ({0})": "état illisible ({0})",
  "timed out": "délai dépassé",

  // doctor : docker, compose, interface web, serveur
  "wsl.exe not found (is WSL 2 installed?)": "wsl.exe introuvable (WSL 2 est-il installé ?)",
  "docker is not installed (or not in PATH)": "docker n'est pas installé (ou pas dans le PATH)",
  " in WSL ({0})": " dans WSL ({0})",
  "daemon reachable{0} ({1})": "démon joignable{0} ({1})",
  "unknown version": "version inconnue",
  "daemon unreachable — {0}": "démon injoignable — {0}",
  "no response": "pas de réponse",
  "lokkal.json is missing (no Lokkal installed by install.sh?)": "lokkal.json absent (aucun Lokkal installé par install.sh ?)",
  "{0} not found": "{0} introuvable",
  "{0} (project {1}, version {2})": "{0} (projet {1}, version {2})",
  "lokkal.json read from the old location {0}; the installer writes it to {1} — rerun install.sh or move it":
    "lokkal.json lu à l'ancien emplacement {0} ; l'installeur l'écrit dans {1} — relance install.sh ou déplace-le",
  "{0}/healthz unreachable ({1})": "{0}/healthz injoignable ({1})",
  "network error": "erreur réseau",
  " (version {0})": " (version {0})",
  " — dev MOCK": " — MOCK de dev",
  "{0}{1} responds{2}{3}": "{0}{1} répond{2}{3}",
  " (dev mock)": " (mock de dev)",
  " — but something responds on {0}: use --server": " — mais ça répond sur {0} : utilise --server",
  "{0}{1} does not respond ({2}){3}": "{0}{1} ne répond pas ({2}){3}",
  "default": "défaut",

  // doctor : authentification, version, git, réparation
  "cannot be checked without a server": "non vérifiable sans serveur",
  "local token accepted (no enrolment needed)": "jeton local accepté (aucun enrôlement nécessaire)",
  "local token present but rejected by the server (stale? restart the kernel)": "jeton local présent mais refusé par le serveur (périmé ? relance le noyau)",
  "device enrolled, session of {0} valid until {1}": "appareil enrôlé, session de {0} valide jusqu'à {1}",
  "device session expired — rerun nokker to sign in again": "session d'appareil expirée — relance nokker pour te reconnecter",
  "neither a local token nor an enrolled device — the first run of nokker will enrol you":
    "ni jeton local ni appareil enrôlé — le premier lancement de nokker t'enrôlera",
  "{0} (minimum unknown: server unreachable)": "{0} (minimale inconnue : serveur injoignable)",
  "{0} (the server announces no minimum)": "{0} (le serveur n'annonce pas de minimale)",
  "{0} < minimum {1} — run 'nokker update'": "{0} < minimale {1} — lancez « nokker update »",
  "{0} ≥ minimum {1}": "{0} ≥ minimale {1}",
  "git is missing from the host (needed for /diff and checkpoints)": "git absent de l'hôte (nécessaire pour /diff et les points de retour)",
  "git not found on Windows — not needed: /diff and checkpoints run in WSL ({0})": "git introuvable sous Windows — pas nécessaire : /diff et les points de retour tournent dans WSL ({0})",
  "docker compose up -d started": "docker compose up -d lancé",
  "docker compose up -d failed — {0}": "docker compose up -d a échoué — {0}",
  "{0} responds": "{0} répond",
  "does not respond yet — wait a few seconds and rerun doctor": "ne répond pas encore — patiente quelques secondes et relance doctor",
  "nothing can be repaired automatically (docker must be reachable and a compose file known)":
    "rien de réparable automatiquement (il faut docker joignable et un compose connu)",

  // update
  "The server requires a client ≥ {0} (yours: {1}) — nokker update replaces the binary with the one from the latest release.":
    "Le serveur demande un client ≥ {0} (le tien : {1}) — nokker update remplace le binaire par celui de la dernière release.",
  "This client is not the standalone binary (npm or sources): get {0} from release {1}.":
    "Ce client n'est pas le binaire autonome (npm ou sources) : récupère {0} dans la release {1}.",
  "Binary {0} not found in release {1} (HTTP {2}): client unchanged.": "Binaire {0} introuvable dans la release {1} (HTTP {2}) : client inchangé.",
  "Download truncated ({0} of {1} bytes): client unchanged.": "Téléchargement tronqué ({0} sur {1} octets) : client inchangé.",
  "Could not download the binary ({0}): client unchanged.": "Téléchargement du binaire impossible ({0}) : client inchangé.",
  "No {0}.sha256 in the release (HTTP {1}): cannot verify, client unchanged.":
    "Pas de {0}.sha256 dans la release (HTTP {1}) : vérification impossible, client inchangé.",
  "Wrong sha256 checksum (expected {0}…, received {1}…): client unchanged.": "Somme sha256 incorrecte (attendue {0}…, reçue {1}…) : client inchangé.",
  "sha256 checksum not found ({0}): cannot verify, client unchanged.": "Somme sha256 introuvable ({0}) : vérification impossible, client inchangé.",
  "Downloaded binary too small to be valid: client unchanged.": "Binaire téléchargé trop petit pour être valide : client inchangé.",
  "sigstore bundle missing (HTTP {0})": "bundle sigstore absent (HTTP {0})",
  "invalid signature": "signature invalide",
  "cosign verification failed ({0}): client unchanged.": "Vérification cosign échouée ({0}) : client inchangé.",
  "Windows cannot replace a running executable: {0} is ready. Close nokker then rename it to {1}.":
    "Windows ne remplace pas un exécutable en cours : {0} est prêt. Ferme nokker puis renomme-le en {1}.",
  "Client replaced: {0} (release {1}{2}).": "Client remplacé : {0} (release {1}{2}).",
  ", sha256 + cosign verified": ", sha256 + cosign vérifiés",
  ", sha256 verified": ", sha256 vérifié",
  "Cannot update the kernel: {0}.": "Mise à jour du noyau impossible : {0}.",
  "Installed: {0}": "Installé : {0}",
  "Latest release: unknown (GitHub unreachable — no network?)": "Dernière release : inconnue (GitHub injoignable — pas de réseau ?)",
  "Latest release: {0}": "Dernière release : {0}",
  "↑ update available: nokker update": "↑ mise à jour disponible : nokker update",
  "✓ up to date.": "✓ à jour.",
  "Client: {0} (nokker update replaces it with {1}).": "Client : {0} (nokker update le remplace par {1}).",
  "Cannot reach GitHub to find the latest release (network?): nothing was changed.":
    "Impossible de joindre GitHub pour connaître la dernière release (réseau ?) : rien n'a été modifié.",
  "docker is not installed (or not in PATH): the kernel cannot be updated from here.":
    "docker n'est pas installé (ou pas dans le PATH) : le noyau ne peut pas être mis à jour d'ici.",
  "The docker daemon does not respond ({0}).": "Le démon docker ne répond pas ({0}).",
  "Kernel already up to date ({0}).": "Noyau déjà à jour ({0}).",
  "Updating through {0} --update…": "Mise à jour par {0} --update…",
  "install.sh --update failed.": "install.sh --update a échoué.",
  "Cannot write NOKKER_VERSION to {0}.": "Impossible d'écrire NOKKER_VERSION dans {0}.",
  "NOKKER_VERSION={0} written to {1}. Downloading images…": "NOKKER_VERSION={0} écrit dans {1}. Téléchargement des images…",
  "docker compose pull failed (network, registry or permissions).": "docker compose pull a échoué (réseau, registre ou droits).",
  "Restarting the kernel…": "Redémarrage du noyau…",
  "docker compose up -d failed.": "docker compose up -d a échoué.",
  "The kernel does not respond on /healthz yet after the update — check with nokker doctor.":
    "Le noyau ne répond pas encore sur /healthz après la mise à jour — vérifie avec nokker doctor.",
  "Kernel: version {0} → {1}": "Noyau : version {0} → {1}",
  "download of install.sh failed (HTTP {0})": "téléchargement d'install.sh impossible (HTTP {0})",
  "download of install.sh failed ({0})": "téléchargement d'install.sh impossible ({0})",
  "no install.sh.sha256 in the release (HTTP {0}): cannot verify": "pas d'install.sh.sha256 dans la release (HTTP {0}) : vérification impossible",
  "wrong sha256 checksum for install.sh (expected {0}…, received {1}…)": "somme sha256 d'install.sh incorrecte (attendue {0}…, reçue {1}…)",
  "install.sh.sha256 not found ({0}): cannot verify": "install.sh.sha256 introuvable ({0}) : vérification impossible",
  "cosign verification of install.sh failed ({0})": "vérification cosign d'install.sh échouée ({0})",
  "--version expects a version like 1.2.3 (got {0}).": "--version attend une version comme 1.2.3 (reçu : {0}).",
  "Kernel {0} is newer than {1}: downgrades are not supported (migrations only go forward).":
    "Le noyau {0} est plus récent que {1} : pas de retour en arrière (les migrations ne vont que vers l'avant).",
  "Update refused: {0}. Nothing was run.": "Mise à jour refusée : {0}. Rien n'a été exécuté.",
  "install.sh {0}: sha256 and cosign signature verified.": "install.sh {0} : sha256 et signature cosign vérifiés.",
  "install.sh {0}: sha256 verified; signature NOT verified (cosign is not installed).":
    "install.sh {0} : sha256 vérifié ; signature NON vérifiée (cosign n'est pas installé).",
  "Release {0} publishes no install.sh: updating through the compose file.":
    "La release {0} ne publie pas d'install.sh : mise à jour par le fichier compose.",

  // backup / restore
  "update --version expects a version like 1.2.3": "update --version attend une version comme 1.2.3",
  "--to expects a folder or s3://bucket/prefix": "--to attend un dossier ou s3://bucket/préfixe",
  "--keep expects an integer ≥ 0": "--keep attend un entier ≥ 0",
  "{0} only applies to nokker {1}": "{0} ne s'applique qu'à nokker {1}",
  "backup list only takes --to": "backup list ne prend que --to",
  "restore expects a backup file or s3://… (nokker backup list)": "restore attend un fichier de sauvegarde ou s3://… (nokker backup list)",
  "Backups to S3 are always encrypted (they hold the secrets of the install): add --encrypt.":
    "Les sauvegardes vers S3 sont toujours chiffrées (elles contiennent les secrets de l'installation) : ajoute --encrypt.",
  "backup.sh not found ({0}): rerun install.sh, or update with nokker update.":
    "backup.sh introuvable ({0}) : relance install.sh, ou mets à jour avec nokker update.",
  "--keep only prunes folder backups: it is ignored for S3.": "--keep ne purge que les sauvegardes dans un dossier : ignoré pour S3.",
  "restore replaces the data of the install: confirm with --yes (no terminal to ask).":
    "restore remplace les données de l'installation : confirme avec --yes (pas de terminal pour demander).",
  "Replace the data of {0} with the backup {1}? [y/N] ": "Remplacer les données de {0} par la sauvegarde {1} ? [o/N] ",
  "Restore cancelled: nothing was changed.": "Restauration annulée : rien n'a été modifié.",
  "A passphrase is required and there is no terminal to ask for it: set {0}.":
    "Une phrase de passe est requise et aucun terminal ne permet de la demander : définis {0}.",
  "Backup passphrase: ": "Phrase de passe de la sauvegarde : ",
  "Empty passphrase: nothing was done.": "Phrase de passe vide : rien n'a été fait.",
  "Passphrase again: ": "Phrase de passe, à nouveau : ",
  "The two passphrases differ: nothing was done.": "Les deux phrases de passe diffèrent : rien n'a été fait.",
  "Keep this passphrase safe: without it the backup cannot be restored.":
    "Garde cette phrase de passe en lieu sûr : sans elle, la sauvegarde ne peut pas être restaurée.",
  "{0} not found: cannot run backup.sh.": "{0} introuvable : impossible de lancer backup.sh.",
  "backup.sh did not finish in time.": "backup.sh ne s'est pas terminé à temps.",

  // logs
  "Kernel logs unavailable: {0}.\nThe client log is still readable: nokker logs --component cli":
    "Logs du noyau indisponibles : {0}.\nLe journal du client reste lisible : nokker logs --component cli",
  "docker is not installed (or not in PATH): cannot read the kernel logs.\nThe client log is still readable: nokker logs --component cli":
    "docker n'est pas installé (ou pas dans le PATH) : impossible de lire les logs du noyau.\nLe journal du client reste lisible : nokker logs --component cli",
  "The docker daemon does not respond ({0}): cannot read the kernel logs.": "Le démon docker ne répond pas ({0}) : impossible de lire les logs du noyau.",
  "docker compose logs failed (code {0}).": "docker compose logs a échoué (code {0}).",
  "No client log yet ({0}).": "Pas encore de journal client ({0}).",

  // lokkal.json
  "lokkal.json is not a JSON object": "lokkal.json n'est pas un objet JSON",
  "lokkal.json: missing or empty key(s): {0} (rerun install.sh)": "lokkal.json : clé(s) manquante(s) ou vide(s) : {0} (relance install.sh)",
  "lokkal.json: non-absolute path(s): {0}": "lokkal.json : chemin(s) non absolu(s) : {0}",
  "lokkal.json: {0} must be a non-empty string": "lokkal.json : {0} doit être une chaîne non vide",
  "lokkal.json: wsl_distro is set but install_dir is missing (Linux path of ~/.nokker)":
    "lokkal.json : wsl_distro présent mais install_dir manquant (chemin Linux de ~/.nokker)",
  "lokkal.json: under WSL, {0} must be Linux paths (/…)": "lokkal.json : sous WSL, {0} doivent être des chemins Linux (/…)",
  "{0} is not valid JSON": "{0} n'est pas un JSON valide",
  "no Lokkal installed (~/.config/nokker/lokkal.json is missing — written by install.sh)":
    "aucun Lokkal installé (~/.config/nokker/lokkal.json absent — écrit par install.sh)",
  "compose not found ({0})": "compose introuvable ({0})",

  // coffre
  "OpenBao does not respond (docker compose -p {0} ps openbao)": "OpenBao ne répond pas (docker compose -p {0} ps openbao)",
  "OpenBao is not initialised (rerun install.sh with the vault profile)": "OpenBao n'est pas initialisé (relance install.sh avec le profil vault)",
  "vault sealed: docker compose -p {0} exec openbao bao operator unseal": "coffre scellé : docker compose -p {0} exec openbao bao operator unseal",
  "vault-unseal does not unseal: docker compose -p {0} logs vault-unseal": "vault-unseal ne descelle pas : docker compose -p {0} logs vault-unseal",
  "install_dir is missing from lokkal.json: AppRole credentials not found": "install_dir absent de lokkal.json : identifiants AppRole introuvables",
  "AppRole credentials missing or empty: {0} (in {1})": "identifiants AppRole absents ou vides : {0} (dans {1})",
  "OpenBao initialised and unsealed, AppRole credentials in place": "OpenBao initialisé et descellé, identifiants AppRole en place",

  // authentification, mode non interactif
  "Device not confirmed (timed out) — rerun nokker once the code is confirmed.":
    "Appareil non confirmé (délai dépassé) — relance nokker une fois le code confirmé.",
  "no rule covers this effect: refused by default (non-interactive mode)": "aucune règle ne couvre cet effet : refusé par défaut (mode non interactif)",

  // pont ACP
  "Cost of the session and of the day (no model call)": "Coût de la session et du jour (sans appel modèle)",
  "Diff since the last checkpoint (no model call)": "Diff depuis le dernier point de retour (sans appel modèle)",
  "Plan of the thread (no model call)": "Plan du fil (sans appel modèle)",
  "Checkpoints of the thread (no model call)": "Points de retour du fil (sans appel modèle)",
  "Sub-agent started: {0}": "Sous-agent lancé : {0}",
  "Sub-agent finished ({0}): {1} commit(s)": "Sous-agent terminé ({0}) : {1} commit(s)",
  "Sub-agent finished ({0})": "Sous-agent terminé ({0})",
  "Image not read: the model has no vision.": "Image non lue : le modèle n'a pas la vision.",
  "Approved: run by the kernel.": "Approuvée : exécutée par le noyau.",
  "Run failed.": "Échec de l'exécution.",
  "Card expired: not run.": "Carte expirée : non exécutée.",
  "Rejected: not run.": "Refusée : non exécutée.",
  "terminal: {0}": "terminal : {0}",
  "\n{0}:\n```\n{1}\n```\n": "\n{0} :\n```\n{1}\n```\n",
  "At most {0} images per message": "{0} images au plus par message",
  "local token rejected by the kernel (nokker doctor)": "jeton local refusé par le noyau (nokker doctor)",
  "folder {0} is in the WSL distribution {1}, but Lokkal runs in {2}: open the project in {2}":
    "le dossier {0} est dans la distribution WSL {1}, mais Lokkal tourne dans {2} : ouvrez le projet dans {2}",
  "folder {0} is on the Windows drive {1} ({2} in WSL), outside the roots declared in Lokkal: open the project inside WSL (\\\\wsl.localhost\\{3}\\home\\<you>\\<project>)":
    "le dossier {0} est sur le disque Windows {1} ({2} dans WSL), hors des racines déclarées de Lokkal : ouvrez le projet dans WSL (\\\\wsl.localhost\\{3}\\home\\<vous>\\<projet>)",
  "folder outside the roots declared in Lokkal: {0} ({1})": "dossier hors des racines déclarées de Lokkal : {0} ({1})",
  "kernel unreachable (is Lokkal running? nokker doctor)": "noyau injoignable (Lokkal tourne-t-il ? nokker doctor)",
  "unknown session: {0}": "session inconnue : {0}",
  "cwd missing": "cwd absent",
  "sessionId and cwd required": "sessionId et cwd requis",
  "unknown local session: {0}": "session locale inconnue : {0}",
  "prompt missing": "prompt absent",
  "{0}: {1}": "{0} : {1}",
  "{0} ({1} turn(s))": "{0} ({1} tour(s))",
  "no turns": "aucun tour",
  "Session: {0}\nDay (UTC {1}): {2} ({3} turn(s))": "Session : {0}\nJour (UTC {1}) : {2} ({3} tour(s))",
  "Action to approve in the thread.": "Action à approuver dans le fil.",
  "No plan on this thread.": "Aucun plan sur ce fil.",
  "{0}. `{1}` {2} — {3} ({4} file(s))": "{0}. `{1}` {2} — {3} ({4} fichier(s))",
  "No checkpoints on this thread.": "Aucun point de retour sur ce fil.",
  "A turn is in progress, try again afterwards.": "Un tour est en cours, réessayez après.",
  "Not available on this server.": "Non disponible sur ce serveur.",
  "Error: {0}": "Erreur : {0}",
  "connection closed": "connexion fermée",
  "unreadable JSON": "JSON illisible",
  "unknown method: {0}": "méthode inconnue : {0}",
  "local token not found: is Lokkal installed and running? (nokker doctor)": "jeton local introuvable : Lokkal est-il installé et démarré ? (nokker doctor)",
  "no session for {0}: first run {1} --server {0} in a terminal": "aucune session pour {0} : lance d'abord {1} --server {0} dans un terminal",

  // import
  "take over another agent's install: the kernel lists what it reads, those paths are mounted read-only (never credentials or identity files) into a one-off container; dry run, then --apply writes after confirmation; --project (claude-code, cursor) also reads a repository. Not followed: a custom home folder of a compatible agent, an OpenClaw agents.defaults.workspace outside ~/.openclaw":
    "reprendre l'installation d'un autre agent : le noyau liste ce qu'il lit, ces chemins sont montés en lecture seule (jamais les identifiants ni l'identité) dans un conteneur jetable ; à blanc, puis --apply écrit après confirmation ; --project (claude-code, cursor) lit aussi un dépôt. Non suivis : un dossier personnel personnalisé d'un agent compatible, un agents.defaults.workspace d'OpenClaw hors de ~/.openclaw",
  "import expects one of: {0}": "import attend l'une de ces sources : {0}",
  "--project expects the root folder of a repository": "--project attend le dossier racine d'un dépôt",
  "--project only applies to {0}: {1} reads nothing in a project.": "--project ne vaut que pour {0} : {1} ne lit rien dans un projet.",
  "--project: {0} is not a folder.": "--project : {0} n'est pas un dossier.",
  "--project: {0} is (or contains) the home folder: give the root of a repository.": "--project : {0} est (ou contient) le dossier personnel : donnez la racine d'un dépôt.",
  "--project: {0} contains a colon: it cannot be mounted.": "--project : {0} contient un deux-points : il ne peut pas être monté.",
  "import --apply writes to the state of Nokker: confirm with --yes (no terminal to ask).":
    "import --apply écrit dans l'état de Nokker : confirmez avec --yes (pas de terminal pour poser la question).",
  "Cannot import: {0}.": "Import impossible : {0}.",
  "nokker import is not available under WSL yet: run it from a shell inside the {0} distribution.":
    "nokker import n'est pas encore disponible sous WSL : lancez-le depuis un shell dans la distribution {0}.",
  "The home folder {0} contains a colon: it cannot be mounted.": "Le dossier personnel {0} contient un deux-points : il ne peut pas être monté.",
  "{0} not found: cannot run the kernel container.": "{0} introuvable : impossible de lancer le conteneur du noyau.",
  "The kernel did not list the paths in time.": "Le noyau n'a pas listé les chemins à temps.",
  "The kernel does not know --list-paths {0} (exit code 2): it may predate it, try nokker update.":
    "Le noyau ne connaît pas --list-paths {0} (code 2) : il est peut-être antérieur, essayez nokker update.",
  "The kernel could not list the paths to import (exit code {0}): {1}": "Le noyau n'a pas pu lister les chemins à importer (code {0}) : {1}",
  "no message": "aucun message",
  "Invalid answer from the kernel to --list-paths (one JSON line {source, paths:[{path, kind}], project_paths} expected): {0}":
    "Réponse invalide du noyau à --list-paths (une ligne JSON {source, paths:[{path, kind}], project_paths} attendue) : {0}",
  "empty output": "sortie vide",
  "absolute path": "chemin absolu",
  "contains ..": "contient ..",
  "character not allowed in a mount": "caractère interdit dans un montage",
  "credentials or identity file": "fichier d'identifiants ou d'identité",
  "empty path": "chemin vide",
  "symbolic link leading outside its root folder": "lien symbolique qui sort de son dossier racine",
  "symbolic link to a credentials or identity file": "lien symbolique vers un fichier d'identifiants ou d'identité",
  "expected a file, found a folder": "fichier attendu, dossier trouvé",
  "expected a folder, found a file": "dossier attendu, fichier trouvé",
  "folder too large to check, or holding a link to a credentials file": "dossier trop gros pour être contrôlé, ou contenant un lien vers des identifiants",
  "✗ refused: {0} ({1})": "✗ refusé : {0} ({1})",
  "Not on this machine, ignored: {0}": "Absent de cette machine, ignoré : {0}",
  "Nothing to import from {0} on this machine: no container was started.": "Rien à importer de {0} sur cette machine : aucun conteneur lancé.",
  "Mounted read-only into a one-off kernel container (never copied or shown here):": "Monté en lecture seule dans un conteneur jetable du noyau (jamais copié ni affiché ici) :",
  "hidden (credentials): {0}": "masqué (identifiants) : {0}",
  "Report and imported data go to the kernel state: {0} → {1}": "Le rapport et les données importées vont dans l'état du noyau : {0} → {1}",
  "Report: {0}": "Rapport : {0}",
  "Dry run (nothing is written):": "À blanc (rien n'est écrit) :",
  "The dry run failed: nothing was written.": "L'essai à blanc a échoué : rien n'a été écrit.",
  "No terminal: MCP servers found by the import will not be added (the kernel asks for each one on a terminal).":
    "Pas de terminal : les serveurs MCP trouvés par l'import ne seront pas ajoutés (le noyau demande chacun sur un terminal).",
  "Apply this import to the state of Nokker? [y/N] ": "Appliquer cet import à l'état de Nokker ? [o/N] ",
  "Import cancelled: nothing was written.": "Import annulé : rien n'a été écrit.",
  "Applying the import…": "Application de l'import…",
  "The import did not finish in time.": "L'import ne s'est pas terminé à temps.",
  "{0} is not a plain folder (link or file): it cannot be mounted for writing.": "{0} n'est pas un simple dossier (lien ou fichier) : il ne peut pas être monté en écriture.",
  "{0} is too large to check for credentials files (or holds a link to one): it cannot be mounted for writing.":
    "{0} est trop gros pour y chercher des fichiers d'identifiants (ou contient un lien vers l'un d'eux) : il ne peut pas être monté en écriture.",
  "--apply will write:": "--apply écrira :",
  "{0} (kernel state: skills, settings, MCP servers, memory, report)": "{0} (état du noyau : skills, réglages, serveurs MCP, mémoire, rapport)",
  "{0}/ (repository skills and hooks) → {1}, read-write{2}": "{0}/ (skills et hooks du dépôt) → {1}, en écriture{2}",
  " (created)": " (créé)",
  "{0} (only if it does not exist: written to a temporary folder, then copied)": "{0} (seulement s'il n'existe pas : écrit dans un dossier temporaire, puis recopié)",
  "NOKKER.md written: {0}": "NOKKER.md écrit : {0}",
};
