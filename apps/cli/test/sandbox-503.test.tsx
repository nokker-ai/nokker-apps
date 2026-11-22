import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import { App } from "../src/ui/App.js";
import { setLang } from "../src/i18n/index.js";

let dir: string;
let work: string;
let mock: MockServerHandle;
const keep = process.env.NOKKER_CONFIG_DIR_OVERRIDE;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function frameHas(r: ReturnType<typeof render>, text: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!(r.lastFrame() ?? "").includes(text)) {
    if (Date.now() - t0 > ms) throw new Error(`absent : ${text}\n${r.lastFrame()}`);
    await wait(25);
  }
}
async function open(name: string) {
  const root = join(work, name);
  await mkdir(join(root, ".git"), { recursive: true });
  return render(<App baseUrl={mock.url} cwd={root} />);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-cli-503-"));
  work = await mkdtemp(join(tmpdir(), "nokker-cli-503w-"));
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
beforeEach(() => setLang("en"));
afterEach(() => {
  mock.state.sandboxUnavailable = null;
  setLang("en");
});

describe("session de code refusée : bac à sable indisponible (503)", () => {
  const MSG = "Le bac à sable n'a pas été démarré : le plafond mémoire/CPU demandé n'est pas appliqué. Vérifie docker puis relance.";
  it("affiche le MESSAGE du noyau et dit que la CLI reste en fil ordinaire, sans le texte brut de l'erreur", async () => {
    mock.state.sandboxUnavailable = { message: MSG };
    const r = await open("msg");
    await frameHas(r, "Code session refused");
    // Le message est long : l'écran le replie sur plusieurs lignes ; on compare à espaces normalisés.
    const f = (r.lastFrame() ?? "").replace(/\s+/g, " ");
    expect(f).toContain("plafond mémoire/CPU demandé n'est pas appliqué");
    expect(f).toContain("stays in a plain thread");
    expect(f).toContain("no code is run");
    expect(f).not.toContain("NokkerApiError");
    expect(f).not.toContain("/v1/local/sessions");
    r.unmount();
  });
  it("en français", async () => {
    setLang("fr");
    mock.state.sandboxUnavailable = { message: MSG };
    const r = await open("fr");
    await frameHas(r, "Session de code refusée");
    expect((r.lastFrame() ?? "").replace(/\s+/g, " ")).toContain("La CLI reste en fil ordinaire : aucun code n'est exécuté ici.");
    r.unmount();
  });
  it("corps vide : repli sur le statut seulement", async () => {
    mock.state.sandboxUnavailable = { message: null };
    const r = await open("empty");
    await frameHas(r, "Code session refused");
    const f = (r.lastFrame() ?? "").replace(/\s+/g, " ");
    expect(f).toContain("the sandbox is not available (HTTP 503)");
    expect(f).toContain("stays in a plain thread");
    r.unmount();
  });
});
