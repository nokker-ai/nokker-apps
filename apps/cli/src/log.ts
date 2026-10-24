import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { cliLogPath } from "./config.js";

/** Journal du client (`~/.config/nokker/cli.log`), best effort : ne lève jamais. Pas de secret ici. */
export function cliLog(level: "info" | "warn" | "error", message: string): void {
  try {
    const path = cliLogPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`, { mode: 0o600 });
  } catch {
    // journal indisponible : sans importance
  }
}
