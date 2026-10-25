/** `doctor`, `logs`, `update` : avec un exécuteur factice (pas de docker réel) et un vrai mock pour /healthz. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import type { Runner } from "../src/proc.js";
import { formatChecks, runDoctor } from "../src/doctor.js";
import { filterCliLog, runLogs, sinceForDocker, sinceToMs } from "../src/logs.js";
import { clientHint, runUpdate } from "../src/update.js";
import { compareVersions } from "../src/version.js";

let dir: string;
let mock: MockServerHandle;
const keep = process.env.NOKKER_CONFIG_DIR_OVERRIDE;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-cli-sub-"));
  process.env.NOKKER_CONFIG_DIR_OVERRIDE = dir;
  mock = await startMockServer({ port: 0, seed: false, minClientVersion: "9.0.0" });
});
afterAll(async () => {
  await mock.close();
  if (keep === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
  else process.env.NOKKER_CONFIG_DIR_OVERRIDE = keep;
  await rm(dir, { recursive: true, force: true });
});

async function writeLokkal(over: Record<string, unknown> = {}): Promise<{ compose: string; envFile: string }> {
  const compose = join(dir, "docker-compose.yml");
  const envFile = join(dir, ".env");
  await writeFile(compose, "services: {}\n");
  await writeFile(envFile, "FOO=1\nNOKKER_VERSION=0.1.0\n");
  await writeFile(
    join(dir, "lokkal.json"),
    JSON.stringify({ compose, project: "nokker", version: "0.1.0", core_service: "core", api_url: "http://127.0.0.1:8742", web_url: "http://127.0.0.1:7420", token_path: join(dir, "state", "local-token"), env_file: envFile, ...over }),
  );
  return { compose, envFile };
}
const releases = (tags: Array<{ tag_name: string; prerelease?: boolean }>, assets: Record<string, Buffer | number> = {}): NonNullable<Parameters<typeof runUpdate>[0]["http"]> =>
  (async (url: string) => {
    const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => String(body), arrayBuffer: async () => body as ArrayBuffer });
    if (url.includes("api.github.com")) return ok(tags);
    const hit = Object.entries(assets).find(([k]) => url.endsWith(k));
    if (!hit) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
    const b = hit[1] as Buffer;
    return { ok: true, status: 200, headers: { get: (h: string) => (h.toLowerCase() === "content-length" ? String(b.length) : null) }, json: async () => ({}), text: async () => b.toString(), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
  }) as never;
const noNetwork: NonNullable<Parameters<typeof runUpdate>[0]["http"]> = (async () => { throw new Error("réseau coupé"); }) as never;

const noDocker: Runner = async (cmd) => (cmd === "git" ? { code: 0, stdout: "git version 2.47.3\n", stderr: "" } : { code: null, stdout: "", stderr: "", error: "ENOENT" });
function recording(calls: string[][], overrides: Record<string, { code: number; stdout?: string }> = {}): Runner {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(" ");
    const hit = Object.entries(overrides).find(([k]) => key.includes(k));
    if (hit) return { code: hit[1].code, stdout: hit[1].stdout ?? "", stderr: "" };
    return { code: 0, stdout: cmd === "git" ? "git version 2.47.3\n" : "", stderr: "" };
  };
}

describe("doctor", () => {
  it("sans docker : table lisible, pas d'exception, code 1", async () => {
    const { checks, code } = await runDoctor({ serverUrl: mock.url, fix: false, run: noDocker, candidates: [] });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["docker"]!.status).toBe("ko");
    expect(byName["docker"]!.detail).toContain("pas installé");
    expect(byName["serveur"]!.status).toBe("ok");
    expect(byName["serveur"]!.detail).toContain("MOCK");
    expect(byName["authentification"]!.status).toBe("ok"); // jeton local écrit par le mock dans `dir`
    expect(byName["version client"]!.status).toBe("ko"); // minimale 9.0.0 annoncée
    expect(byName["git"]!.status).toBe("ok");
    expect(byName["mémoire"]).toMatchObject({ status: "ok" });
    expect(byName["mémoire"]!.detail).toBe("directe, 12 note(s), plongements 768 dim en 14 ms, dernier rappel 230 ms");
    expect(code).toBe(1);
    expect(formatChecks(checks)).toContain("✗ docker");
  });

  it("mémoire : avertissement en mcp/off, échec avec la raison du noyau si ok est faux", async () => {
    const keepMem = mock.state.memory;
    const memLine = async () =>
      (await runDoctor({ serverUrl: mock.url, fix: false, run: noDocker, candidates: [] })).checks.find((c) => c.name === "mémoire")!;
    try {
      mock.state.memory = { mode: "off", ok: null };
      expect((await memLine()).status).toBe("warn");
      mock.state.memory = { mode: "mcp", ok: null };
      expect(await memLine()).toMatchObject({ status: "warn", detail: expect.stringContaining("MCP") });
      mock.state.memory = { mode: "direct", ok: false, error: "base de la mémoire injoignable : connection refused", store: { ok: false } };
      const ko = await memLine();
      expect(ko.status).toBe("ko");
      expect(ko.detail).toContain("base de la mémoire injoignable : connection refused");
    } finally {
      mock.state.memory = keepMem;
    }
  });

  it("serveur injoignable : le dit, et --fix relance docker compose up -d quand le compose est connu", async () => {
    const { compose } = await writeLokkal();
    const calls: string[][] = [];
    const { checks } = await runDoctor({ serverUrl: "http://127.0.0.1:1", fix: true, run: recording(calls), candidates: [] });
    const srv = checks.find((c) => c.name === "serveur")!;
    expect(srv.status).toBe("ko");
    expect(checks.find((c) => c.name === "compose Lokkal")!.status).toBe("ok");
    expect(calls.some((c) => c.join(" ") === `docker compose -p nokker -f ${compose} up -d`)).toBe(true);
    expect(checks.some((c) => c.name === "réparation" && c.status === "ok")).toBe(true);
  });
});

describe("logs", () => {
  it("--since et conversions", () => {
    expect(sinceToMs("30m")).toBe(1_800_000);
    expect(sinceForDocker("2d")).toBe("48h");
    expect(sinceForDocker("30m")).toBe("30m");
    const now = Date.parse("2026-10-23T12:00:00Z");
    const text = ["2026-10-22T01:00:00Z INFO vieux", "2026-10-23T11:30:00Z INFO récent", "2026-10-23T11:59:00Z WARN tout récent"].join("\n");
    expect(filterCliLog(text, 10, "1h", now)).toEqual(["2026-10-23T11:30:00Z INFO récent", "2026-10-23T11:59:00Z WARN tout récent"]);
    expect(filterCliLog(text, 1, null, now)).toHaveLength(1);
  });

  it("noyau sans lokkal.json : explication, code 1, pas de trace", async () => {
    await rm(join(dir, "lokkal.json"), { force: true });
    let err = "";
    const code = await runLogs({ follow: false, lines: 10, since: null, component: "core", run: noDocker, err: (t) => (err += t) });
    expect(code).toBe(1);
    expect(err).toContain("aucun Lokkal installé");
    expect(err).toContain("--component cli");
  });

  it("lokkal.json incomplet : dit quelles clés manquent", async () => {
    await writeFile(join(dir, "lokkal.json"), JSON.stringify({ compose: "/x/docker-compose.yml", project: "nokker" }));
    let err = "";
    const code = await runLogs({ follow: false, lines: 10, since: null, component: "core", run: noDocker, err: (t) => (err += t) });
    expect(code).toBe(1);
    expect(err).toContain("clé(s) manquante(s)");
    expect(err).toContain("core_service");
    expect(err).toContain("token_path");
  });

  it("noyau sans docker : explication", async () => {
    await writeLokkal();
    let err = "";
    const code = await runLogs({ follow: false, lines: 10, since: null, component: "core", run: noDocker, err: (t) => (err += t) });
    expect(code).toBe(1);
    expect(err).toContain("docker n'est pas installé");
  });

  it("noyau avec docker : docker compose -p <project> -f <compose> logs <core_service>", async () => {
    const { compose } = await writeLokkal({ core_service: "core" });
    const calls: string[][] = [];
    const code = await runLogs({ follow: true, lines: 50, since: "2d", component: "core", run: recording(calls) });
    expect(code).toBe(0);
    const logs = calls.find((c) => c.includes("logs"))!;
    expect(logs.join(" ")).toBe(`docker compose -p nokker -f ${compose} logs --tail 50 --since 48h -f core`);
  });

  it("--component cli lit cli.log", async () => {
    await writeFile(join(dir, "cli.log"), `${new Date().toISOString()} INFO un\n${new Date().toISOString()} ERROR deux\n`);
    let out = "";
    const code = await runLogs({ follow: false, lines: 1, since: "1h", component: "cli", out: (t) => (out += t) });
    expect(code).toBe(0);
    expect(out).toContain("deux");
    expect(out).not.toContain("un\n");
  });
});

describe("lokkal.json et serveur", () => {
  it("validation : chemins absolus et clés obligatoires", async () => {
    const { validateLokkal } = await import("../src/lokkal.js");
    expect("config" in validateLokkal({ compose: "/a", project: "p", version: "1", core_service: "core", api_url: "u", web_url: "w", token_path: "/t", env_file: "/e" })).toBe(true);
    expect(validateLokkal({ compose: "rel/x.yml", project: "p", version: "1", core_service: "core", api_url: "u", web_url: "w", token_path: "/t", env_file: "/e" })).toMatchObject({ error: expect.stringContaining("non absolu") });
    expect(validateLokkal([])).toMatchObject({ error: expect.any(String) });
  });

  it("priorité --server > NOKKER_SERVER_URL > api_url > 8742", async () => {
    const { resolveServer } = await import("../src/lokkal.js");
    await writeLokkal({ api_url: "http://127.0.0.1:9001" });
    expect(resolveServer({ serverUrl: "http://s:1", serverExplicit: true }, {})).toEqual({ url: "http://s:1", source: "--server" });
    expect(resolveServer({ serverUrl: "http://e:2", serverExplicit: true }, { NOKKER_SERVER_URL: "http://e:2" })).toEqual({ url: "http://e:2", source: "NOKKER_SERVER_URL" });
    expect(resolveServer({ serverUrl: "http://127.0.0.1:8742", serverExplicit: false }, {})).toEqual({ url: "http://127.0.0.1:9001", source: "lokkal.json" });
    await rm(join(dir, "lokkal.json"));
    expect(resolveServer({ serverUrl: "http://127.0.0.1:8742", serverExplicit: false }, {})).toEqual({ url: "http://127.0.0.1:8742", source: "default" });
  });

  it("le jeton local se lit à token_path", async () => {
    const { readLocalToken } = await import("../src/auth.js");
    const { mkdir } = await import("node:fs/promises");
    await writeLokkal();
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "state", "local-token"), "tok-xyz\n");
    expect(await readLocalToken()).toBe("tok-xyz");
    await rm(join(dir, "lokkal.json"));
    expect(await readLocalToken()).not.toBe("tok-xyz"); // retombe sur <config>/local-token (celui du mock)
  });

  it("doctor contrôle GET <web_url>/healthz", async () => {
    await writeLokkal({ web_url: "http://127.0.0.1:7420" });
    const seen: string[] = [];
    const ok = await runDoctor({ serverUrl: mock.url, fix: false, run: noDocker, candidates: [], http: async (u) => (seen.push(u), { status: 200 }) });
    expect(seen).toEqual(["http://127.0.0.1:7420/healthz"]);
    expect(ok.checks.find((c) => c.name === "interface web")!.status).toBe("ok");
    const ko = await runDoctor({ serverUrl: mock.url, fix: false, run: noDocker, candidates: [], http: async () => ({ status: 503 }) });
    expect(ko.checks.find((c) => c.name === "interface web")!.detail).toContain("503");
    await rm(join(dir, "lokkal.json"));
  });

  it("doctor dit d'où vient le serveur", async () => {
    const { checks } = await runDoctor({ serverUrl: "http://127.0.0.1:1", serverSource: "default", fix: false, run: noDocker, candidates: [] });
    expect(checks.find((c) => c.name === "serveur")!.detail).toContain("(défaut)");
  });
});

describe("Windows + WSL 2 et install_dir", () => {
  const UNC = "\\\\wsl.localhost\\Ubuntu\\home\\nina\\.nokker\\state\\local-token";
  const wsl = {
    compose: "/home/nina/.nokker/docker-compose.yml", project: "nokker", version: "0.1.0", core_service: "core",
    api_url: "http://127.0.0.1:8742", web_url: "http://127.0.0.1:7420", token_path: UNC, env_file: "/home/nina/.nokker/.env",
    install_dir: "/home/nina/.nokker", wsl_distro: "Ubuntu",
  };

  it("valide le schéma WSL (compose/env_file/install_dir Linux, token_path UNC) et refuse les incohérences", async () => {
    const { validateLokkal, resolveTokenPath } = await import("../src/lokkal.js");
    const ok = validateLokkal(wsl);
    expect("config" in ok && ok.config.wsl_distro).toBe("Ubuntu");
    expect(validateLokkal({ ...wsl, install_dir: undefined })).toMatchObject({ error: expect.stringContaining("install_dir") });
    expect(validateLokkal({ ...wsl, compose: "C:\\Users\\nina\\compose.yml" })).toMatchObject({ error: expect.stringContaining("chemins Linux") });
    await writeFile(join(dir, "lokkal.json"), JSON.stringify(wsl));
    expect(resolveTokenPath()).toBe(UNC); // lu tel quel par fs depuis Windows
    await rm(join(dir, "lokkal.json"));
  });

  it("logs, doctor (docker) et update passent par wsl.exe -d <distro> --", async () => {
    await writeFile(join(dir, "lokkal.json"), JSON.stringify(wsl));
    const calls: string[][] = [];
    const run = recording(calls);
    expect(await runLogs({ follow: false, lines: 20, since: null, component: "core", run, out: () => {}, err: () => {} })).toBe(0);
    expect(calls.map((c) => c.join(" "))).toContain("wsl.exe -d Ubuntu -- docker compose -p nokker -f /home/nina/.nokker/docker-compose.yml logs --tail 20 core");

    const dcalls: string[][] = [];
    const d = await runDoctor({ serverUrl: mock.url, fix: false, run: recording(dcalls), candidates: [], http: async () => ({ status: 200 }) });
    expect(dcalls[0]!.join(" ")).toBe("wsl.exe -d Ubuntu -- docker info --format {{.ServerVersion}}");
    expect(d.checks.find((c) => c.name === "docker")!.detail).toContain("dans WSL (Ubuntu)");

    const ucalls: string[][] = [];
    const code = await runUpdate({
      serverUrl: mock.url, check: false, run: recording(ucalls), http: releases([{ tag_name: "lokkal-v0.2.0" }]),
      out: () => {}, err: () => {}, healthWaitMs: 10, selfPath: null,
    });
    expect(code).toBe(0);
    expect(ucalls.map((c) => c.join(" "))).toContain("wsl.exe -d Ubuntu -- sh /home/nina/.nokker/install.sh --update");
    expect(ucalls.some((c) => c.includes("pull"))).toBe(false);
    await rm(join(dir, "lokkal.json"));
  });

  it("Linux/macOS : <install_dir>/install.sh --update est préféré à celui du compose", async () => {
    const instDir = join(dir, "inst");
    await (await import("node:fs/promises")).mkdir(instDir, { recursive: true });
    await writeFile(join(instDir, "install.sh"), "#!/bin/sh\n");
    await writeLokkal({ install_dir: instDir });
    await writeFile(join(dir, "install.sh"), "#!/bin/sh\n"); // à côté du compose : doit perdre
    const calls: string[][] = [];
    await runUpdate({ serverUrl: mock.url, check: false, run: recording(calls), http: releases([{ tag_name: "lokkal-v0.2.0" }]), out: () => {}, err: () => {}, healthWaitMs: 10, selfPath: null });
    expect(calls.map((c) => c.join(" "))).toContain(`bash ${join(instDir, "install.sh")} --update`);
    await rm(join(dir, "install.sh"));
    await rm(join(dir, "lokkal.json"));
  });

  it("nom des assets Windows x64 et arm64", async () => {
    const { assetName } = await import("../src/update.js");
    expect(assetName({ os: "windows", arch: "x64" })).toBe("nokker-windows-x64.exe");
    expect(assetName({ os: "windows", arch: "arm64" })).toBe("nokker-windows-arm64.exe");
  });
});

describe("update", () => {
  it("sans lokkal.json : explique", async () => {
    await rm(join(dir, "lokkal.json"), { force: true });
    let err = "";
    const code = await runUpdate({ serverUrl: mock.url, check: false, run: noDocker, http: releases([]), out: () => {}, err: (t) => (err += t) });
    expect(code).toBe(1);
    expect(err).toContain("aucun Lokkal installé");
  });

  it("--check compare la version installée à la dernière release lokkal-v* (ignore les autres tags et préversions)", async () => {
    await writeLokkal({ version: "0.1.0" });
    let out = "";
    const http = releases([{ tag_name: "cli-v9.9.9" }, { tag_name: "lokkal-v0.3.0-rc1", prerelease: true }, { tag_name: "lokkal-v0.2.0" }, { tag_name: "lokkal-v0.1.0" }]);
    const code = await runUpdate({ serverUrl: mock.url, check: true, run: noDocker, http, out: (t) => (out += t), err: () => {} });
    expect(code).toBe(0);
    expect(out).toContain("Installé : 0.1.0");
    expect(out).toContain("Dernière release : 0.2.0");
    expect(out).toContain("mise à jour disponible");
  });

  it("--check tolère l'absence de réseau", async () => {
    await writeLokkal();
    let out = "";
    const code = await runUpdate({ serverUrl: mock.url, check: true, run: noDocker, http: noNetwork, out: (t) => (out += t), err: () => {} });
    expect(code).toBe(0);
    expect(out).toContain("GitHub injoignable");
  });

  it("sans docker : explique proprement", async () => {
    await writeLokkal();
    let err = "";
    const code = await runUpdate({ serverUrl: mock.url, check: false, run: noDocker, http: releases([{ tag_name: "lokkal-v0.2.0" }]), out: () => {}, err: (t) => (err += t) });
    expect(code).toBe(1);
    expect(err).toContain("docker n'est pas installé");
  });

  it("sans install.sh : réécrit NOKKER_VERSION dans env_file puis pull + up -d (-p project -f compose)", async () => {
    const { compose, envFile } = await writeLokkal({ version: "0.1.0" });
    const calls: string[][] = [];
    let out = "";
    const code = await runUpdate({
      serverUrl: mock.url, check: false, run: recording(calls), http: releases([{ tag_name: "lokkal-v0.2.0" }]),
      out: (t) => (out += t), err: () => {}, healthWaitMs: 10, selfPath: null, nokkerHome: join(dir, "nope"),
    });
    expect(code).toBe(0);
    expect((await readFile(envFile, "utf-8"))).toBe("FOO=1\nNOKKER_VERSION=0.2.0\n");
    const compose_calls = calls.filter((c) => c[1] === "compose").map((c) => c.join(" "));
    expect(compose_calls).toEqual([`docker compose -p nokker -f ${compose} pull`, `docker compose -p nokker -f ${compose} up -d`]);
    expect(out).toContain("0.1.0 → 0.2.0");
    expect(JSON.parse(await readFile(join(dir, "lokkal.json"), "utf-8")).version).toBe("0.2.0");
  });

  it("install.sh à côté du compose : préféré (install.sh --update)", async () => {
    await writeLokkal({ version: "0.1.0" });
    await writeFile(join(dir, "install.sh"), "#!/bin/sh\n");
    const calls: string[][] = [];
    const code = await runUpdate({
      serverUrl: mock.url, check: false, run: recording(calls), http: releases([{ tag_name: "lokkal-v0.2.0" }]),
      out: () => {}, err: () => {}, healthWaitMs: 10, selfPath: null,
    });
    expect(code).toBe(0);
    expect(calls.some((c) => c.join(" ") === `bash ${join(dir, "install.sh")} --update`)).toBe(true);
    expect(calls.some((c) => c.includes("pull"))).toBe(false);
    await rm(join(dir, "install.sh"));
  });

  const body = Buffer.alloc(1_200_000, 7);
  const shaOf = async (b: Buffer): Promise<Buffer> => {
    const { createHash } = await import("node:crypto");
    return Buffer.from(`${createHash("sha256").update(b).digest("hex")}  nokker-linux-x64\n`);
  };
  const noCosign: Runner = async (cmd) => (cmd === "cosign" ? { code: null, stdout: "", stderr: "", error: "ENOENT" } : { code: 0, stdout: "", stderr: "" });
  const linux = { os: "linux", arch: "x64" } as const;

  it("se remplace par le binaire de la release : sha256 vérifié, rename atomique (cosign absent)", async () => {
    await writeLokkal({ version: "0.2.0" }); // noyau déjà à jour : seul le client est remplacé
    const self = join(dir, "nokker");
    await writeFile(self, "ancien");
    let out = "";
    const http = releases([{ tag_name: "lokkal-v0.2.0" }], { "nokker-linux-x64": body, "nokker-linux-x64.sha256": await shaOf(body) });
    const code = await runUpdate({ serverUrl: mock.url, check: false, run: noCosign, http, out: (t) => (out += t), err: () => {}, selfPath: self, platform: linux });
    expect(code).toBe(0);
    expect((await readFile(self)).length).toBe(1_200_000);
    expect(out).toContain("sha256 vérifié");
    expect(out).not.toContain("cosign vérifiés");
  });

  it("sha256 absent de la release : refus (obligatoire), client intact", async () => {
    await writeLokkal({ version: "0.2.0" });
    const self = join(dir, "nokker");
    await writeFile(self, "ancien");
    let err = "";
    const http = releases([{ tag_name: "lokkal-v0.2.0" }], { "nokker-linux-x64": body });
    const code = await runUpdate({ serverUrl: mock.url, check: false, run: noCosign, http, out: () => {}, err: (t) => (err += t), selfPath: self, platform: linux });
    expect(code).toBe(1);
    expect(err).toContain("nokker-linux-x64.sha256");
    expect(await readFile(self, "utf-8")).toBe("ancien");
  });

  it("somme sha256 fausse : le client n'est pas touché", async () => {
    await writeLokkal({ version: "0.2.0" });
    const self = join(dir, "nokker");
    await writeFile(self, "ancien");
    let err = "";
    const http = releases([{ tag_name: "lokkal-v0.2.0" }], { "nokker-linux-x64": body, "nokker-linux-x64.sha256": Buffer.from("0".repeat(64)) });
    const code = await runUpdate({ serverUrl: mock.url, check: false, run: noCosign, http, out: () => {}, err: (t) => (err += t), selfPath: self, platform: linux });
    expect(code).toBe(1);
    expect(err).toContain("sha256 incorrecte");
    expect(await readFile(self, "utf-8")).toBe("ancien");
  });

  it("cosign présent : verify-blob --bundle en plus ; son échec empêche le remplacement", async () => {
    await writeLokkal({ version: "0.2.0" });
    const self = join(dir, "nokker");
    await writeFile(self, "ancien");
    const assets = { "nokker-linux-x64": body, "nokker-linux-x64.sha256": await shaOf(body), "nokker-linux-x64.sigstore.json": Buffer.from("{}") };
    const calls: string[][] = [];
    let out = "";
    const okRun: Runner = async (cmd, args) => (calls.push([cmd, ...args]), { code: 0, stdout: "", stderr: "" });
    expect(await runUpdate({ serverUrl: mock.url, check: false, run: okRun, http: releases([{ tag_name: "lokkal-v0.2.0" }], assets), out: (t) => (out += t), err: () => {}, selfPath: self, platform: linux })).toBe(0);
    expect(calls.some((c) => c[0] === "cosign" && c[1] === "verify-blob" && c.includes("--bundle"))).toBe(true);
    expect(out).toContain("sha256 + cosign vérifiés");

    await writeFile(self, "ancien");
    let err = "";
    const koRun: Runner = async (cmd, args) => (cmd === "cosign" && args[0] === "verify-blob" ? { code: 1, stdout: "", stderr: "signature invalide\n" } : { code: 0, stdout: "", stderr: "" });
    expect(await runUpdate({ serverUrl: mock.url, check: false, run: koRun, http: releases([{ tag_name: "lokkal-v0.2.0" }], assets), out: () => {}, err: (t) => (err += t), selfPath: self, platform: linux })).toBe(1);
    expect(err).toContain("Vérification cosign échouée");
    expect(await readFile(self, "utf-8")).toBe("ancien");
  });

  it("Windows : écrit nokker.exe.new et explique", async () => {
    await writeLokkal({ version: "0.2.0" });
    const self = join(dir, "nokker.exe");
    await writeFile(self, "ancien");
    const winBody = Buffer.alloc(1_200_000, 2);
    const { createHash } = await import("node:crypto");
    let out = "";
    const http = releases([{ tag_name: "lokkal-v0.2.0" }], { "nokker-windows-x64.exe": winBody, "nokker-windows-x64.exe.sha256": Buffer.from(`${createHash("sha256").update(winBody).digest("hex")}  nokker-windows-x64.exe\n`) });
    const code = await runUpdate({ serverUrl: mock.url, check: false, run: noCosign, http, out: (t) => (out += t), err: () => {}, selfPath: self, platform: { os: "windows", arch: "x64" } });
    expect(code).toBe(0);
    expect((await readFile(`${self}.new`)).length).toBe(1_200_000);
    expect(out).toContain("nokker.exe.new");
    expect(await readFile(self, "utf-8")).toBe("ancien");
  });

  it("versions", () => {
    expect(compareVersions("0.1.0", "0.1.10")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc1")).toBe(0);
    expect(clientHint({ min_client_version: "99.0.0" })).toContain("nokker update");
    expect(clientHint({})).toBeNull();
  });
});
