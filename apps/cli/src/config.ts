import { homedir } from "node:os";
import { join } from "node:path";
import { NOKKER_CONFIG_DIRNAME } from "@nokker-apps/brand";

/** Dossier de config utilisateur : TOUJOURS `~/.config/nokker` (c'est là que l'installeur écrit lokkal.json), sur les 3 OS :
 * Linux/macOS `$XDG_CONFIG_HOME/nokker` sinon `~/.config/nokker` ; Windows `%USERPROFILE%\\.config\\nokker`.
 * `NOKKER_CONFIG_DIR_OVERRIDE` permet aux tests d'isoler complètement le fichier de session/clé d'appareil d'un vrai `$HOME`. */
export function configDir(): string {
  if (process.env.NOKKER_CONFIG_DIR_OVERRIDE) return process.env.NOKKER_CONFIG_DIR_OVERRIDE;
  if (process.platform === "win32") return join(process.env.USERPROFILE ?? homedir(), ".config", NOKKER_CONFIG_DIRNAME);
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), NOKKER_CONFIG_DIRNAME);
}

/** Anciens emplacements (macOS `~/Library/Application Support/nokker`, Windows `%APPDATA%\\nokker`) : lus en REPLI seulement,
 * `doctor` avertit s'il y trouve un fichier. */
export function legacyConfigDirs(): string[] {
  if (process.platform === "win32") return [join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? homedir(), "AppData", "Roaming"), NOKKER_CONFIG_DIRNAME)];
  if (process.platform === "darwin") return [join(homedir(), "Library", "Application Support", NOKKER_CONFIG_DIRNAME)];
  return [];
}

export function deviceKeyFilePath(): string {
  return join(configDir(), "device-key.json");
}

export function sessionFilePath(): string {
  return join(configDir(), "session.json");
}

/** Jeton local écrit par le noyau au démarrage (LOKKAL.md §7.4.5), 0600. */
export function localTokenPath(): string {
  return join(configDir(), "local-token");
}

/** Réglages de permission (`permissions.allow|ask|deny`) du mock/tests : le noyau écrit les siens dans le settings.json de son
 * dossier d'état (`~/.nokker/state/settings.json` avec le compose), jamais dans le dépôt. */
export function settingsFilePath(): string {
  return join(configDir(), "settings.json");
}

/** Écrit par l'installeur : chemin du compose Lokkal. */
export function lokkalFilePath(): string {
  return join(configDir(), "lokkal.json");
}

/** Anciens emplacements possibles de lokkal.json (hors override). */
export function legacyLokkalFilePaths(): string[] {
  return process.env.NOKKER_CONFIG_DIR_OVERRIDE ? [] : legacyConfigDirs().map((d) => join(d, "lokkal.json"));
}

export function cliLogPath(): string {
  return join(configDir(), "cli.log");
}
