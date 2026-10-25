/**
 * `~/.config/nokker/lokkal.json` (0600, écrit par install.sh — contrat du couloir emballage) :
 * `{compose, project, version, core_service, api_url, web_url, token_path, env_file, install_dir}` (+ `wsl_distro` optionnelle).
 * Toutes les clés sont obligatoires ; les chemins sont absolus. Une clé manquante donne un message clair.
 */
import { existsSync, readFileSync } from "node:fs";
import { legacyLokkalFilePaths, lokkalFilePath } from "./config.js";
import { t } from "./i18n/index.js";

export interface LokkalConfig {
  compose: string;
  project: string;
  version: string;
  core_service: string;
  api_url: string;
  web_url: string;
  token_path: string;
  env_file: string;
  /** Chemin (Linux) de `~/.nokker`, qui contient install.sh. Toujours écrit par install.sh ; requis sous WSL. */
  install_dir?: string;
  /** Windows : Lokkal tourne dans cette distro WSL 2. `compose`, `env_file`, `install_dir` sont alors des chemins LINUX,
   * `token_path` un chemin UNC `\\\\wsl.localhost\\<distro>\\…` lisible tel quel depuis Windows. */
  wsl_distro?: string;
}

export const LOKKAL_KEYS = ["compose", "project", "version", "core_service", "api_url", "web_url", "token_path", "env_file"] as const;
const ABSOLUTE_KEYS = ["compose", "token_path", "env_file"] as const;

/** Absolu POSIX, lecteur Windows (`C:\\`) ou UNC (`\\\\hôte\\partage`). */
export function isAbsLike(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

export type LokkalResult =
  | { status: "absent" }
  | { status: "invalid"; error: string }
  | { status: "ok"; config: LokkalConfig; composeExists: boolean; legacyPath?: string };

/** Validation pure du contenu déjà parsé. Renvoie le message d'erreur ou la config. */
export function validateLokkal(raw: unknown): { config: LokkalConfig } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: t("lokkal.json is not a JSON object") };
  const o = raw as Record<string, unknown>;
  const missing = LOKKAL_KEYS.filter((k) => typeof o[k] !== "string" || !(o[k] as string).trim());
  if (missing.length) return { error: t("lokkal.json: missing or empty key(s): {0} (rerun install.sh)", missing.join(", ")) };
  const relative = ABSOLUTE_KEYS.filter((k) => !isAbsLike(o[k] as string));
  if (relative.length) return { error: t("lokkal.json: non-absolute path(s): {0}", relative.join(", ")) };
  const config = Object.fromEntries(LOKKAL_KEYS.map((k) => [k, (o[k] as string).trim()])) as unknown as LokkalConfig;
  for (const k of ["install_dir", "wsl_distro"] as const) {
    if (o[k] !== undefined) {
      if (typeof o[k] !== "string" || !(o[k] as string).trim()) return { error: t("lokkal.json: {0} must be a non-empty string", k) };
      config[k] = (o[k] as string).trim();
    }
  }
  if (config.wsl_distro) {
    if (!config.install_dir) return { error: t("lokkal.json: wsl_distro is set but install_dir is missing (Linux path of ~/.nokker)") };
    const notLinux = (["compose", "env_file", "install_dir"] as const).filter((k) => !(config[k] as string).startsWith("/"));
    if (notLinux.length) return { error: t("lokkal.json: under WSL, {0} must be Linux paths (/…)", notLinux.join(", ")) };
  }
  return { config };
}

/** Lit lokkal.json dans `~/.config/nokker` ; à défaut, REPLI lecture sur les anciens emplacements (macOS Application Support,
 * Windows %APPDATA%) — `legacyPath` est alors renseigné et `doctor` avertit. */
export function readLokkal(): LokkalResult {
  let path = lokkalFilePath();
  let legacyPath: string | undefined;
  if (!existsSync(path)) {
    legacyPath = legacyLokkalFilePaths().find((p) => existsSync(p));
    if (!legacyPath) return { status: "absent" };
    path = legacyPath;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { status: "invalid", error: t("{0} is not valid JSON", path) };
  }
  const v = validateLokkal(raw);
  if ("error" in v) return { status: "invalid", error: v.error };
  // Sous WSL le compose est un chemin Linux : invérifiable depuis Windows, on le suppose présent (docker le dira).
  return { status: "ok", config: v.config, composeExists: v.config.wsl_distro ? true : existsSync(v.config.compose), ...(legacyPath ? { legacyPath } : {}) };
}

/** Explication unique quand lokkal.json ne permet pas d'agir sur le noyau. `null` si tout est prêt. */
export function lokkalProblem(r: LokkalResult): string | null {
  if (r.status === "absent") return t("no Lokkal installed (~/.config/nokker/lokkal.json is missing — written by install.sh)");
  if (r.status === "invalid") return r.error;
  if (!r.composeExists) return t("compose not found ({0})", r.config.compose);
  return null;
}

/** Commande à lancer sur l'hôte de Lokkal : sous WSL (Windows) elle passe par `wsl.exe -d <distro> -- …`. */
export function hostCommand(c: LokkalConfig | null, cmd: string, args: string[]): { cmd: string; args: string[] } {
  return c?.wsl_distro ? { cmd: "wsl.exe", args: ["-d", c.wsl_distro, "--", cmd, ...args] } : { cmd, args };
}

/** Arguments `docker compose -p <project> -f <compose>`. */
export function composeArgs(c: LokkalConfig): string[] {
  return ["compose", "-p", c.project, "-f", c.compose];
}

import { localTokenPath } from "./config.js";

/** Jeton local : `token_path` de lokkal.json s'il est valide, sinon `<config>/local-token` (tests, mock). */
export function resolveTokenPath(): string {
  const r = readLokkal();
  return r.status === "ok" ? r.config.token_path : localTokenPath();
}

/** Origine « défaut » de l'adresse du serveur ; l'affichage passe par `sourceLabel` (traduit). */
export const SOURCE_DEFAULT = "default";
export type ServerSource = "--server" | "NOKKER_SERVER_URL" | "lokkal.json" | typeof SOURCE_DEFAULT;

/** Origine du serveur telle qu'on la montre (traduite pour le défaut). */
export function sourceLabel(s: ServerSource): string {
  return s === SOURCE_DEFAULT ? t("default") : s;
}

/** Priorité : --server > NOKKER_SERVER_URL > api_url de lokkal.json > défaut (8742). */
export function resolveServer(parsed: { serverUrl: string; serverExplicit: boolean }, env: Record<string, string | undefined> = process.env): { url: string; source: ServerSource } {
  if (parsed.serverExplicit) return { url: parsed.serverUrl, source: env.NOKKER_SERVER_URL === parsed.serverUrl ? "NOKKER_SERVER_URL" : "--server" };
  const r = readLokkal();
  if (r.status === "ok") return { url: r.config.api_url, source: "lokkal.json" };
  return { url: parsed.serverUrl, source: SOURCE_DEFAULT };
}
