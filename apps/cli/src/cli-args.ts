/**
 * Analyse des arguments de ligne de commande — pur (pas de `process.exit`, pas d'I/O), testable
 * directement. `bin.ts` n'en fait qu'un appel puis bascule entre mode interactif (Ink), mode
 * non-interactif (`-p`/`--print`) et sous-commandes (`doctor`, `logs`, `update`, `backup`, `restore`, `import`, `acp`).
 */
import { parseLang, t, type Lang } from "./i18n/index.js";
import { IMPORT_SOURCES, PROJECT_SOURCES, type ImportSource } from "./import.js";

export type Subcommand = "doctor" | "logs" | "update" | "backup" | "restore" | "import" | "acp" | null;
const SUBCOMMANDS = ["doctor", "logs", "update", "backup", "restore", "import", "acp"] as const;

export interface ParsedArgs {
  serverUrl: string;
  /** `true` si `--server` ou `$NOKKER_SERVER_URL` a été donné explicitement. */
  serverExplicit: boolean;
  /** `null` = mode interactif. Sinon : le texte à envoyer en mode non-interactif (`nokker -p "…"`). */
  print: string | null;
  /** Sortie machine (`{reply, thread_id, pending_approvals, refused}` / `{error}`) au lieu de texte brut. */
  json: boolean;
  /** Sonnette terminal (BEL) sur chaque bulle — coupée par défaut (choix produit : le son doit
   * rester désactivable). */
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
  /** update : `--version X.Y.Z` (version cible), sinon la dernière release. */
  targetVersion: string | null;
  /** backup : `nokker backup list` liste les sauvegardes au lieu d'en faire une. */
  backupList: boolean;
  /** backup / backup list : `--to <dossier|s3://…>`. */
  to: string | null;
  /** backup : `--keep N` (sauvegardes locales gardées). */
  keep: number | null;
  /** backup : `--encrypt`. */
  encrypt: boolean;
  /** restore, import --apply : `--yes` (pas de confirmation). */
  yes: boolean;
  /** restore : archive (`<fichier>` ou `s3://…`). */
  source: string | null;
  /** import : source (`claude-code`, `cursor`, `hermes`, `openclaw`). */
  importSource: ImportSource | null;
  /** import : `--project <dossier>` (claude-code, cursor). */
  project: string | null;
  /** import : `--apply` (écrire après le rapport à blanc). */
  apply: boolean;
  /** `--lang en|fr` : langue de l'interface (sinon `NOKKER_LANG`, `LC_ALL`, `LC_MESSAGES`, `LANG`). */
  lang: Lang | null;
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
  let targetVersion: string | null = null;
  let backupList = false;
  let to: string | null = null;
  let keep: number | null = null;
  let encrypt = false;
  let yes = false;
  let source: string | null = null;
  let importSource: ImportSource | null = null;
  let importArg: string | null = null;
  let apply = false;
  let project: string | null = null;
  const only: Array<[string, Subcommand[]]> = [];
  let error: string | null = null;
  let lang: Lang | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((SUBCOMMANDS as readonly string[]).includes(arg ?? "") && command === null) {
      command = arg as Subcommand; // sous-commande, avant ou après --server
    } else if (command === "backup" && arg === "list" && !backupList) {
      backupList = true;
    } else if (command === "restore" && source === null && arg !== undefined && !arg.startsWith("-")) {
      source = arg;
    } else if (command === "import" && importArg === null && arg !== undefined && !arg.startsWith("-")) {
      importArg = arg;
      if ((IMPORT_SOURCES as readonly string[]).includes(arg)) importSource = arg as ImportSource;
      else error ??= t("import expects one of: {0}", IMPORT_SOURCES.join(", "));
    } else if (arg === "--project") {
      const v = argv[++i];
      if (v && !v.startsWith("-")) project = v;
      else error ??= t("--project expects the root folder of a repository");
      only.push([arg, ["import"]]);
    } else if (arg === "--apply") {
      apply = true;
      only.push([arg, ["import"]]);
    } else if (arg === "--version" && command === "update") {
      // `nokker update --version X.Y.Z` : version cible (ailleurs, --version affiche celle du client)
      const v = argv[++i] ?? "";
      if (/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/.test(v)) targetVersion = v;
      else error = t("update --version expects a version like 1.2.3");
    } else if (arg === "--to") {
      const v = argv[++i];
      if (v) to = v;
      else error = t("--to expects a folder or s3://bucket/prefix");
      only.push([arg, ["backup"]]);
    } else if (arg === "--keep") {
      const n = Number(argv[++i]);
      if (Number.isInteger(n) && n >= 0) keep = n;
      else error = t("--keep expects an integer ≥ 0");
      only.push([arg, ["backup"]]);
    } else if (arg === "--encrypt") {
      encrypt = true;
      only.push([arg, ["backup"]]);
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
      only.push([arg, ["restore", "import"]]);
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
      else error = t("-n expects a positive integer");
    } else if (arg === "--since") {
      const v = argv[++i] ?? "";
      if (/^\d+[smhd]$/.test(v)) since = v;
      else error = t("--since expects a duration like 30m, 1h or 2d");
    } else if (arg === "--component") {
      const v = argv[++i];
      if (v === "core" || v === "cli") component = v;
      else error = t("--component expects core or cli");
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--lang") {
      lang = parseLang(argv[++i]);
      if (!lang) error = t("--lang expects en or fr");
    } else {
      error ??= t("unknown argument: {0} (nokker --help)", arg ?? "");
    }
  }
  for (const [opt, cmds] of only) {
    if (!cmds.includes(command)) error ??= t("{0} only applies to nokker {1}", opt, cmds.join(", nokker "));
  }
  if (backupList && (keep !== null || encrypt)) error ??= t("backup list only takes --to");
  if (command === "restore" && source === null && !help) error ??= t("restore expects a backup file or s3://… (nokker backup list)");
  if (command === "import" && project !== null && importSource && !PROJECT_SOURCES.includes(importSource)) {
    error ??= t("--project only applies to {0}: {1} reads nothing in a project.", PROJECT_SOURCES.join(", "), importSource);
  }
  if (command === "import" && importArg === null && !help) error ??= t("import expects one of: {0}", IMPORT_SOURCES.join(", "));
  return {
    serverUrl, serverExplicit, print, json, sound, help, version, command, fix, follow, lines, since, component, check,
    targetVersion, backupList, to, keep, encrypt, yes, source, importSource, project, apply, lang, error,
  };
}
