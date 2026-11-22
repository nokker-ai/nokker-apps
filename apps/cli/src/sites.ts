/**
 * `nokker sites enable` et `nokker sites update` : sites connectés (docs/CONNECTED-SITES.md §3.1.1 du dépôt nokker).
 * Une seule implémentation, celle de l'installeur : la CLI lance l'install.sh POSÉ sur la machine (même version que
 * Lokkal, rien n'est téléchargé) avec `--sites-only --dir <install_dir>`. L'installeur demande l'accès au noyau local,
 * se connecte au registre, tire l'image par son digest, vérifie sa signature cosign avec la clé du paquet, puis
 * déconnecte (aucun identifiant ne reste sur le disque) et allume le profil. La CLI ne manipule aucun identifiant.
 * - Avant de lancer : l'installeur posé doit porter la ligne `# nokker-install-capabilities: sites` dans ses premières
 *   lignes ; sinon (Lokkal plus ancien), message clair et rien n'est lancé (code 3).
 * - Langue des messages de l'installeur : celle de la commande (`scriptEnv` : NOKKER_LANG, WSLENV sous WSL).
 * - Sous Windows (lokkal.json avec `wsl_distro`) : lecture et lancement dans la distribution par `wsl.exe -d`.
 * - Codes de l'installeur transmis tels quels : 0 allumé, 3 non allumé (raison déjà affichée), 1 erreur.
 */
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { SitesAction } from "./cli-args.js";
import { t } from "./i18n/index.js";
import { hostCommand, lokkalProblem, readLokkal, scriptEnv, type LokkalConfig } from "./lokkal.js";
import { run as realRun, type Runner } from "./proc.js";

/** Ligne qui annonce qu'un installeur connaît `--sites-only` (posée par l'installeur, ligne 2 d'install.sh). */
export const SITES_CAPABILITY = "# nokker-install-capabilities: sites";
/** Code « non allumé, raison affichée » de l'installeur, repris pour un installeur trop ancien. */
export const SITES_NOT_ENABLED = 3;

export interface SitesOptions {
  action: SitesAction;
  run?: Runner;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Test : environnement lu pour WSLENV. Défaut : `process.env`. */
  env?: Record<string, string | undefined>;
}

/** La ligne de capacité est-elle dans les 5 premières lignes (fins de ligne CR LF tolérées) ? */
export function hasSitesCapability(head: string): boolean {
  return head.split("\n").slice(0, 5).some((l) => l.replace(/\r$/, "").trim() === SITES_CAPABILITY);
}

/** Dossier d'installation et chemin de l'installeur posé (chemins Linux sous WSL). */
export function locateInstaller(cfg: LokkalConfig): { installDir: string; script: string } {
  if (cfg.wsl_distro) {
    const installDir = cfg.install_dir ?? posix.dirname(cfg.compose);
    return { installDir, script: posix.join(installDir, "install.sh") };
  }
  const installDir = cfg.install_dir ?? dirname(cfg.compose);
  return { installDir, script: join(installDir, "install.sh") };
}

/** Premières lignes de l'installeur posé ; `null` s'il est illisible ou absent. */
async function readHead(cfg: LokkalConfig, script: string, run: Runner): Promise<string | null> {
  if (!cfg.wsl_distro) {
    try {
      return readFileSync(script, "utf-8").split("\n").slice(0, 5).join("\n");
    } catch {
      return null;
    }
  }
  const h = hostCommand(cfg, "head", ["-n", "5", script]);
  const r = await run(h.cmd, h.args, { timeoutMs: 15_000 });
  return r.code === 0 ? r.stdout : null;
}

export async function runSites(o: SitesOptions): Promise<number> {
  const run = o.run ?? realRun;
  const out = o.out ?? ((s) => process.stdout.write(s));
  const err = o.err ?? ((s) => process.stderr.write(s));
  const r = readLokkal();
  const problem = lokkalProblem(r);
  if (problem || r.status !== "ok") {
    err(`${problem ?? t("no Lokkal installed (~/.config/nokker/lokkal.json is missing — written by install.sh)")}\n`);
    return 1;
  }
  const cfg = r.config;
  const { installDir, script } = locateInstaller(cfg);
  const head = await readHead(cfg, script, run);
  if (head === null) {
    err(`${t("install.sh not found ({0}): rerun the installer, or update with nokker update.", script)}\n`);
    return 1;
  }
  if (!hasSitesCapability(head)) {
    err(`${t("this Lokkal version has no connected sites: run nokker update first")}\n`);
    return SITES_NOT_ENABLED;
  }
  out(`${o.action === "enable" ? t("Turning on connected sites through {0} --sites-only…", script) : t("Updating connected sites through {0} --sites-only…", script)}\n`);
  const h = hostCommand(cfg, "sh", [script, "--sites-only", "--dir", installDir]);
  // Pull d'une image de navigateur : jusqu'à 30 min sur une connexion lente.
  const res = await run(h.cmd, h.args, { inherit: true, timeoutMs: 1_800_000, env: scriptEnv(cfg, {}, o.env ?? process.env) });
  if (res.error === "ENOENT") {
    err(`${t("{0} not found: cannot run install.sh.", h.cmd)}\n`);
    return 1;
  }
  if (res.error === "timeout") {
    err(`${t("install.sh --sites-only did not finish in time.")}\n`);
    return 1;
  }
  return res.code ?? 1;
}
