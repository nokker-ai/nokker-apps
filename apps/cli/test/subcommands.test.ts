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
const releases = (tags: Array<{ tag_name: string; prerelease?: boolean; draft?: boolean }>, assets: Record<string, Buffer | number> = {}): NonNullable<Parameters<typeof runUpdate>[0]["http"]> =>
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
    expect(byName["docker"]!.detail).toContain("is not installed");
    expect(byName["server"]!.status).toBe("ok");
    expect(byName["server"]!.detail).toContain("MOCK");
    expect(byName["authentication"]!.status).toBe("ok"); // jeton local écrit par le mock dans `dir`
    expect(byName["client version"]!.status).toBe("ko"); // minimale 9.0.0 annoncée
    expect(byName["git"]!.status).toBe("ok");
    expect(byName["memory"]).toMatchObject({ status: "ok" });
    expect(byName["memory"]!.detail).toBe("direct, 12 note(s), embeddings 768 dim in 14 ms, last recall 230 ms");
    expect(code).toBe(1);
    expect(formatChecks(checks)).toContain("✗ docker");
  });

  it("mémoire : avertissement en mcp/off, échec avec la raison du noyau si ok est faux", async () => {
    const keepMem = mock.state.memory;
    const memLine = async () =>
      (await runDoctor({ serverUrl: mock.url, fix: false, run: noDocker, candidates: [] })).checks.find((c) => c.name === "memory")!;
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
    const srv = checks.find((c) => c.name === "server")!;
    expect(srv.status).toBe("ko");
    expect(checks.find((c) => c.name === "Lokkal compose")!.status).toBe("ok");
    expect(calls.some((c) => c.join(" ") === `docker compose -p nokker -f ${compose} up -d`)).toBe(true);
    expect(checks.some((c) => c.name === "repair" && c.status === "ok")).toBe(true);
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
    expect(err).toContain("no Lokkal installed");
    expect(err).toContain("--component cli");
  });

  it("lokkal.json incomplet : dit quelles clés manquent", async () => {
    await writeFile(join(dir, "lokkal.json"), JSON.stringify({ compose: "/x/docker-compose.yml", project: "nokker" }));
    let err = "";
    const code = await runLogs({ follow: false, lines: 10, since: null, component: "core", run: noDocker, err: (t) => (err += t) });
    expect(code).toBe(1);
    expect(err).toContain("missing or empty key(s)");
    expect(err).toContain("core_service");
    expect(err).toContain("token_path");
  });

  it("noyau sans docker : explication", async () => {
    await writeLokkal();
    let err = "";
    const code = await runLogs({ follow: false, lines: 10, since: null, component: "core", run: noDocker, err: (t) => (err += t) });
    expect(code).toBe(1);
    expect(err).toContain("docker is not installed");
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
    expect(validateLokkal({ compose: "rel/x.yml", project: "p", version: "1", core_service: "core", api_url: "u", web_url: "w", token_path: "/t", env_file: "/e" })).toMatchObject({ error: expect.stringContaining("non-absolute") });
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
    expect(ok.checks.find((c) => c.name === "web interface")!.status).toBe("ok");
    const ko = await runDoctor({ serverUrl: mock.url, fix: false, run: noDocker, candidates: [], http: async () => ({ status: 503 }) });
    expect(ko.checks.find((c) => c.name === "web interface")!.detail).toContain("503");
    await rm(join(dir, "lokkal.json"));
  });

  it("doctor dit d'où vient le serveur", async () => {
    const { checks } = await runDoctor({ serverUrl: "http://127.0.0.1:1", serverSource: "default", fix: false, run: noDocker, candidates: [] });
    expect(checks.find((c) => c.name === "server")!.detail).toContain("(default)");
  });
});

