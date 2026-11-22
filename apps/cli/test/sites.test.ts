/** `nokker sites enable|update` : lance l'install.sh POSÉ avec `--sites-only` (jamais le vrai : un faux installeur dans un
 * dossier temporaire), après la ligne de capacité ; codes 0/3/1 transmis ; langue par scriptEnv ; WSL par wsl.exe. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner, RunOptions } from "../src/proc.js";
import { run as realRun } from "../src/proc.js";
import { parseArgs } from "../src/cli-args.js";
import { lang, setLang } from "../src/i18n/index.js";
import { SITES_CAPABILITY, hasSitesCapability, runSites } from "../src/sites.js";

let dir: string;
let inst: string;
const keep = process.env.NOKKER_CONFIG_DIR_OVERRIDE;
const keepLang = lang();
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-cli-sites-"));
  inst = join(dir, "nokker-home");
  await mkdir(inst, { recursive: true });
  await writeFile(join(inst, "docker-compose.yml"), "services: {}\n");
  process.env.NOKKER_CONFIG_DIR_OVERRIDE = dir;
});
afterAll(async () => {
  setLang(keepLang);
  if (keep === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
  else process.env.NOKKER_CONFIG_DIR_OVERRIDE = keep;
  await rm(dir, { recursive: true, force: true });
});

const base = { project: "nokker", version: "0.1.0", core_service: "core", api_url: "http://127.0.0.1:8742", web_url: "http://127.0.0.1:7420" };
async function lokkalLinux(): Promise<void> {
  await writeFile(join(dir, "lokkal.json"), JSON.stringify({
    ...base, compose: join(inst, "docker-compose.yml"), token_path: join(inst, "state", "local-token"), env_file: join(inst, ".env"), install_dir: inst,
  }));
}
/** Faux installeur : note ses arguments et NOKKER_LANG, sort avec `code`. */
async function installer(code: number, marker = true): Promise<string> {
  const seen = join(dir, "seen");
  await rm(seen, { force: true });
  await writeFile(join(inst, "install.sh"),
    `#!/bin/sh\n${marker ? `${SITES_CAPABILITY}\n` : ""}# installeur factice\nprintf '%s|%s' "$*" "$NOKKER_LANG" > '${seen}'\nexit ${code}\n`);
  return seen;
}
const quiet = () => ({ out: "", err: "" });

describe("arguments", () => {
  it("sites enable / sites update ; autre mot ou rien : erreur", () => {
    expect(parseArgs(["sites", "enable"])).toMatchObject({ command: "sites", sitesAction: "enable", error: null });
    expect(parseArgs(["sites", "update"])).toMatchObject({ command: "sites", sitesAction: "update", error: null });
    expect(parseArgs(["sites"]).error).toBe("sites expects enable or update");
    expect(parseArgs(["sites", "on"]).error).toBe("sites expects enable or update");
    expect(parseArgs(["sites", "enable", "--keep", "2"]).error).toContain("only applies to nokker backup");
  });
});

describe("ligne de capacité", () => {
  it("dans les premières lignes, CR LF toléré ; absente ou plus bas : non", () => {
    expect(hasSitesCapability(`#!/bin/sh\n${SITES_CAPABILITY}\n# x\n`)).toBe(true);
    expect(hasSitesCapability(`${SITES_CAPABILITY}\r\n# Nokker Lokkal -- installeur Windows\r\n`)).toBe(true);
    expect(hasSitesCapability("#!/bin/sh\n# Nokker Lokkal\n    --sites-only) SITES=1;;\n")).toBe(false);
    expect(hasSitesCapability(`1\n2\n3\n4\n5\n${SITES_CAPABILITY}\n`)).toBe(false);
  });
});

describe("Linux : vrai processus, faux installeur posé", () => {
  for (const code of [0, 3, 1]) {
    it(`code ${code} de l'installeur transmis ; --sites-only --dir <install_dir> ; NOKKER_LANG de la commande`, async () => {
      setLang(code === 3 ? "fr" : "en");
      await lokkalLinux();
      const seen = await installer(code);
      const o = quiet();
      const rc = await runSites({ action: "enable", run: realRun, env: {}, out: (s) => (o.out += s), err: (s) => (o.err += s) });
      expect(rc).toBe(code);
      expect(await readFile(seen, "utf-8")).toBe(`--sites-only --dir ${inst}|${code === 3 ? "fr" : "en"}`);
    });
  }
  it("update lance la même commande", async () => {
    setLang("en");
    await lokkalLinux();
    const seen = await installer(0);
    let out = "";
    expect(await runSites({ action: "update", run: realRun, env: {}, out: (s) => (out += s), err: () => {} })).toBe(0);
    expect(await readFile(seen, "utf-8")).toBe(`--sites-only --dir ${inst}|en`);
    expect(out).toContain("Updating connected sites through");
  });
  it("installeur sans la ligne de capacité : message, code 3, RIEN n'est lancé", async () => {
    setLang("en");
    await lokkalLinux();
    const seen = await installer(0, false);
    let err = "";
    expect(await runSites({ action: "enable", run: realRun, env: {}, out: () => {}, err: (s) => (err += s) })).toBe(3);
    expect(err).toContain("this Lokkal version has no connected sites: run nokker update first");
    await expect(readFile(seen, "utf-8")).rejects.toThrow();
  });
  it("installeur absent : code 1, message ; sans lokkal.json : code 1", async () => {
    setLang("en");
    await lokkalLinux();
    await rm(join(inst, "install.sh"), { force: true });
    let err = "";
    expect(await runSites({ action: "enable", run: realRun, env: {}, out: () => {}, err: (s) => (err += s) })).toBe(1);
    expect(err).toContain("install.sh not found");
    await rm(join(dir, "lokkal.json"));
    err = "";
    expect(await runSites({ action: "enable", run: realRun, env: {}, out: () => {}, err: (s) => (err += s) })).toBe(1);
    expect(err).toContain("no Lokkal installed");
  });
});

describe("Windows + WSL", () => {
  it("lecture de la ligne puis lancement dans la distribution, NOKKER_LANG par WSLENV", async () => {
    setLang("fr");
    await writeFile(join(dir, "lokkal.json"), JSON.stringify({
      ...base, compose: "/home/nina/.nokker/docker-compose.yml", token_path: "\\\\wsl.localhost\\Ubuntu\\home\\nina\\.nokker\\state\\local-token",
      env_file: "/home/nina/.nokker/.env", install_dir: "/home/nina/.nokker", wsl_distro: "Ubuntu",
    }));
    const calls: Array<{ cmd: string; args: string[]; opts: RunOptions | undefined }> = [];
    const run: Runner = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (args.includes("head")) return { code: 0, stdout: `#!/bin/sh\n${SITES_CAPABILITY}\n`, stderr: "" };
      return { code: 3, stdout: "", stderr: "" };
    };
    expect(await runSites({ action: "enable", run, env: { WSLENV: "USERPROFILE/p" }, out: () => {}, err: () => {} })).toBe(3);
    expect(calls.map((c) => [c.cmd, ...c.args].join(" "))).toEqual([
      "wsl.exe -d Ubuntu -- head -n 5 /home/nina/.nokker/install.sh",
      "wsl.exe -d Ubuntu -- sh /home/nina/.nokker/install.sh --sites-only --dir /home/nina/.nokker",
    ]);
    expect(calls[1]!.opts?.env).toEqual({ NOKKER_LANG: "fr", WSLENV: "USERPROFILE/p:NOKKER_LANG" });
    expect(calls[1]!.opts?.inherit).toBe(true);
  });
});
