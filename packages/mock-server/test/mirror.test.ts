import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient, teamMemoryProjects } from "@nokker-apps/sdk";
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
const dev = (body: unknown) => fetch(`${mock.url}/v1/dev/local-mirror-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const fail = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    if (!(e instanceof NokkerApiError)) return { status: -1 };
    return { status: e.status, code: (e.body as { error?: { code?: string } } | undefined)?.error?.code };
  }
};

describe("miroir de la machine (§7.23)", () => {
  it("jeton local seulement", async () => {
    expect((await fail(new NokkerClient({ baseUrl: mock.url }).getLocalMirror())).status).toBe(401);
  });

  it("état : voyants par canal, retard, attente, place des pages, projets d'équipe", async () => {
    const st = await c.getLocalMirror();
    expect(st.enabled).toBe(true);
    expect(st.channels?.turns_push).toMatchObject({ failures: 0, last_error: null, retry_in_s: 0 });
    expect(st.channels?.pages).toMatchObject({ failures: 2, last_error: { kind: "ConnectTimeout" } });
    expect(st.channels?.pages?.retry_in_s).toBeGreaterThan(0);
    expect(st.behind_s).toBeGreaterThan(0);
    expect(st.pending).toMatchObject({ turns: 3, pages: 1 });
    expect(st.pages_space).toMatchObject({ quota: 50 * 1024 * 1024 });
    expect([...teamMemoryProjects(st)]).toEqual([["p-0a1b2c3d4e5f6a7b", "Marketing site"]]);
    expect(JSON.stringify(st)).not.toMatch(/https?:\/\/|token/i); // ni URL ni jeton dans l'état
  });

  it("resynchroniser : 202 ; en pause : 409, puis reprendre", async () => {
    expect((await c.resyncLocalMirror()).resync?.requested).toBe(true);
    await dev({ paused: true });
    expect((await fail(c.resyncLocalMirror())).status).toBe(409);
    expect((await c.resumeLocalMirror()).paused).toBe(false);
  });

  it("pages : garder en ligne, plafond, page local refusée", async () => {
    const { pages, space } = await c.listLocalMirrorPages();
    expect(space).toMatchObject({ quota: 50 * 1024 * 1024 });
    expect(pages.map((p) => p.state)).toEqual(["pending", "quota", "off", "off"]);
    expect(pages[1]!.error).toMatch(/plafond/);
    const notes = pages[2]!;
    expect(await c.setLocalMirrorPage(notes.page_id, true)).toEqual({ page_id: notes.page_id, mirror: true });
    expect((await c.listLocalMirrorPages()).space!.used).toBe(space!.used + notes.size);
    expect(await fail(c.setLocalMirrorPage(pages[3]!.page_id, true))).toEqual({ status: 409, code: "local_page" });
    expect((await fail(c.setLocalMirrorPage("pg_0000000000000000", true))).status).toBe(404);
  });

  it("projets mémoire : choix par projet", async () => {
    const { projects } = await c.listLocalMirrorProjects();
    expect(projects.map((p) => p.mirror)).toEqual([true, false]);
    expect(await c.setLocalMirrorProject(projects[1]!.project, true)).toEqual({ project: projects[1]!.project, mirror: true });
    expect((await fail(c.setLocalMirrorProject("p-inconnu", true))).status).toBe(404);
  });

  it("miroir éteint : {enabled: false}, le reste 404 ; les projets restent réglables", async () => {
    await dev({ enabled: false });
    expect(await c.getLocalMirror()).toEqual({ enabled: false });
    expect((await fail(c.listLocalMirrorPages())).status).toBe(404);
    expect((await c.listLocalMirrorProjects()).projects.length).toBe(2);
  });
});

describe("historique des versions remplacées (§7.15)", () => {
  it("mainteneur seulement", async () => {
    const s = new NokkerClient({ baseUrl: mock.url });
    await s.demoSessionMockExtension();
    const { projects } = await s.listProjects();
    const site = projects.find((p) => p.name === "Marketing site")!;
    expect((await s.listProjectQuarantine(site.id)).quarantine[0]).toMatchObject({ name: "rule-pricing-final-1a2b", reason: expect.stringMatching(/remplacée/) });
    const viewer = projects.find((p) => p.name === "Research")!;
    expect(await fail(s.listProjectQuarantine(viewer.id))).toEqual({ status: 403, code: "forbidden" });
  });
});
