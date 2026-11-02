/**
 * `nokker backup [--to <dossier|s3://…>] [--keep N] [--encrypt]`, `nokker backup list [--to …]`,
 * `nokker restore <fichier|s3://…> [--yes]` : enveloppe de `backup.sh` (posé par install.sh dans `~/.nokker`).
 *
 * Script : `<install_dir>/backup.sh` de lokkal.json, sinon `~/.nokker/backup.sh` ; `--dir <install_dir>` lui est passé
 * quand lokkal.json le donne. Les options sont celles de backup.sh (`backup|list|restore`, `--to`, `--keep`, `--encrypt`,
 * `--yes`, `--dir`) ; son code de sortie est rendu tel quel.
 *
 * Phrase de passe : jamais en argument. Demandée ici sans écho (deux fois pour une sauvegarde) puis transmise par
 * `NOKKER_BACKUP_PASSPHRASE`, la variable que backup.sh lit (sous WSL, ajoutée à `WSLENV` pour traverser wsl.exe).
 * Déjà présente dans l'environnement : utilisée telle quelle. Requise sans terminal : erreur, code 2.
 * S3 : chiffrement obligatoire, `--encrypt` exigé. Restauration : confirmation explicite sauf `--yes` (backup.sh reçoit
 * alors `--yes`, la question ayant été posée ici).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { hostCommand, readLokkal, type LokkalConfig } from "./lokkal.js";
import { t } from "./i18n/index.js";
import { run as realRun, type Runner } from "./proc.js";

export const PASSPHRASE_ENV = "NOKKER_BACKUP_PASSPHRASE";

export interface Prompter {
  /** Un terminal est là pour poser une question. */
  interactive: boolean;
  /** Saisie sans écho ; `null` = abandon (Ctrl-C, fin de flux). */
  secret(question: string): Promise<string | null>;
  confirm(question: string): Promise<boolean>;
}

export interface BackupOptions {
  action: "backup" | "list" | "restore";
  to?: string | null;
  keep?: number | null;
  encrypt?: boolean;
  yes?: boolean;
  source?: string | null;
  run?: Runner;
  out?: (text: string) => void;
  err?: (text: string) => void;
  prompt?: Prompter;
  /** Test : environnement lu (phrase de passe déjà fournie, WSLENV). Défaut : `process.env`. */
  env?: Record<string, string | undefined>;
  /** Test : dossier `~/.nokker` utilisé sans lokkal.json. */
  nokkerHome?: string;
}

const isS3 = (p: string | null | undefined): boolean => !!p && p.startsWith("s3://");

/** Chemin de backup.sh et dossier d'installation à lui passer (`--dir`), d'après lokkal.json. */
export function locateBackupScript(home: string): { script: string; installDir: string | null; cfg: LokkalConfig | null; present: boolean } {
  const r = readLokkal();
  const cfg = r.status === "ok" ? r.config : null;
  const installDir = cfg?.install_dir ?? null;
  const script = installDir ? (cfg?.wsl_distro ? `${installDir}/backup.sh` : join(installDir, "backup.sh")) : join(home, "backup.sh");
  // Sous WSL le chemin est Linux : invérifiable depuis Windows, présumé présent (sh le dira).
  return { script, installDir, cfg, present: cfg?.wsl_distro ? true : existsSync(script) };
}

/** Arguments de backup.sh, tels qu'il les attend. */
export function backupArgs(o: BackupOptions, installDir: string | null, local: boolean): string[] {
  const abs = (p: string): string => (local && !isS3(p) ? resolve(p) : p);
  const dir = installDir ? ["--dir", installDir] : [];
  if (o.action === "list") return ["list", ...(o.to ? ["--to", abs(o.to)] : []), ...dir];
  if (o.action === "restore") return ["restore", abs(o.source ?? ""), ...(o.yes ? ["--yes"] : []), ...dir];
  return [
    "backup",
    ...(o.to ? ["--to", abs(o.to)] : []),
    ...(o.keep !== null && o.keep !== undefined ? ["--keep", String(o.keep)] : []),
    ...(o.encrypt ? ["--encrypt"] : []),
    ...dir,
  ];
}

/** Une phrase de passe est-elle nécessaire ? Sauvegarde chiffrée (ou S3), restauration d'une archive `.enc`. */
export function needsPassphrase(o: BackupOptions): boolean {
  if (o.action === "backup") return !!o.encrypt || isS3(o.to);
  if (o.action === "restore") return /\.enc$/.test(o.source ?? "");
  return false;
}

