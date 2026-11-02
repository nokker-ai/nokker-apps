/** Faux modèle du scénario `/goal` de la CLI : vérification → CONTINUE `goalChecksBeforeDone` fois, puis DONE. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NokkerClient, applyChatChunk } from "@nokker-apps/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let client: NokkerClient;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-mock-goal-"));
  mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: dir, localRoots: ["/work"], goalChecksBeforeDone: 2 });
  client = new NokkerClient({ baseUrl: mock.url, token: mock.localToken! });
});
afterAll(async () => {
  await mock.close();
  await rm(dir, { recursive: true, force: true });
});

async function say(th: string, text: string): Promise<string> {
  let out = "";
  await client.streamChatCompletion(th, [{ role: "user", content: text }], (c) => {
    out = applyChatChunk(out, c);
  });
  return out;
}

describe("scénario /goal", () => {
  it("CONTINUE deux fois puis DONE, par fil ; la relance répond une phrase", async () => {
    const th = (await client.createLocalSession({ cwd: "/work/goal" })).thread_id;
    const check = "Goal check.\n...exactly GOAL: DONE if ..., or GOAL: CONTINUE if work remains.";
    expect(await say(th, check)).toMatch(/GOAL: CONTINUE$/);
    expect(await say(th, "Continue toward the session goal:\nx")).toBe("I did one more step toward the goal.");
    expect(await say(th, check)).toMatch(/GOAL: CONTINUE$/);
    expect(await say(th, check)).toMatch(/GOAL: DONE$/);
  });
});
