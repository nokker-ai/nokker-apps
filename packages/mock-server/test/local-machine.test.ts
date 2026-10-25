import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { LOCAL_TOKEN, startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let c: NokkerClient;
beforeEach(async () => {
  mock = await startMockServer({ speed: 0.01, seed: false });
  c = new NokkerClient({ baseUrl: mock.url, token: LOCAL_TOKEN });
});
afterEach(async () => {
  await mock.close();
});
const dev = (body: unknown) => fetch(`${mock.url}/v1/dev/local-machine-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const status = async (p: Promise<unknown>): Promise<number> => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof NokkerApiError ? e.status : -1;
  }
};

describe("routes locales de Lokkal (X6, X4, X3)", () => {
  it("sans jeton local : 401", async () => {
    const anon = new NokkerClient({ baseUrl: mock.url });
    expect(await status(anon.listLocalProcesses())).toBe(401);
    expect(await status(anon.listLocalSecrets())).toBe(401);
  });

  it("processus : liste, lien signé vers l'aperçu (servi sans auth, CSP sandbox), 404 sans port", async () => {
    await dev({ process: true });
    const { processes } = await c.listLocalProcesses();
    const vite = processes.find((p) => p.port)!;
    const l = await c.getProcessLink(vite.id);
    const r = await fetch(c.resolveUrl(l.url)!);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toMatch(/^sandbox /);
    expect((await fetch(c.resolveUrl(l.url.replace(/\.[0-9a-f]{24}\//, ".000000000000000000000000/"))!)).status).toBe(404);
    expect(await status(c.getProcessLink(processes.find((p) => !p.port)!.id))).toBe(404);
  });

  it("coffre : noms seulement, jamais la valeur ; scellé → 503", async () => {
    await c.putLocalSecret("CLE_API", "valeur-secrete");
    const v = await c.listLocalSecrets();
    expect(v.secrets.map((s) => s.name)).toEqual(["CLE_API"]);
    expect(JSON.stringify(v)).not.toContain("valeur-secrete");
    expect(await status(c.putLocalSecret("pas/un/nom", "x"))).toBe(400);
    await c.deleteLocalSecret("CLE_API");
    expect(await status(c.deleteLocalSecret("CLE_API"))).toBe(404);
    await dev({ sealed: true });
    expect(await status(c.putLocalSecret("B", "x"))).toBe(503);
  });

  it("hooks : confiance pour la bonne empreinte, 409 sinon, 404 fil sans hooks", async () => {
    expect(await status(c.trustProjectHooks("th_x", "a".repeat(64)))).toBe(404);
    await dev({ hooks_thread: "th_x" });
    expect(await status(c.trustProjectHooks("th_x", "b".repeat(64)))).toBe(409);
  });
});
