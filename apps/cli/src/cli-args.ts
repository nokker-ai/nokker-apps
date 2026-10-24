/**
 * Analyse des arguments de ligne de commande — pur (pas de `process.exit`, pas d'I/O), testable
 * directement. `bin.ts` n'en fait qu'un appel puis bascule entre mode interactif (Ink), mode
 * non-interactif (`-p`/`--print`) et sous-commandes (`doctor`, `logs`, `update`).
 */

export type Subcommand = "doctor" | "logs" | "update" | null;

export interface ParsedArgs {
  serverUrl: string;
  /** `true` si `--server` ou `$NOKKER_SERVER_URL` a été donné explicitement. */
  serverExplicit: boolean;
  /** `null` = mode interactif. Sinon : le texte à envoyer en mode non-interactif (`nokker -p "…"`). */
  print: string | null;
  /** Sortie machine (`{reply, thread_id, pending_approvals, refused}` / `{error}`) au lieu de texte brut. */
  json: boolean;
  /** Sonnette terminal (BEL) sur chaque bulle — coupée par défaut (mémoire `feedback-nokker-ui-bulles` :
   * « le son DOIT être désactivable, sinon ça va saouler les gens au travail »). */
  sound: boolean;
  help: boolean;
  /** `--version` : affiche la version du client et sort. */
  version: boolean;
  /** Sous-commande (`nokker doctor`…), `null` = session. */
  command: Subcommand;
  /** doctor : relance ce qui peut l'être. */
  fix: boolean;
  /** logs : suivre. */
  follow: boolean;
  /** logs : nombre de lignes (défaut 100). */
  lines: number;
  /** logs : fenêtre (`1h`, `30m`, `2d`). */
  since: string | null;
  /** logs : `core` (défaut) ou `cli`. */
  component: "core" | "cli";
  /** update : comparer les digests sans rien télécharger. */
  check: boolean;
  /** Erreur d'usage à afficher (valeur invalide…), sinon `null`. */
  error: string | null;
}

/** Port du noyau Lokkal (8642 = ancienne passerelle ; le mock de dev tourne sur 4310, à passer par `--server`). */
export const DEFAULT_SERVER_URL = "http://127.0.0.1:8742";

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): ParsedArgs {
  let serverUrl = env.NOKKER_SERVER_URL ?? DEFAULT_SERVER_URL;
  let serverExplicit = env.NOKKER_SERVER_URL !== undefined;
  let print: string | null = null;
  let json = false;
  let sound = false;
  let help = false;
  let version = false;
  let command: Subcommand = null;
  let fix = false;
  let follow = false;
  let lines = 100;
  let since: string | null = null;
  let component: "core" | "cli" = "core";
  let check = false;
  let error: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "doctor" || arg === "logs" || arg === "update") && command === null) {
      command = arg; // sous-commande, avant ou après --server
    } else if (arg === "--server") {
      serverUrl = argv[++i] ?? serverUrl;
      serverExplicit = true;
    } else if (arg === "-p" || arg === "--print") {
      print = argv[++i] ?? "";
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--sound") {
      sound = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "-V" || arg === "--version") {
      version = true;
    } else if (arg === "--fix") {
      fix = true;
    } else if (arg === "-f" || arg === "--follow") {
      follow = true;
    } else if (arg === "-n" || arg === "--lines") {
      const n = Number(argv[++i]);
      if (Number.isInteger(n) && n > 0) lines = n;
      else error = "-n attend un entier positif";
    } else if (arg === "--since") {
      const v = argv[++i] ?? "";
      if (/^\d+[smhd]$/.test(v)) since = v;
      else error = "--since attend une durée comme 30m, 1h ou 2d";
    } else if (arg === "--component") {
      const v = argv[++i];
      if (v === "core" || v === "cli") component = v;
      else error = "--component attend core ou cli";
    } else if (arg === "--check") {
      check = true;
    } else {
      error ??= `argument inconnu : ${arg} (nokker --help)`;
    }
  }
  return { serverUrl, serverExplicit, print, json, sound, help, version, command, fix, follow, lines, since, component, check, error };
}
