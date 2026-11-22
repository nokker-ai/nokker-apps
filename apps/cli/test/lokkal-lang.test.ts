/** Langue des scripts de Lokkal lancés par la CLI : backup.sh et install.sh --update reçoivent NOKKER_LANG = la langue de
 * la commande (--lang compris) ; sous WSL, la variable traverse wsl.exe par WSLENV (lokkal.ts `scriptEnv`). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import type { Runner, RunOptions } from "../src/proc.js";
import { run as realRun } from "../src/proc.js";
import { lang, setLang } from "../src/i18n/index.js";
import { scriptEnv, type LokkalConfig } from "../src/lokkal.js";
import { runBackup, type Prompter } from "../src/backup.js";
import { runUpdate } from "../src/update.js";

let dir: string;
let mock: MockServerHandle;
const keep = process.env.NOKKER_CONFIG_DIR_OVERRIDE;
const keepLang = lang();
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-cli-lang-"));
  process.env.NOKKER_CONFIG_DIR_OVERRIDE = dir;
  mock = await startMockServer({ port: 0, seed: false });
});
afterAll(async () => {
  setLang(keepLang);
  await mock.close();
  if (keep === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
  else process.env.NOKKER_CONFIG_DIR_OVERRIDE = keep;
  await rm(dir, { recursive: true, force: true });
});

const linux = { compose: "/c.yml", project: "nokker", version: "0.1.0", core_service: "core", api_url: "http://127.0.0.1:8742", web_url: "http://127.0.0.1:7420", token_path: "/t", env_file: "/e" } as LokkalConfig;
const wsl = { ...linux, install_dir: "/home/nina/.nokker", wsl_distro: "Ubuntu" } as LokkalConfig;

describe("scriptEnv", () => {
  it("hors WSL : NOKKER_LANG = langue de la commande, sans WSLENV", () => {
    setLang("fr");
    expect(scriptEnv(linux, {}, {})).toEqual({ NOKKER_LANG: "fr" });
    expect(scriptEnv(null, { A: "1" }, {})).toEqual({ A: "1", NOKKER_LANG: "fr" });
  });
  it("WSL : variables ajoutées à WSLENV, entrées existantes (et leurs drapeaux) gardées, sans doublon", () => {
    setLang("en");
    expect(scriptEnv(wsl, {}, {})).toEqual({ NOKKER_LANG: "en", WSLENV: "NOKKER_LANG" });
    expect(scriptEnv(wsl, { P: "x" }, { WSLENV: "USERPROFILE/p:NOKKER_LANG/u" }, ["Q"]))
      .toEqual({ P: "x", NOKKER_LANG: "en", WSLENV: "USERPROFILE/p:NOKKER_LANG/u:P:Q" });
  });
});

const prompt: Prompter = { interactive: false, secret: async () => null, confirm: async () => false };
const quiet = { out: () => {}, err: () => {} };

describe("backup.sh reçoit la langue", () => {
  it("vrai processus : le script lit NOKKER_LANG=fr quand la commande est en français", async () => {
    setLang("fr");
    const inst = join(dir, "inst");
    await mkdir(inst, { recursive: true });
    const seen = join(dir, "seen");
    await writeFile(join(inst, "backup.sh"), `#!/bin/sh\nprintf '%s' "$NOKKER_LANG" > '${seen}'\n`);
    await writeFile(join(inst, "docker-compose.yml"), "services: {}\n");
    await writeFile(join(dir, "lokkal.json"), JSON.stringify({ ...linux, compose: join(inst, "docker-compose.yml"), install_dir: inst }));
    expect(await runBackup({ action: "list", run: realRun, prompt, env: { NOKKER_LANG: "en" }, ...quiet })).toBe(0);
    expect(await (await import("node:fs/promises")).readFile(seen, "utf-8")).toBe("fr");
  });
  it("WSL : NOKKER_LANG listé dans WSLENV, phrase de passe de l'environnement aussi", async () => {
    setLang("fr");
    await writeFile(join(dir, "lokkal.json"), JSON.stringify(wsl));
    const calls: Array<{ cmd: string; opts: RunOptions | undefined }> = [];
    const run: Runner = async (cmd, _a, opts) => (calls.push({ cmd, opts }), { code: 0, stdout: "", stderr: "" });
    expect(await runBackup({ action: "list", run, prompt, env: { NOKKER_BACKUP_PASSPHRASE: "x" }, ...quiet })).toBe(0);
    expect(calls[0]!.cmd).toBe("wsl.exe");
    expect(calls[0]!.opts?.env).toEqual({ NOKKER_LANG: "fr", WSLENV: "NOKKER_BACKUP_PASSPHRASE:NOKKER_LANG" });
  });
});

describe("install.sh --update reçoit la langue", () => {
  const body = Buffer.from("#!/bin/sh\necho installeur factice\n");
  const assets: Record<string, Buffer> = {
    "/install.sh": body,
    "/install.sh.sha256": Buffer.from(`${createHash("sha256").update(body).digest("hex")}  install.sh\n`),
  };
  const http = (async (url: string) => {
    const ok = (b: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => b, text: async () => String(b), arrayBuffer: async () => b as ArrayBuffer });
    if (url.includes("api.github.com")) return ok([{ tag_name: "lokkal-v0.3.0" }]);
    const hit = Object.entries(assets).find(([k]) => url.endsWith(k));
    if (!hit) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
    const b = hit[1];
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => b.toString(), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
  }) as never;

  for (const [name, cfg, want] of [
    ["Linux", { ...linux, install_dir: "/home/alice/.nokker" }, { NOKKER_LANG: "fr" }],
    ["WSL", wsl, { NOKKER_LANG: "fr", WSLENV: "NOKKER_LANG" }],
  ] as const) {
    it(`${name} : l'installeur de la version cible est lancé avec ${JSON.stringify(want)}`, async () => {
      setLang("fr");
      const env = process.env.WSLENV;
      delete process.env.WSLENV;
      // hors WSL, la CLI vérifie que le compose existe : un vrai fichier dans le dossier de test
      const compose = join(dir, "docker-compose.yml");
      await writeFile(compose, "services: {}\n");
      await writeFile(join(dir, "lokkal.json"), JSON.stringify(cfg.wsl_distro ? cfg : { ...cfg, compose, env_file: join(dir, ".env") }));
      await writeFile(join(dir, ".env"), "NOKKER_VERSION=0.1.0\n");
      const tmpRoot = await mkdtemp(join(tmpdir(), "nokker-lang-upd-"));
      const calls: Array<{ args: string[]; opts: RunOptions | undefined }> = [];
      const run: Runner = async (cmd, args, opts) => {
        calls.push({ args: [cmd, ...args], opts });
        if (cmd === "cosign") return { code: null, stdout: "", stderr: "", error: "ENOENT" };
        return { code: 0, stdout: "", stderr: "" };
      };
      try {
        const code = await runUpdate({ serverUrl: mock.url, check: false, run, http, ...quiet, healthWaitMs: 10, selfPath: null, tmpRoot });
        expect(code).toBe(0);
        const inst = calls.filter((c) => c.args.some((a) => a.endsWith("install.sh")));
        expect(inst).toHaveLength(1);
        expect(inst[0]!.opts?.env).toEqual(want);
      } finally {
        if (env !== undefined) process.env.WSLENV = env;
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });
  }
});
