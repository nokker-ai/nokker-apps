import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import { NokkerClient } from "@nokker-apps/sdk";
import { App } from "../src/ui/App.js";
import { closeOpenSession, setSessionCloser } from "../src/closesession.js";
import { setLang } from "../src/i18n/index.js";

let dir: string;
let work: string;
let mock: MockServerHandle;
const keep = process.env.NOKKER_CONFIG_DIR_OVERRIDE;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("délai dépassé");
    await wait(25);
  }
}
async function openApp(name: string): Promise<{ r: ReturnType<typeof render>; id: string }> {
  const root = join(work, name);
  await mkdir(join(root, ".git"), { recursive: true });
  const r = render(<App baseUrl={mock.url} cwd={root} />);
  await until(() => mock.state.localSessions.size > 0);
  const id = [...mock.state.localSessions.keys()].at(-1)!;
  expect(mock.state.localSessions.size).toBe(1);
  await wait(400); // l'écran est prêt (le /quit pendant la connexion marche aussi, mais on mesure la sortie normale)
  return { r, id };
}
/** Une fois sorti, l'écran n'écoute plus le clavier : ce qu'on tape n'apparaît plus. */
async function exited(r: ReturnType<typeof render>, ms: number): Promise<boolean> {
  await wait(ms);
  const a = r.lastFrame() ?? "";
  r.stdin.write("qq");
  await wait(150);
  return (r.lastFrame() ?? "") === a;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-cli-close-"));
  work = await mkdtemp(join(tmpdir(), "nokker-cli-closew-"));
  process.env.NOKKER_CONFIG_DIR_OVERRIDE = dir;
  mock = await startMockServer({ port: 0, seed: false, speed: 0.05 });
});
afterAll(async () => {
  await mock.close();
  if (keep === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
  else process.env.NOKKER_CONFIG_DIR_OVERRIDE = keep;
  await rm(dir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});
beforeEach(() => {
  setLang("en");
  mock.state.closeCalls.length = 0;
  mock.state.closeHang = false;
  mock.state.localSessions.clear();
});
afterEach(() => setSessionCloser(null));

describe("SDK closeLocalSession", () => {
  it("200 : fermée ; 404 session_not_found : déjà fermée, pas une erreur", async () => {
    const c = new NokkerClient({ baseUrl: mock.url, token: mock.localToken! });
    mock.state.localSessions.set("t_a", { cwd: work, root: work, backend: "mock" });
    expect(await c.closeLocalSession("t_a")).toEqual({ closed: true });
    expect(await c.closeLocalSession("t_a")).toEqual({ closed: false });
  });
});

describe("fermeture de la session de code à la sortie", () => {
  it("/quit appelle DELETE /v1/local/sessions/{fil} puis sort", async () => {
    const { r, id } = await openApp("quit");
    r.stdin.write("/quit");
    await wait(80);
    r.stdin.write("\r");
    await until(() => mock.state.closeCalls.includes(id));
    expect(mock.state.localSessions.has(id)).toBe(false);
    expect(await exited(r, 600)).toBe(true);
  });

  it("Ctrl+C appelle la fermeture", async () => {
    const { r, id } = await openApp("ctrlc");
    r.stdin.write("\x03");
    await until(() => mock.state.closeCalls.includes(id));
    expect(await exited(r, 600)).toBe(true);
  });

  it("Ctrl+D (fin de fichier) sur une saisie vide appelle la fermeture", async () => {
    const { r, id } = await openApp("eof");
    r.stdin.write("\x04");
    await until(() => mock.state.closeCalls.includes(id));
    expect(await exited(r, 600)).toBe(true);
  });

  it("/quit lancé depuis un /thread ferme quand même la session de code ouverte plus tôt", async () => {
    const { r, id } = await openApp("thread");
    r.stdin.write("/thread autre");
    await wait(80);
    r.stdin.write("\r");
    await until(() => (r.lastFrame() ?? "").includes("New thread"));
    expect(mock.state.closeCalls).toEqual([]);
    r.stdin.write("/quit");
    await wait(80);
    r.stdin.write("\r");
    await until(() => mock.state.closeCalls.includes(id));
    expect(mock.state.localSessions.has(id)).toBe(false);
    expect(await exited(r, 600)).toBe(true);
  });

  it("noyau muet : la sortie se fait quand même (≤ 1,5 s de plus)", async () => {
    const { r, id } = await openApp("hang");
    mock.state.closeHang = true;
    const t0 = Date.now();
    r.stdin.write("\x03");
    await until(() => mock.state.closeCalls.includes(id));
    expect(await exited(r, 2200)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("closeOpenSession", () => {
  it("rend la main au bout du délai même si la fermeture ne finit jamais, et ne rejette pas", async () => {
    setSessionCloser(() => new Promise<void>(() => undefined));
    const t0 = Date.now();
    await closeOpenSession(200);
    expect(Date.now() - t0).toBeLessThan(1000);
    setSessionCloser(() => Promise.reject(new Error("boom")));
    await expect(closeOpenSession(200)).resolves.toBeUndefined();
  });
  it("une seule fermeture par session", async () => {
    let n = 0;
    setSessionCloser(async () => void n++);
    await closeOpenSession();
    await closeOpenSession();
    expect(n).toBe(1);
  });
});
