import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import { formatSessions, openLink, runOpen, runSessions, shortAgent, webPath } from "../src/access.js";
import { parseArgs } from "../src/cli-args.js";
import { setLang } from "../src/i18n/index.js";

let mock: MockServerHandle;
let dir: string;
let client: NokkerClient;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-cli-access-"));
  mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: dir });
  client = new NokkerClient({ baseUrl: mock.url, token: mock.localToken! });
});
afterAll(async () => {
  await mock.close();
  await rm(dir, { recursive: true, force: true });
});
const io = () => {
  const o: string[] = [];
  const e: string[] = [];
  return { o, e, io: { out: (s: string) => void o.push(s), err: (s: string) => void e.push(s) } };
};

describe("nokker open : un lien à code, jamais le jeton local", () => {
  it("chemins : /setup, setup, rien = racine ; jamais une adresse, un fragment ou ..", () => {
    expect(webPath("/setup")).toBe("/setup");
    expect(webPath("setup")).toBe("/setup");
    expect(webPath(undefined)).toBe("/");
    expect(webPath("https://evil.example/x")).toBeNull();
    expect(webPath("/a#token=x")).toBeNull();
    expect(webPath("/../etc")).toBeNull();
    expect(openLink("http://127.0.0.1:8743/", "/setup", "CODE")).toBe("http://127.0.0.1:8743/setup#code=CODE");
    expect(openLink("http://127.0.0.1:8743", "/", "CODE")).toBe("http://127.0.0.1:8743/#code=CODE");
  });
  it("affiche le lien (stdout) avec un code qui s'échange une fois ; la durée sur stderr ; le jeton local n'apparaît nulle part", async () => {
    const { o, e, io: x } = io();
    expect(await runOpen(client, "http://127.0.0.1:8743", "/setup", x)).toBe(0);
    const link = o.join("").trim();
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:8743\/setup#code=[A-Za-z0-9_-]{16,}$/);
    expect(link + e.join("")).not.toContain(mock.localToken!);
    expect(e.join("")).toContain("60 s");
    const code = link.split("#code=")[1]!;
    expect((await new NokkerClient({ baseUrl: mock.url }).exchangeSessionCode(code)).token).toBeTruthy();
  });
  it("--code : le code SEUL sur stdout (sans lien, sans jeton local), portée propriétaire ; l'échange rend scope owner", async () => {
    expect(parseArgs(["open", "--code"])).toMatchObject({ command: "open", codeOnly: true, positional: [], error: null });
    expect(parseArgs(["open", "--code", "/setup"]).error).toMatch(/--code/);
    const { o, e, io: x } = io();
    expect(await runOpen(client, null, undefined, x, { codeOnly: true })).toBe(0); // pas besoin d'adresse web
    const out = o.join("");
    expect(out).toMatch(/^[A-Za-z0-9_-]{16,}\n$/);
    expect(out + e.join("")).not.toContain(mock.localToken!);
    expect(e.join("")).toContain("60 s");
    const ex = await new NokkerClient({ baseUrl: mock.url }).exchangeSessionCode(out.trim());
    expect(ex.scope).toBe("owner");
  });
  it("sans adresse web (pas de lokkal.json) ou chemin refusé : une erreur claire, aucun code gaspillé", async () => {
    const a = io();
    expect(await runOpen(client, null, "/setup", a.io)).toBe(1);
    expect(a.e.join("")).toMatch(/lokkal\.json/);
    const b = io();
    expect(await runOpen(client, "http://127.0.0.1:8743", "https://evil.example", b.io)).toBe(2);
  });
  it("français", async () => {
    setLang("fr");
    const { e, io: x } = io();
    await runOpen(client, "http://127.0.0.1:8743", "/", x);
    expect(e.join("")).toContain("Ouvre ce lien dans ton navigateur dans les 60 s");
    setLang("en");
  });
});

describe("nokker sessions : lister, révoquer", () => {
  it("liste les sessions d'accès (jamais leur jeton) ; revoke en révoque une ; inconnue : erreur claire", async () => {
    const { code } = await client.mintSessionCode();
    const { token } = await new NokkerClient({ baseUrl: mock.url }).exchangeSessionCode(code);
    const l = io();
    expect(await runSessions(client, [], l.io)).toBe(0);
    const out = l.o.join("");
    expect(out).toMatch(/as_[0-9a-f]{16}/);
    expect(out).toContain("last used");
    expect(out).not.toContain(token);
    const id = /as_[0-9a-f]{16}/.exec(out)![0];
    const r = io();
    expect(await runSessions(client, ["revoke", id], r.io)).toBe(0);
    expect(r.o.join("")).toContain(`Session ${id} revoked`);
    const again = io();
    expect(await runSessions(client, ["revoke", id], again.io)).toBe(1);
    expect(again.e.join("")).toContain("no such session");
    expect(formatSessions([])).toContain("No access session");
  });
  it("une session d'accès ne peut pas mint ni lister : la CLI le dit", async () => {
    const { code } = await client.mintSessionCode();
    const { token } = await new NokkerClient({ baseUrl: mock.url }).exchangeSessionCode(code);
    const viaSession = new NokkerClient({ baseUrl: mock.url, token });
    const a = io();
    expect(await runOpen(viaSession, "http://127.0.0.1:8743", "/", a.io)).toBe(1);
    expect(a.e.join("")).toMatch(/local key was refused/);
  });
});

describe("agent d'une session : lisible, pas le début d'un User-Agent", () => {
  it("navigateur · système ; un agent qui n'est pas un navigateur reste tel quel", () => {
    expect(shortAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")).toBe("Chrome 131 · Linux");
    expect(shortAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.56")).toBe("Edge 130 · Windows");
    expect(shortAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15")).toBe("Safari 17 · macOS");
    expect(shortAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1")).toBe("Safari 17 · iOS");
    expect(shortAgent("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0")).toBe("Firefox 133 · Linux");
    expect(shortAgent("nokker/0.1.0 (linux)")).toBe("nokker/0.1.0 (linux)");
    expect(shortAgent("x".repeat(80))).toHaveLength(40);
    expect(shortAgent("")).toBe("-");
  });
});

describe("arguments", () => {
  it("open [chemin] et sessions [revoke <id>] ; le reste est refusé", () => {
    expect(parseArgs(["open", "/setup"])).toMatchObject({ command: "open", positional: ["/setup"], error: null });
    expect(parseArgs(["open"])).toMatchObject({ command: "open", positional: [] });
    expect(parseArgs(["sessions"])).toMatchObject({ command: "sessions", positional: [] });
    expect(parseArgs(["sessions", "revoke", "as_0123456789abcdef"])).toMatchObject({ positional: ["revoke", "as_0123456789abcdef"], error: null });
    expect(parseArgs(["open", "a", "b"]).error).toMatch(/one path/);
    expect(parseArgs(["sessions", "revoke"]).error).toMatch(/revoke <id>/);
    expect(parseArgs(["sessions", "zap"]).error).toMatch(/revoke <id>/);
  });
});
