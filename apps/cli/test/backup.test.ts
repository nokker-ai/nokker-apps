/** `backup`, `backup list`, `restore` : enveloppe de backup.sh, avec un exécuteur factice ou un backup.sh factice dans un
 * dossier temporaire (jamais le vrai script). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Runner, RunOptions } from "../src/proc.js";
import { run as realRun } from "../src/proc.js";
import { needsPassphrase, runBackup, type BackupOptions, type Prompter } from "../src/backup.js";
import { parseArgs } from "../src/cli-args.js";

let dir: string;
let inst: string;
const keep = process.env.NOKKER_CONFIG_DIR_OVERRIDE;
const SECRET = "correct horse battery staple";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-cli-backup-"));
  inst = join(dir, "nokker-home");
  await mkdir(inst, { recursive: true });
  process.env.NOKKER_CONFIG_DIR_OVERRIDE = dir;
});
afterAll(async () => {
  if (keep === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
  else process.env.NOKKER_CONFIG_DIR_OVERRIDE = keep;
  await rm(dir, { recursive: true, force: true });
});

async function writeLokkal(over: Record<string, unknown> = {}): Promise<void> {
  const compose = join(inst, "docker-compose.yml");
  await writeFile(compose, "services: {}\n");
  await writeFile(
    join(dir, "lokkal.json"),
    JSON.stringify({
      compose, project: "nokker", version: "0.1.0", core_service: "core", api_url: "http://127.0.0.1:8742", web_url: "http://127.0.0.1:7420",
      token_path: join(inst, "state", "local-token"), env_file: join(inst, ".env"), install_dir: inst, ...over,
    }),
  );
}
beforeEach(async () => {
  await writeLokkal();
  await writeFile(join(inst, "backup.sh"), "#!/bin/sh\nexit 0\n");
});

interface Call { cmd: string; args: string[]; opts: RunOptions | undefined }
function fake(calls: Call[], code = 0): Runner {
  return async (cmd, args, opts) => (calls.push({ cmd, args, opts }), { code, stdout: "", stderr: "" });
}
function prompter(answers: { secrets?: Array<string | null>; confirm?: boolean; interactive?: boolean } = {}): Prompter & { asked: string[] } {
  const secrets = [...(answers.secrets ?? [])];
  const asked: string[] = [];
  return {
    asked,
    interactive: answers.interactive ?? true,
    secret: async (q) => (asked.push(q), secrets.length ? secrets.shift()! : null),
    confirm: async (q) => (asked.push(q), answers.confirm ?? false),
  };
}
const quiet = { out: () => {}, err: () => {} };
async function go(o: Partial<BackupOptions> & Pick<BackupOptions, "action">, extra: Partial<BackupOptions> = {}): Promise<{ code: number; calls: Call[]; err: string; out: string }> {
  const calls: Call[] = [];
  let err = "";
  let out = "";
  const code = await runBackup({ run: fake(calls), prompt: prompter(), env: {}, ...o, ...extra, out: (t) => (out += t), err: (t) => (err += t) });
  return { code, calls, err, out };
}

describe("traduction des options vers backup.sh", () => {
  it("backup --to <dossier relatif> --keep 7 --encrypt : chemin absolu, --dir <install_dir>, sh <install_dir>/backup.sh", async () => {
    const { code, calls } = await go({ action: "backup", to: "nas/nokker", keep: 7, encrypt: true, prompt: prompter({ secrets: [SECRET, SECRET] }) });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("sh");
    expect(calls[0]!.args).toEqual([join(inst, "backup.sh"), "backup", "--to", resolve("nas/nokker"), "--keep", "7", "--encrypt", "--dir", inst]);
    expect(calls[0]!.opts?.inherit).toBe(true);
  });

  it("backup sans option : rien que backup --dir ; aucune phrase de passe demandée", async () => {
    const p = prompter();
    const { calls } = await go({ action: "backup", prompt: p });
    expect(calls[0]!.args).toEqual([join(inst, "backup.sh"), "backup", "--dir", inst]);
    expect(p.asked).toEqual([]);
    expect(calls[0]!.opts?.env).toBeUndefined();
  });

  it("backup list [--to s3://…] et restore <fichier> --yes", async () => {
    expect((await go({ action: "list" })).calls[0]!.args.slice(1)).toEqual(["list", "--dir", inst]);
    expect((await go({ action: "list", to: "s3://bk/nokker" })).calls[0]!.args.slice(1)).toEqual(["list", "--to", "s3://bk/nokker", "--dir", inst]);
    const r = await go({ action: "restore", source: "/srv/b/nokker-backup-20261101T000000Z.tar", yes: true });
    expect(r.calls[0]!.args.slice(1)).toEqual(["restore", "/srv/b/nokker-backup-20261101T000000Z.tar", "--yes", "--dir", inst]);
  });

  it("sans install_dir dans lokkal.json (ou sans lokkal.json) : ~/.nokker/backup.sh, pas de --dir", async () => {
    await rm(join(dir, "lokkal.json"));
    const home = join(dir, "home-nokker");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "backup.sh"), "#!/bin/sh\n");
    const { calls } = await go({ action: "list", nokkerHome: home });
    expect(calls[0]!.args).toEqual([join(home, "backup.sh"), "list"]);
  });

  it("backup.sh introuvable : message clair, code 1, rien n'est lancé", async () => {
    await rm(join(inst, "backup.sh"));
    const { code, calls, err } = await go({ action: "backup" });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(err).toContain("backup.sh not found");
  });

  it("le code de sortie de backup.sh est rendu tel quel", async () => {
    const calls: Call[] = [];
    expect(await runBackup({ action: "list", run: fake(calls, 3), prompt: prompter(), env: {}, ...quiet })).toBe(3);
  });

  it("WSL : wsl.exe -d <distro> -- sh <install_dir>/backup.sh, la phrase de passe traverse par WSLENV", async () => {
    await writeLokkal({
      compose: "/home/nina/.nokker/docker-compose.yml", env_file: "/home/nina/.nokker/.env", install_dir: "/home/nina/.nokker",
      token_path: "\\\\wsl.localhost\\Ubuntu\\home\\nina\\.nokker\\state\\local-token", wsl_distro: "Ubuntu",
    });
    const { calls } = await go({ action: "backup", encrypt: true, prompt: prompter({ secrets: [SECRET, SECRET] }), env: { WSLENV: "USERPROFILE/p" } });
    expect(calls[0]!.cmd).toBe("wsl.exe");
    expect(calls[0]!.args).toEqual(["-d", "Ubuntu", "--", "sh", "/home/nina/.nokker/backup.sh", "backup", "--encrypt", "--dir", "/home/nina/.nokker"]);
    expect(calls[0]!.opts?.env).toEqual({ NOKKER_BACKUP_PASSPHRASE: SECRET, WSLENV: "USERPROFILE/p:NOKKER_BACKUP_PASSPHRASE" });
  });
});

describe("chiffrement et phrase de passe", () => {
  it("S3 sans --encrypt : refus, code 2, rien n'est lancé", async () => {
    const { code, calls, err } = await go({ action: "backup", to: "s3://bk/nokker" });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(err).toContain("Backups to S3 are always encrypted");
    expect(err).toContain("--encrypt");
  });

  it("phrase de passe : demandée deux fois, transmise par NOKKER_BACKUP_PASSPHRASE, JAMAIS dans argv", async () => {
    const p = prompter({ secrets: [SECRET, SECRET] });
    const { code, calls } = await go({ action: "backup", to: "s3://bk/nokker", encrypt: true, keep: 3, prompt: p });
    expect(code).toBe(0);
    expect(p.asked).toEqual(["Backup passphrase: ", "Passphrase again: "]);
    expect(calls[0]!.args.join("\0")).not.toContain(SECRET);
    expect(calls[0]!.args.some((a) => a.includes("correct horse"))).toBe(false);
    expect(calls[0]!.opts?.env).toEqual({ NOKKER_BACKUP_PASSPHRASE: SECRET });
  });

  it("deux saisies différentes, saisie vide, Ctrl-C : rien n'est lancé", async () => {
    expect((await go({ action: "backup", encrypt: true, prompt: prompter({ secrets: [SECRET, "autre"] }) }))).toMatchObject({ code: 2, calls: [] });
    expect((await go({ action: "backup", encrypt: true, prompt: prompter({ secrets: [""] }) }))).toMatchObject({ code: 2, calls: [] });
    expect((await go({ action: "backup", encrypt: true, prompt: prompter({ secrets: [null] }) }))).toMatchObject({ code: 130, calls: [] });
  });

  it("sans terminal et phrase de passe requise : erreur claire, code 2", async () => {
    const r = await go({ action: "backup", encrypt: true, prompt: prompter({ interactive: false }) });
    expect(r.code).toBe(2);
    expect(r.calls).toEqual([]);
    expect(r.err).toContain("set NOKKER_BACKUP_PASSPHRASE");
    const rs = await go({ action: "restore", source: "/b/nokker-backup-x.tar.enc", yes: true, prompt: prompter({ interactive: false }) });
    expect(rs.code).toBe(2);
  });

  it("NOKKER_BACKUP_PASSPHRASE déjà dans l'environnement : pas de question (backup.sh la lit)", async () => {
    const p = prompter({ interactive: false });
    const { code, calls } = await go({ action: "backup", encrypt: true, prompt: p, env: { NOKKER_BACKUP_PASSPHRASE: "x" } });
    expect(code).toBe(0);
    expect(p.asked).toEqual([]);
    expect(calls[0]!.opts?.env).toBeUndefined();
  });

  it("restauration d'une archive .enc : une seule saisie ; .tar en clair : aucune", async () => {
    expect(needsPassphrase({ action: "restore", source: "s3://bk/nokker/nokker-backup-x.tar.enc" })).toBe(true);
    expect(needsPassphrase({ action: "restore", source: "/b/nokker-backup-x.tar" })).toBe(false);
    expect(needsPassphrase({ action: "list", to: "s3://bk" })).toBe(false);
    const p = prompter({ secrets: [SECRET] });
    const { calls } = await go({ action: "restore", source: "s3://bk/nokker/nokker-backup-x.tar.enc", yes: true, prompt: p });
    expect(p.asked).toEqual(["Backup passphrase: "]);
    expect(calls[0]!.opts?.env).toEqual({ NOKKER_BACKUP_PASSPHRASE: SECRET });
    expect(calls[0]!.args).not.toContain(SECRET);
  });
});

describe("confirmation de restore", () => {
  it("sans --yes : question explicite ; refus = rien n'est lancé, code 1", async () => {
    const p = prompter({ confirm: false });
    const { code, calls, err } = await go({ action: "restore", source: "/b/nokker-backup-x.tar", prompt: p });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(p.asked[0]).toContain(`Replace the data of ${inst} with the backup /b/nokker-backup-x.tar?`);
    expect(err).toContain("Restore cancelled");
  });

  it("sans --yes, accepté : backup.sh reçoit --yes (la question n'est pas posée deux fois)", async () => {
    const { code, calls } = await go({ action: "restore", source: "/b/nokker-backup-x.tar", prompt: prompter({ confirm: true }) });
    expect(code).toBe(0);
    expect(calls[0]!.args.slice(1)).toEqual(["restore", "/b/nokker-backup-x.tar", "--yes", "--dir", inst]);
  });

  it("confirmation demandée AVANT la phrase de passe", async () => {
    const p = prompter({ confirm: true, secrets: [SECRET] });
    await go({ action: "restore", source: "/b/nokker-backup-x.tar.enc", prompt: p });
    expect(p.asked).toEqual([expect.stringContaining("Replace the data"), "Backup passphrase: "]);
  });

  it("sans --yes et sans terminal : code 2, message", async () => {
    const r = await go({ action: "restore", source: "/b/nokker-backup-x.tar", prompt: prompter({ interactive: false }) });
    expect(r).toMatchObject({ code: 2, calls: [] });
    expect(r.err).toContain("confirm with --yes");
  });
});

describe("avec un vrai processus (backup.sh factice)", () => {
  it("argv et environnement réellement reçus par le script ; code de sortie transmis", async () => {
    const trace = join(dir, "trace.txt");
    await writeFile(join(inst, "backup.sh"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${trace}'\nprintf 'PASS=%s\\n' "$NOKKER_BACKUP_PASSPHRASE" >> '${trace}'\nexit 7\n`);
    await chmod(join(inst, "backup.sh"), 0o700);
    const code = await runBackup({ action: "backup", to: "s3://bk/p", encrypt: true, prompt: prompter({ secrets: [SECRET, SECRET] }), env: {}, run: realRun, ...quiet });
    expect(code).toBe(7);
    const lines = (await readFile(trace, "utf-8")).trim().split("\n");
    expect(lines).toEqual(["backup", "--to", "s3://bk/p", "--encrypt", "--dir", inst, `PASS=${SECRET}`]);
  });
});

describe("analyse des arguments", () => {
  it("backup, backup list, restore", () => {
    expect(parseArgs(["backup", "--to", "s3://b/p", "--keep", "7", "--encrypt"], {})).toMatchObject({ command: "backup", backupList: false, to: "s3://b/p", keep: 7, encrypt: true, error: null });
    expect(parseArgs(["backup", "list", "--to", "/mnt/nas"], {})).toMatchObject({ command: "backup", backupList: true, to: "/mnt/nas", error: null });
    expect(parseArgs(["restore", "s3://b/p/x.tar.enc", "--yes"], {})).toMatchObject({ command: "restore", source: "s3://b/p/x.tar.enc", yes: true, error: null });
    expect(parseArgs(["restore", "-y", "/b/x.tar"], {})).toMatchObject({ source: "/b/x.tar", yes: true, error: null });
  });
  it("erreurs d'usage", () => {
    expect(parseArgs(["restore"], {}).error).toContain("restore expects a backup file");
    expect(parseArgs(["backup", "--keep", "-1"], {}).error).toContain("--keep expects");
    expect(parseArgs(["backup", "--to"], {}).error).toContain("--to expects");
    expect(parseArgs(["backup", "list", "--encrypt"], {}).error).toContain("backup list only takes --to");
    expect(parseArgs(["restore", "/b/x.tar", "--encrypt"], {}).error).toContain("--encrypt only applies to nokker backup");
    expect(parseArgs(["backup", "--yes"], {}).error).toContain("--yes only applies to nokker restore");
    expect(parseArgs(["backup", "extra"], {}).error).toContain("unknown argument: extra");
  });
  it("update --version X.Y.Z (sans sous-commande, --version reste celle du client)", () => {
    expect(parseArgs(["update", "--version", "0.4.1"], {})).toMatchObject({ command: "update", targetVersion: "0.4.1", version: false, error: null });
    expect(parseArgs(["update", "--version", "latest"], {}).error).toContain("update --version expects");
    expect(parseArgs(["--version"], {})).toMatchObject({ version: true, targetVersion: null });
  });
});

describe("bin sans TTY", () => {
  const bin = join(import.meta.dirname, "../bin/nokker.mjs");
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [bin, ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8", timeout: 30_000, env: { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: dir, NOKKER_BACKUP_PASSPHRASE: "" } });
  it("backup --encrypt sans terminal : code 2, message clair, backup.sh jamais lancé", async () => {
    const marker = join(dir, "ran.txt");
    await writeFile(join(inst, "backup.sh"), `#!/bin/sh\ntouch '${marker}'\n`);
    const r = cli(["backup", "--encrypt"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("there is no terminal to ask for it");
    await expect(readFile(marker)).rejects.toThrow();
  });
  it("backup --to s3://… sans --encrypt : code 2", () => {
    const r = cli(["backup", "--to", "s3://bk/p"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("always encrypted");
  });
});
