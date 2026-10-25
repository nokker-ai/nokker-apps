/**
 * Analyse des commandes slash de la CLI — pur, sans Ink ni réseau : testable directement en vitest
 * (`test/commands.test.ts`). `ui/App.tsx` ne fait qu'appeler `parseSlashCommand` puis exécuter l'effet
 * réseau correspondant ; toute la logique de découpage/alias vit ici pour rester testable isolément.
 */
import { t } from "./i18n/index.js";

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
  | { kind: "skillsTrust" }
  | { kind: "plan" }
  | { kind: "agents"; action: "list" | "view" | "cancel"; id: string | null }
  | { kind: "memory"; action: "list" | "view" | "forget"; name: string | null }
  | { kind: "cost" }
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

/** Lignes de l'aide : commande, description (traduite à l'affichage). */
function helpRows(): Array<[string, string]> {
  return [
    ["/sessions [query]", t("code sessions (folders); with a query, switch to the matching one")],
    ["/threads", t("all threads")],
    ["/goto <session>", t("switch straight to a thread")],
    ["/thread [title]", t("new permanent thread (not /new: the core's /new marks an episode boundary)")],
    ["/diff [hash]", t("diff since a checkpoint (the latest by default), in green/red")],
    ["/checkpoints", t("checkpoints: short hash, time, reason, files")],
    ["/rollback [hash|n]", t("go back to a checkpoint (the latest by default); “Action to approve” card")],
    ["/skills [name]", t("skills by family, and the trust state of this repository's skills; with a name, its content")],
    ["/skills trust", t("trust this repository's skills (card: root, count, fingerprint)")],
    ["/plan", t("session plan (todo) with the state of each step")],
    ["/agents [id]", t("sub-agents of the thread (background ones included): state, last tool, duration, result")],
    ["/agents cancel <id|all>", t("stop a background sub-agent (all: every sub-agent of the thread)")],
    ["/memory [note]", t("what the project memory knows: learned notes and instruction file sections; with a name, the note")],
    ["/memory forget <note>", t("forget a learned note (after confirmation)")],
    ["/cost", t("session and day cost: tokens, and the amount when the model has a price")],
    ["", t("(diff, checkpoints, rollback, skills, plan, agents, memory: code session only)")],
    ["/cancel", t("cancel the turn in progress (Esc too)")],
    ["/out", t("expand/collapse the preview of the last tool call (key o too)")],
    ["/tools", t("expand/collapse all previews")],
    ["/bubbles", t("open bubbles of this thread")],
    ["/bubble <id|title>", t("bubble details")],
    ["/send <bubble> <session> [--copy]", t("move (or copy with --copy) a bubble to another thread")],
    ["/ask <session> <text>", t("ask another session a question (answer here, as a notify bubble)")],
    ["/approvals", t("approval cards")],
    ["/confirm <TOTP code>", t("confirm this device while it is pending")],
    ["/login", t("sign in again")],
    ["/help", t("this help")],
    ["/quit", t("quit")],
  ];
}

/** Texte de `/help`, dans la langue de l'interface. */
export function helpText(): string {
  const rows = helpRows();
  const width = Math.max(...rows.map(([c]) => c.length)) + 2;
  const lines = rows.map(([c, d]) => (c ? `  ${c.padEnd(width)}${d}` : `  ${d}`));
  return [t("Commands:"), ...lines, t("Esc cancels the turn in progress; Ctrl+C rejects the card on screen (and cancels the turn), otherwise quits.")].join("\n");
}

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
    case "skills": {
      const arg = rest.split(/\s+/)[0] || null;
      return arg === "trust" ? { kind: "skillsTrust" } : { kind: "skills", name: arg };
    }
    case "plan":
      return { kind: "plan" };
    case "agents": {
      const [a, b] = rest.split(/\s+/).filter(Boolean);
      if (a === "cancel" || a === "stop") return { kind: "agents", action: "cancel", id: b ?? null };
      return a ? { kind: "agents", action: "view", id: a } : { kind: "agents", action: "list", id: null };
    }
    case "memory": {
      const [a, b] = rest.split(/\s+/).filter(Boolean);
      if (a === "forget") return { kind: "memory", action: "forget", name: b ?? null };
      return a ? { kind: "memory", action: "view", name: a } : { kind: "memory", action: "list", name: null };
    }
    case "cost":
      return { kind: "cost" };
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
