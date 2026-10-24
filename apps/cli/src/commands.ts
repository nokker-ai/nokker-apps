/**
 * Analyse des commandes slash de la CLI — pur, sans Ink ni réseau : testable directement en vitest
 * (`test/commands.test.ts`). `ui/App.tsx` ne fait qu'appeler `parseSlashCommand` puis exécuter l'effet
 * réseau correspondant ; toute la logique de découpage/alias vit ici pour rester testable isolément.
 */

export type SlashCommand =
  | { kind: "sessions"; query: string | null }
  | { kind: "threads" }
  | { kind: "goto"; query: string }
  | { kind: "thread"; title: string | null }
  | { kind: "renamedNew" }
  | { kind: "diff"; hash: string | null }
  | { kind: "checkpoints" }
  | { kind: "rollback"; target: string | null }
  | { kind: "skills"; name: string | null }
  | { kind: "plan" }
  | { kind: "agents" }
  | { kind: "cancel" }
  | { kind: "out" }
  | { kind: "confirm"; totp: string }
  | { kind: "bubbles" }
  | { kind: "bubble"; id: string }
  | { kind: "send"; bubble: string; session: string; copy: boolean }
  | { kind: "ask"; session: string; text: string }
  | { kind: "approvals" }
  | { kind: "login" }
  | { kind: "tools" }
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "empty" }
  | { kind: "unknown"; name: string };

/** Découpe respectueuse des guillemets doubles (`"fil avec espaces"`), comme un shell très simplifié —
 * utile pour `/send`/`/bubble` dont les identifiants peuvent être un titre de fil/bulle. */
export function tokenize(rest: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(rest))) tokens.push(m[1] ?? m[2] ?? "");
  return tokens;
}

export const HELP_TEXT = `Commandes :
  /sessions [requête]                 sessions de code (dossiers) ; avec une requête, bascule sur celle qui correspond
  /threads                            tous les fils
  /goto <session>                     bascule directement sur un fil
  /thread [titre]                     nouveau fil permanent (ce n'est pas /new : celui du noyau pose une frontière d'épisode)
  /diff [hash]                        diff depuis un point de retour (le dernier par défaut), en vert/rouge
  /checkpoints                        points de retour : hash court, heure, raison, fichiers
  /rollback [hash|n]                  revient à un point de retour (le dernier par défaut) ; carte « Action à approuver »
  /skills [nom]                       skills par famille ; avec un nom, son contenu
  /plan                               plan de la session (todo) avec l'état de chaque étape
  /agents                             sous-agents du fil : but, état, dernier outil, durée
  (diff, checkpoints, rollback, skills, plan, agents : session de code seulement)
  /cancel                             annule le tour en cours (Échap aussi)
  /out                                déplie/replie l'aperçu du dernier appel d'outil (touche o aussi)
  /tools                              déplie/replie tous les aperçus
  /bubbles                            bulles ouvertes de ce fil
  /bubble <id|titre>                  détail d'une bulle
  /send <bulle> <session> [--copy]    déplace (ou copie avec --copy) une bulle vers un autre fil
  /ask <session> <texte>              pose une question à une autre session (réponse ici, par bulle notify)
  /approvals                          cartes d'approbation
  /confirm <code TOTP>                confirme cet appareil quand il est en attente
  /login                              reconnexion
  /help                                cette aide
  /quit                                sortir
Échap annule le tour en cours ; Ctrl+C refuse la carte affichée (et annule le tour), sinon quitte.`;

/** `line` commence par `/` (vérifié par l'appelant, comme pour tout texte libre démarrant par `/`). */
export function parseSlashCommand(line: string): SlashCommand {
  const trimmed = line.trim();
  if (trimmed === "/" || trimmed === "") return { kind: "empty" };
  const spaceIdx = trimmed.indexOf(" ");
  const name = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (name) {
    case "sessions":
      return { kind: "sessions", query: rest || null };
    case "threads":
      return { kind: "threads" };
    case "goto":
      return { kind: "goto", query: rest };
    case "thread":
      return { kind: "thread", title: rest || null };
    case "new":
      return { kind: "renamedNew" };
    case "diff":
      return { kind: "diff", hash: rest.split(/\s+/)[0] || null };
    case "checkpoints":
      return { kind: "checkpoints" };
    case "rollback":
      return { kind: "rollback", target: rest.split(/\s+/)[0] || null };
    case "skills":
      return { kind: "skills", name: rest.split(/\s+/)[0] || null };
    case "plan":
      return { kind: "plan" };
    case "agents":
      return { kind: "agents" };
    case "cancel":
      return { kind: "cancel" };
    case "out":
      return { kind: "out" };
    case "confirm":
      return { kind: "confirm", totp: rest };
    case "bubbles":
      return { kind: "bubbles" };
    case "bubble": {
      const [id] = tokenize(rest);
      return { kind: "bubble", id: id ?? "" };
    }
    case "send": {
      const tokens = tokenize(rest);
      const copy = tokens.includes("--copy");
      const positional = tokens.filter((t) => t !== "--copy");
      return { kind: "send", bubble: positional[0] ?? "", session: positional[1] ?? "", copy };
    }
    case "ask": {
      // Pas de guillemets ici : le texte libre qui suit le nom de session n'est jamais entre quotes,
      // donc le nom de session doit être un seul mot (id `th_…` ou titre sans espace — limite documentée).
      const [session, ...words] = rest.split(/\s+/).filter(Boolean);
      return { kind: "ask", session: session ?? "", text: words.join(" ") };
    }
    case "approvals":
      return { kind: "approvals" };
    case "login":
      return { kind: "login" };
    case "tools":
      return { kind: "tools" };
    case "help":
    case "?":
      return { kind: "help" };
    case "quit":
    case "exit":
      return { kind: "quit" };
    default:
      return { kind: "unknown", name };
  }
}
