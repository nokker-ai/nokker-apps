/**
 * Règles de permission locales (LOKKAL.md §7.4, complément noyau du 23.10) — pures, sans I/O.
 * Une règle = `outil` ou `outil(motif)` ; motif = glob fnmatch SENSIBLE À LA CASSE, comparé à la
 * commande entière (après strip) pour `terminal`, au `path` normalisé (posixpath.normpath) pour
 * `write_file` / `read_file` / `patch` (mode replace). Partagé par le mock (qui relit le fichier de
 * réglages) et la CLI (qui montre la règle exacte avant de valider « toujours »).
 */

export type PermissionMode = "default" | "accept_edits" | "auto" | "plan";

export interface PermissionSettings {
  mode?: PermissionMode;
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

/** `posixpath.normpath` : « ./src/a.py » → « src/a.py », « a//b/../c » → « a/c ». */
export function normpath(p: string): string {
  if (!p) return ".";
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
    } else out.push(part);
  }
  const joined = out.join("/");
  return abs ? `/${joined}` : joined || ".";
}

/** fnmatch (sensible à la casse) : `*` (y compris `/`), `?`, `[seq]`, `[!seq]`. */
export function fnmatch(name: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const j = pattern.indexOf("]", i + 2);
      if (j === -1) re += "\\[";
      else {
        let set = pattern.slice(i + 1, j);
        if (set.startsWith("!")) set = `^${set.slice(1)}`;
        re += `[${set.replace(/\\/g, "\\\\")}]`;
        i = j;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s").test(name);
}

/** Clé de comparaison d'un appel : commande pour `terminal`, chemin normalisé pour les outils fichier. */
export function callSubject(tool: string, args: Record<string, unknown>): string | null {
  if (tool === "terminal") return typeof args.command === "string" ? args.command.trim() : null;
  if (typeof args.path === "string") return normpath(args.path);
  return null;
}

export function parseRule(rule: string): { tool: string; pattern: string | null } | null {
  const m = rule.trim().match(/^([A-Za-z_][\w.-]*)(?:\((.*)\))?$/s);
  return m ? { tool: m[1]!, pattern: m[2] ?? null } : null;
}

export function matchRule(rule: string, tool: string, args: Record<string, unknown>): boolean {
  const r = parseRule(rule);
  if (!r || r.tool !== tool) return false;
  if (r.pattern === null) return true;
  const subject = callSubject(tool, args);
  return subject !== null && fnmatch(subject, r.pattern);
}

export function matchesAny(rules: readonly string[] | undefined, tool: string, args: Record<string, unknown>): boolean {
  return (rules ?? []).some((r) => matchRule(r, tool, args));
}

/** Échappe les métacaractères fnmatch d'un littéral (`*`, `?`, `[`). */
function escapeGlob(s: string): string {
  return s.replace(/[*?[]/g, (c) => `[${c}]`);
}

/**
 * Règles que « Toujours » peut écrire pour cet appel, la première étant le défaut :
 * terminal → `terminal(<commande exacte>)` puis `terminal(<2 premiers mots>*)` ; fichier →
 * `write_file(<chemin>)` / `patch(<chemin>)`, puis `patch(<dossier>/**)` pour un chemin dans un dossier.
 */
export function suggestRules(tool: string, args: Record<string, unknown>): string[] {
  const subject = callSubject(tool, args);
  if (subject === null) return [tool];
  const rules = [`${tool}(${escapeGlob(subject)})`];
  if (tool === "terminal") {
    const words = subject.split(/\s+/).filter(Boolean);
    if (words.length > 2) rules.push(`terminal(${escapeGlob(words.slice(0, 2).join(" "))}*)`);
    else if (words.length === 2) rules.push(`terminal(${escapeGlob(words[0]!)} *)`);
  } else {
    const dir = subject.includes("/") ? subject.slice(0, subject.lastIndexOf("/")) : "";
    if (dir) rules.push(`${tool}(${escapeGlob(dir)}/**)`);
  }
  return [...new Set(rules)];
}

export type RuleVerdict = "allow" | "ask" | "deny";

/**
 * Ordre du noyau : deny, puis plan (refuse tout effet non lecture), puis ask, puis allow, puis le mode
 * (défaut `accept_edits` : écritures de fichiers sans carte, `terminal` toujours avec carte ; `auto` : tout sauf destructif).
 * Une commande « hardline » n'arrive jamais ici : refus direct, sans carte.
 * `ask` = la carte est émise ; `deny` = refus sans carte.
 */
export function decide(
  settings: PermissionSettings,
  tool: string,
  args: Record<string, unknown>,
  effect: string,
): RuleVerdict {
  if (matchesAny(settings.deny, tool, args)) return "deny";
  if (settings.mode === "plan" && effect !== "read") return "deny";
  if (matchesAny(settings.ask, tool, args)) return "ask";
  if (matchesAny(settings.allow, tool, args)) return "allow";
  if (effect === "read") return "allow";
  // Mode par défaut d'une session locale : accept_edits — write_file/patch dans le dossier passent sans carte ;
  // `terminal` (même WRITE : tests, build) et tout effet non lecture demandent une carte.
  const mode = settings.mode ?? "accept_edits";
  if (mode === "auto") return effect === "destructive" ? "ask" : "allow";
  if (mode === "accept_edits" && effect === "write" && tool !== "terminal") return "allow";
  return "ask";
}
