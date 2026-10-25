/**
 * Où est le noyau et avec quel jeton : EXACTEMENT comme la CLI `nokker` (mêmes fichiers, même code). Le jeton local est lu
 * à `token_path` de `~/.config/nokker/lokkal.json` (écrit par l'installeur), à défaut `~/.config/nokker/local-token` ;
 * il n'est jamais rangé dans les réglages de VS Code (synchronisés entre machines).
 */
import { readFile } from "node:fs/promises";
import { readLokkal, resolveTokenPath } from "@nokker-apps/cli/src/lokkal.js";
import { english, type Translate } from "./i18n.js";

export const DEFAULT_SERVER_URL = "http://127.0.0.1:8742";

export type ServerSource = "setting nokker.serverUrl" | "NOKKER_SERVER_URL" | "lokkal.json" | "default";

/** Priorité : réglage `nokker.serverUrl` (portée machine, non synchronisé) > `$NOKKER_SERVER_URL` > `api_url` de lokkal.json
 * > `http://127.0.0.1:8742`. */
export function resolveServerUrl(setting: string | undefined, env: Record<string, string | undefined> = process.env): { url: string; source: ServerSource } {
  if (setting && setting.trim()) return { url: setting.trim(), source: "setting nokker.serverUrl" };
  if (env.NOKKER_SERVER_URL) return { url: env.NOKKER_SERVER_URL, source: "NOKKER_SERVER_URL" };
  const r = readLokkal();
  if (r.status === "ok") return { url: r.config.api_url, source: "lokkal.json" };
  return { url: DEFAULT_SERVER_URL, source: "default" };
}

export function isLocalServer(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

/** Chemin du jeton local (celui de la CLI). */
export function tokenPath(): string {
  return resolveTokenPath();
}

/** Le jeton local, ou une explication de son absence. Jamais envoyé ailleurs qu'à un noyau en boucle locale. */
export async function readLocalToken(serverUrl: string, t: Translate = english): Promise<{ token: string } | { error: string }> {
  if (!isLocalServer(serverUrl)) {
    return { error: t("{0} is not a local kernel: the extension only talks to the kernel of this machine (127.0.0.1).", serverUrl) };
  }
  const path = tokenPath();
  try {
    const token = (await readFile(path, "utf-8")).trim();
    if (token) return { token };
  } catch {
    // absent ou illisible
  }
  return { error: t("local token not found ({0}): is Lokkal installed and running? Run `nokker doctor` in a terminal.", path) };
}
