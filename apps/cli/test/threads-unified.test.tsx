/** `/threads` : fils du compte et sessions de code de la machine réunis (threadlist.ts), comme la web et l'app. */
import React from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalSessionSummary, Thread } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import { unifiedThreads } from "../src/threadlist.js";
import { App } from "../src/ui/App.js";

const th = (id: string, title: string, updated: string, extra: Partial<Thread> = {}): Thread => ({
  id,
  title,
  owner: "alice",
  members: ["alice"],
  created_at: updated,
  updated_at: updated,
  working: false,
  unread: 0,
  bubble_count: 0,
  last_snippet: "",
  ...extra,
});

describe("unifiedThreads", () => {
  const threads = [
    th("th_web", "Courses du samedi", "2026-11-05T10:00:00Z", { bubble_count: 2 }),
    th("th_code", "calc", "2026-11-05T09:00:00Z"),
    th("th_agent", "Run veille", "2026-11-05T11:00:00Z", { origin: { kind: "agent", agent_id: "ag_1", run_id: "run_1" } }),
  ];
  const sessions: LocalSessionSummary[] = [
    { thread_id: "th_code", cwd: "/home/alice/calc", title: "calc", last_turn_at: "2026-11-05T09:00:00Z", working: true, pending_approvals: 1 },
    { thread_id: "th_new", cwd: "/home/alice/site", title: null, last_turn_at: null },
  ];
  const rows = unifiedThreads(threads, sessions, "2026-11-05T12:00:00Z");

  it("fils du compte + sessions de code, plus récent d'abord ; fil de passage d'agent écarté", () => {
    expect(rows.map((r) => r.id)).toEqual(["th_new", "th_web", "th_code"]);
  });
  it("dossier, travail et cartes de la session de code sur le fil du hub", () => {
    expect(rows.find((r) => r.id === "th_code")).toMatchObject({ folder: "/home/alice/calc", working: true, pendingApprovals: 1 });
    expect(rows.find((r) => r.id === "th_web")).toMatchObject({ folder: null, bubbles: 2 });
  });
  it("session sans tour (pas encore un fil du hub) : ajoutée, titrée par son dossier", () => {
    expect(rows.find((r) => r.id === "th_new")).toMatchObject({ title: "site", folder: "/home/alice/site", bubbles: 0 });
  });
  it("serveur sans routes locales : les fils du compte seuls", () => {
    expect(unifiedThreads(threads, [], "2026-11-05T12:00:00Z").map((r) => r.id)).toEqual(["th_web", "th_code"]);
  });
});

describe("/threads contre le faux noyau", () => {
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

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nokker-cli-threads-"));
    work = await mkdtemp(join(tmpdir(), "nokker-cli-threads-work-"));
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

  it("montre le fil web, la session de code ouverte (dossier, marquée courante) et cache le fil d'agent", async () => {
    const web = mock.state.createThread("Courses du samedi");
    mock.state.appendTurn(web.thread.id, "liste ?", "Pain, lait.");
    const agent = mock.state.createThread("Run veille");
    (agent.thread as Thread).origin = { kind: "agent", agent_id: "ag_1", run_id: "run_1" };
    const root = join(work, "calc");
    await mkdir(join(root, ".git"), { recursive: true });

    const r = render(<App baseUrl={mock.url} cwd={root} />);
    await frameHas(r, "Code session on");
    r.stdin.write("/threads");
    await wait(50);
    r.stdin.write("\r");
    await frameHas(r, "Threads:");
    await frameHas(r, "Courses du samedi");
    const frame = r.lastFrame()!;
    expect(frame).toContain(`code: ${root}`);
    expect(frame).toMatch(/› th_[0-9a-f]+ — /); // la session courante
    expect(frame).not.toContain("Run veille");
    r.unmount();
  }, 20_000);
});