/** Exécuteur factice : enregistre les appels ; `cosign` absent (ENOENT), présent et valide, ou présent et refusant. */
function hostRun(calls: string[][], cosign: "absent" | "ok" | "bad"): Runner {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "cosign" && cosign === "absent") return { code: null, stdout: "", stderr: "", error: "ENOENT" };
    if (cmd === "cosign" && args[0] === "verify-blob" && cosign === "bad") return { code: 1, stdout: "", stderr: "no matching signatures\n" };
    return { code: 0, stdout: "", stderr: "" };
  };
}
const INSTALLER = Buffer.from("#!/bin/sh\necho installeur factice\n");
async function installerAssets(body: Buffer = INSTALLER, sha?: string): Promise<Record<string, Buffer>> {
  const { createHash } = await import("node:crypto");
  return {
    "/install.sh": body,
    "/install.sh.sha256": Buffer.from(`${sha ?? createHash("sha256").update(body).digest("hex")}  install.sh\n`),
    "/install.sh.sigstore.json": Buffer.from("{}"),
  };
}
/** Appels qui EXÉCUTENT un installeur (sh/bash sur un install.sh, directement ou via wsl.exe). */
const installerRuns = (calls: string[][]): string[][] => calls.filter((c) => c.some((a) => a.endsWith("install.sh")) && c[0] !== "cosign");

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
    expect(validateLokkal({ ...wsl, compose: "C:\\Users\\nina\\compose.yml" })).toMatchObject({ error: expect.stringContaining("Linux paths") });
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
    expect(d.checks.find((c) => c.name === "docker")!.detail).toContain("in WSL (Ubuntu)");

    const ucalls: string[][] = [];
    const code = await runUpdate({
      serverUrl: mock.url, check: false, run: hostRun(ucalls, "absent"), http: releases([{ tag_name: "lokkal-v0.2.0" }], await installerAssets()),
      out: () => {}, err: () => {}, healthWaitMs: 10, selfPath: null,
    });
    expect(code).toBe(0);
    const inst = installerRuns(ucalls);
    expect(inst).toHaveLength(1);
    // l'installeur téléchargé est sur le disque Windows : wslpath -u le traduit dans la distro
    expect(inst[0]!.slice(0, 6)).toEqual(["wsl.exe", "-d", "Ubuntu", "--", "sh", "-c"]);
    expect(inst[0]![6]).toContain("wslpath -u");
    expect(inst[0]![7]).toBe("sh");
    expect(inst[0]![8]).toMatch(/install\.sh$/);
    expect(inst[0]!.slice(9)).toEqual(["--update", "--version", "0.2.0", "--dir", "/home/nina/.nokker"]);
    expect(ucalls.some((c) => c.includes("pull"))).toBe(false);
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
    expect(err).toContain("no Lokkal installed");
  });

  it("--check compare la version installée à la release lokkal-v* la plus haute (ignore les autres tags et les brouillons)", async () => {
    await writeLokkal({ version: "0.1.0" });
    let out = "";
    const http = releases([{ tag_name: "cli-v9.9.9" }, { tag_name: "lokkal-v0.3.0", draft: true }, { tag_name: "lokkal-v0.2.0-rc1", prerelease: true }, { tag_name: "lokkal-v0.2.0" }, { tag_name: "lokkal-v0.1.0" }]);
    const code = await runUpdate({ serverUrl: mock.url, check: true, run: noDocker, http, out: (t) => (out += t), err: () => {} });
    expect(code).toBe(0);
    expect(out).toContain("Installed: 0.1.0");
    expect(out).toContain("Latest release: 0.2.0");
    expect(out).toContain("update available");
  });

  it("--check tolère l'absence de réseau", async () => {
    await writeLokkal();
    let out = "";
    const code = await runUpdate({ serverUrl: mock.url, check: true, run: noDocker, http: noNetwork, out: (t) => (out += t), err: () => {} });
    expect(code).toBe(0);
    expect(out).toContain("GitHub unreachable");
  });

  it("sans docker : explique proprement", async () => {
    await writeLokkal();
    let err = "";
    const code = await runUpdate({ serverUrl: mock.url, check: false, run: noDocker, http: releases([{ tag_name: "lokkal-v0.2.0" }]), out: () => {}, err: (t) => (err += t) });
    expect(code).toBe(1);
    expect(err).toContain("docker is not installed");
  });

  it("sans install.sh : réécrit NOKKER_VERSION dans env_file puis pull + up -d (-p project -f compose)", async () => {
    const { compose, envFile } = await writeLokkal({ version: "0.1.0" });
    const calls: string[][] = [];
    let out = "";
    const code = await runUpdate({
      serverUrl: mock.url, check: false, run: recording(calls), http: releases([{ tag_name: "lokkal-v0.2.0" }]),
      out: (t) => (out += t), err: () => {}, healthWaitMs: 10, selfPath: null,
    });
    expect(code).toBe(0);
    expect((await readFile(envFile, "utf-8"))).toBe("FOO=1\nNOKKER_VERSION=0.2.0\n");
    const compose_calls = calls.filter((c) => c[1] === "compose").map((c) => c.join(" "));
    expect(compose_calls).toEqual([`docker compose -p nokker -f ${compose} pull`, `docker compose -p nokker -f ${compose} up -d`]);
    expect(out).toContain("0.1.0 → 0.2.0");
    expect(JSON.parse(await readFile(join(dir, "lokkal.json"), "utf-8")).version).toBe("0.2.0");
  });

  it("install.sh de la version CIBLE téléchargé, empreinte bonne : sh <install.sh> --update --version <cible>, cosign absent dit", async () => {
    const instDir = join(dir, "inst");
    await writeLokkal({ version: "0.1.0", install_dir: instDir });
    const tmpRoot = await mkdtemp(join(tmpdir(), "nokker-upd-tmp-"));
    const calls: string[][] = [];
    const urls: string[] = [];
    const base = releases([{ tag_name: "lokkal-v0.3.0" }], await installerAssets());
    const http = (async (url: string, init?: unknown) => (urls.push(url), base(url, init as never))) as typeof base;
    let out = "";
    const code = await runUpdate({ serverUrl: mock.url, check: false, run: hostRun(calls, "absent"), http, out: (t) => (out += t), err: () => {}, healthWaitMs: 10, selfPath: null, tmpRoot });
    expect(code).toBe(0);
    expect(urls).toContain("https://github.com/nokker-ai/nokker/releases/download/lokkal-v0.3.0/install.sh");
    expect(urls).toContain("https://github.com/nokker-ai/nokker/releases/download/lokkal-v0.3.0/install.sh.sha256");
    const inst = installerRuns(calls);
    expect(inst).toHaveLength(1);
    expect(inst[0]![0]).toBe("sh");
    expect(inst[0]![1]!.startsWith(tmpRoot)).toBe(true);
    expect(inst[0]!.slice(2)).toEqual(["--update", "--version", "0.3.0", "--dir", instDir]);
    expect(out).toContain("signature NOT verified (cosign is not installed)");
    expect(calls.some((c) => c.includes("pull"))).toBe(false);
    expect(await (await import("node:fs/promises")).readdir(tmpRoot)).toEqual([]); // dossier temporaire effacé
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("empreinte d'install.sh fausse : refus, rien n'est exécuté ni modifié", async () => {
    const { envFile } = await writeLokkal({ version: "0.1.0" });
    const tmpRoot = await mkdtemp(join(tmpdir(), "nokker-upd-tmp-"));
    const calls: string[][] = [];
    let err = "";
    const http = releases([{ tag_name: "lokkal-v0.3.0" }], await installerAssets(INSTALLER, "ab".repeat(32)));
    const code = await runUpdate({ serverUrl: mock.url, check: false, run: hostRun(calls, "ok"), http, out: () => {}, err: (t) => (err += t), healthWaitMs: 10, selfPath: null, tmpRoot });
    expect(code).toBe(1);
    expect(err).toContain("wrong sha256 checksum for install.sh");
    expect(err).toContain("Nothing was run");
    expect(installerRuns(calls)).toEqual([]);
    expect(calls.some((c) => c.includes("pull") || c.includes("up"))).toBe(false); // pas de repli non plus
    expect(await readFile(envFile, "utf-8")).toBe("FOO=1\nNOKKER_VERSION=0.1.0\n");
    expect(await (await import("node:fs/promises")).readdir(tmpRoot)).toEqual([]); // rien n'a même été écrit
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("install.sh sans .sha256 dans la release : refus (empreinte obligatoire)", async () => {
    await writeLokkal({ version: "0.1.0" });
    const calls: string[][] = [];
    let err = "";
    const http = releases([{ tag_name: "lokkal-v0.3.0" }], { "/install.sh": INSTALLER });
    expect(await runUpdate({ serverUrl: mock.url, check: false, run: hostRun(calls, "absent"), http, out: () => {}, err: (t) => (err += t), healthWaitMs: 10, selfPath: null })).toBe(1);
    expect(err).toContain("no install.sh.sha256");
    expect(installerRuns(calls)).toEqual([]);
  });

  it("cosign présent : verify-blob avec l'identité et l'émetteur d'install.sh ; signature fausse = refus", async () => {
    await writeLokkal({ version: "0.1.0" });
    const calls: string[][] = [];
    let out = "";
    const http = releases([{ tag_name: "lokkal-v0.3.0" }], await installerAssets());
    expect(await runUpdate({ serverUrl: mock.url, check: false, run: hostRun(calls, "ok"), http, out: (t) => (out += t), err: () => {}, healthWaitMs: 10, selfPath: null })).toBe(0);
    const v = calls.find((c) => c[0] === "cosign" && c[1] === "verify-blob")!;
    expect(v).toContain("--bundle");
    expect(v[v.indexOf("--certificate-identity-regexp") + 1]).toBe("^https://github\\.com/nokker-ai/nokker/\\.github/workflows/lokkal-images\\.yml@refs/tags/lokkal-v");
    expect(v[v.indexOf("--certificate-oidc-issuer") + 1]).toBe("https://token.actions.githubusercontent.com");
    expect(v.at(-1)).toMatch(/install\.sh$/);
    expect(out).toContain("sha256 and cosign signature verified");
    expect(installerRuns(calls)).toHaveLength(1);

    const bad: string[][] = [];
    let err = "";
    expect(await runUpdate({ serverUrl: mock.url, check: false, run: hostRun(bad, "bad"), http, out: () => {}, err: (t) => (err += t), healthWaitMs: 10, selfPath: null })).toBe(1);
    expect(err).toContain("cosign verification of install.sh failed (no matching signatures)");
    expect(installerRuns(bad)).toEqual([]);
  });

  it("--version X.Y.Z : cible explicite, sans consulter la liste des releases ; retour en arrière refusé", async () => {
    await writeLokkal({ version: "0.1.0" });
    const calls: string[][] = [];
    const urls: string[] = [];
    const base = releases([], await installerAssets());
    const http = (async (url: string, init?: unknown) => (urls.push(url), base(url, init as never))) as typeof base;
    expect(await runUpdate({ serverUrl: mock.url, check: false, version: "0.2.5", run: hostRun(calls, "absent"), http, out: () => {}, err: () => {}, healthWaitMs: 10, selfPath: null })).toBe(0);
    expect(urls.some((u) => u.includes("api.github.com"))).toBe(false);
    expect(urls[0]).toBe("https://github.com/nokker-ai/nokker/releases/download/lokkal-v0.2.5/install.sh");
    expect(installerRuns(calls)[0]!.slice(2, 5)).toEqual(["--update", "--version", "0.2.5"]);

    await writeLokkal({ version: "0.3.0" });
    let err = "";
    const back: string[][] = [];
    expect(await runUpdate({ serverUrl: mock.url, check: false, version: "0.2.0", run: hostRun(back, "absent"), http, out: () => {}, err: (t) => (err += t), healthWaitMs: 10, selfPath: null })).toBe(1);
    expect(err).toContain("downgrades are not supported");
    expect(installerRuns(back)).toEqual([]);
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
    expect(out).toContain("sha256 verified");
    expect(out).not.toContain("cosign verified");
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
    expect(err).toContain("Wrong sha256 checksum");
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
    expect(out).toContain("sha256 + cosign verified");

    await writeFile(self, "ancien");
    let err = "";
    const koRun: Runner = async (cmd, args) => (cmd === "cosign" && args[0] === "verify-blob" ? { code: 1, stdout: "", stderr: "signature invalide\n" } : { code: 0, stdout: "", stderr: "" });
    expect(await runUpdate({ serverUrl: mock.url, check: false, run: koRun, http: releases([{ tag_name: "lokkal-v0.2.0" }], assets), out: () => {}, err: (t) => (err += t), selfPath: self, platform: linux })).toBe(1);
    expect(err).toContain("cosign verification failed");
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

  it("latestRelease : la plus haute en semver, quel que soit l'ordre de l'API", async () => {
    const { latestRelease } = await import("../src/update.js");
    const latest = async (tags: Array<{ tag_name: string; prerelease?: boolean; draft?: boolean }>) => (await latestRelease(releases(tags)))?.version ?? null;
    const pre = (v: string) => ({ tag_name: `lokkal-v${v}`, prerelease: true });
    expect(await latest([pre("0.1.0-rc.9"), pre("0.1.0-rc.10"), pre("0.1.0-rc.2")])).toBe("0.1.0-rc.10");
    expect(await latest([pre("0.1.0-rc.8"), pre("0.1.0-rc.8.1"), pre("0.1.0-rc.7")])).toBe("0.1.0-rc.8.1");
    expect(await latest([pre("0.1.0-rc.8.1"), { tag_name: "lokkal-v0.1.0" }, pre("0.1.0-rc.12")])).toBe("0.1.0");
    // préversion retenue seulement si aucune finale n'est plus haute
    expect(await latest([{ tag_name: "lokkal-v0.1.0" }, pre("0.2.0-rc.1")])).toBe("0.2.0-rc.1");
    expect(await latest([pre("0.2.0-rc.1"), { tag_name: "lokkal-v0.2.1" }, pre("0.2.1-rc.3")])).toBe("0.2.1");
    // ordre de l'API mélangé, brouillon plus haut ignoré, tags étrangers ou mal formés ignorés
    expect(
      await latest([
        pre("0.1.0-rc.7"), { tag_name: "lokkal-v0.0.9" }, { tag_name: "lokkal-v9.0.0", draft: true }, { tag_name: "cli-v5.0.0" },
        { tag_name: "lokkal-vnext" }, pre("0.1.0-rc.10"), { tag_name: "lokkal-v0.0.10" }, pre("0.1.0-rc.8.1"),
      ]),
    ).toBe("0.1.0-rc.10");
    expect(await latest([{ tag_name: "lokkal-v1.0.0", draft: true }])).toBeNull();
  });

  it("compareSemver", async () => {
    const { compareSemver } = await import("../src/version.js");
    expect(compareSemver("0.1.0-rc.10", "0.1.0-rc.9")).toBe(1);
    expect(compareSemver("0.1.0-rc.8.1", "0.1.0-rc.8")).toBe(1);
    expect(compareSemver("0.1.0", "0.1.0-rc.99")).toBe(1);
    expect(compareSemver("0.1.0-rc.7", "0.1.0")).toBe(-1);
    expect(compareSemver("0.1.0-rc.8", "0.1.0-rc.8")).toBe(0);
    expect(compareSemver("0.1.0-rc10", "0.1.0-rc9")).toBe(1);
    expect(compareSemver("0.1.0-1", "0.1.0-alpha")).toBe(-1);
    expect(compareSemver("0.2.0-rc.1", "0.1.9")).toBe(1);
  });

  it("noyau en rc.7, cible rc.8 : la mise à jour a bien lieu (les préversions comptent)", async () => {
    await writeLokkal({ version: "0.1.0-rc.7" });
    const calls: string[][] = [];
    const http = releases([{ tag_name: "lokkal-v0.1.0-rc.7", prerelease: true }, { tag_name: "lokkal-v0.1.0-rc.8", prerelease: true }], await installerAssets());
    expect(await runUpdate({ serverUrl: mock.url, check: false, run: hostRun(calls, "absent"), http, out: () => {}, err: () => {}, healthWaitMs: 10, selfPath: null })).toBe(0);
    expect(installerRuns(calls)[0]!.slice(2, 5)).toEqual(["--update", "--version", "0.1.0-rc.8"]);
  });

  it("versions", () => {
    expect(compareVersions("0.1.0", "0.1.10")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc1")).toBe(0);
    expect(clientHint({ min_client_version: "99.0.0" })).toContain("nokker update");
    expect(clientHint({})).toBeNull();
  });
});