export async function runBackup(o: BackupOptions): Promise<number> {
  const out = o.out ?? ((s) => process.stdout.write(s));
  const err = o.err ?? ((s) => process.stderr.write(s));
  const run = o.run ?? realRun;
  const env = o.env ?? process.env;
  const prompt = o.prompt ?? terminalPrompter();

  if (o.action === "backup" && isS3(o.to) && !o.encrypt) {
    err(`${t("Backups to S3 are always encrypted (they hold the secrets of the install): add --encrypt.")}\n`);
    return 2;
  }
  if (o.action === "restore" && !o.source) {
    err(`${t("restore expects a backup file or s3://… (nokker backup list)")}\n`);
    return 2;
  }
  const loc = locateBackupScript(o.nokkerHome ?? join(homedir(), ".nokker"));
  if (!loc.present) {
    err(`${t("backup.sh not found ({0}): rerun install.sh, or update with nokker update.", loc.script)}\n`);
    return 1;
  }
  if (o.action === "backup" && isS3(o.to) && o.keep !== null && o.keep !== undefined) {
    out(`${t("--keep only prunes folder backups: it is ignored for S3.")}\n`);
  }

  const extraEnv: Record<string, string> = {};
  if (o.action === "restore" && !o.yes) {
    if (!prompt.interactive) {
      err(`${t("restore replaces the data of the install: confirm with --yes (no terminal to ask).")}\n`);
      return 2;
    }
    const where = loc.installDir ?? "~/.nokker";
    if (!(await prompt.confirm(t("Replace the data of {0} with the backup {1}? [y/N] ", where, o.source ?? "")))) {
      err(`${t("Restore cancelled: nothing was changed.")}\n`);
      return 1;
    }
  }
  if (needsPassphrase(o) && !env[PASSPHRASE_ENV]) {
    if (!prompt.interactive) {
      err(`${t("A passphrase is required and there is no terminal to ask for it: set {0}.", PASSPHRASE_ENV)}\n`);
      return 2;
    }
    const first = await prompt.secret(t("Backup passphrase: "));
    if (first === null) return 130;
    if (!first) {
      err(`${t("Empty passphrase: nothing was done.")}\n`);
      return 2;
    }
    if (o.action === "backup") {
      const again = await prompt.secret(t("Passphrase again: "));
      if (again === null) return 130;
      if (again !== first) {
        err(`${t("The two passphrases differ: nothing was done.")}\n`);
        return 2;
      }
      out(`${t("Keep this passphrase safe: without it the backup cannot be restored.")}\n`);
    }
    extraEnv[PASSPHRASE_ENV] = first;
  }
  if (loc.cfg?.wsl_distro && (extraEnv[PASSPHRASE_ENV] || env[PASSPHRASE_ENV])) {
    // wsl.exe ne transmet que les variables listées dans WSLENV.
    const cur = env.WSLENV ?? "";
    if (!cur.split(":").includes(PASSPHRASE_ENV)) extraEnv.WSLENV = cur ? `${cur}:${PASSPHRASE_ENV}` : PASSPHRASE_ENV;
  }

  // La question a été posée ici : backup.sh ne la repose pas.
  const args = backupArgs({ ...o, yes: o.action === "restore" ? true : o.yes }, loc.installDir, !loc.cfg?.wsl_distro);
  const h = hostCommand(loc.cfg, "sh", [loc.script, ...args]);
  const r = await run(h.cmd, h.args, { inherit: true, timeoutMs: 6 * 3_600_000, ...(Object.keys(extraEnv).length ? { env: extraEnv } : {}) });
  if (r.error === "ENOENT") {
    err(`${t("{0} not found: cannot run backup.sh.", h.cmd)}\n`);
    return 1;
  }
  if (r.error === "timeout") {
    err(`${t("backup.sh did not finish in time.")}\n`);
    return 1;
  }
  return r.code ?? 1;
}

/** Questions au terminal (stdin) ; les invites vont sur stderr pour laisser stdout aux résultats. */
export function terminalPrompter(): Prompter {
  const stdin = process.stdin;
  const interactive = !!stdin.isTTY && !!process.stderr.isTTY;
  return {
    interactive,
    secret: (question) =>
      new Promise((done) => {
        process.stderr.write(question);
        let value = "";
        const finish = (v: string | null): void => {
          stdin.removeListener("data", onData);
          stdin.setRawMode?.(false);
          stdin.pause();
          process.stderr.write("\n");
          done(v);
        };
        const onData = (chunk: Buffer): void => {
          for (const ch of chunk.toString("utf-8")) {
            if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish(value);
            if (ch === "\u0003") return finish(null);
            if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
            else if (ch >= " ") value += ch;
          }
        };
        stdin.setRawMode?.(true);
        stdin.resume();
        stdin.on("data", onData);
      }),
    confirm: (question) =>
      new Promise((done) => {
        const rl = createInterface({ input: stdin, output: process.stderr });
        rl.question(question, (a) => {
          rl.close();
          done(/^(y|yes|o|oui)$/i.test(a.trim()));
        });
      }),
  };
}
