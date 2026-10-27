import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let client: NokkerClient;
beforeEach(async () => {
  mock = await startMockServer({ speed: 0.01 });
  client = new NokkerClient({ baseUrl: mock.url });
  await client.demoSessionMockExtension();
});
afterEach(async () => {
  await mock.close();
});

describe("images dans la demande (X7)", () => {
  it("parties texte + image : le texte fait le tour, les images sont comptées", async () => {
    const thread = (await client.createThread("Images")).id;
    const r = await client.chatCompletion(thread, [
      {
        role: "user",
        content: [
          { type: "text", text: "que vois-tu ?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        ],
      },
    ]);
    expect(r.choices[0]!.message.content).toMatch(/^\(demo\) Image received/);
    const view = await client.getThread(thread);
    expect(view.messages.some((m) => m.role === "user" && m.content === "que vois-tu ?")).toBe(true);
  });

  it("historique : images {sha256…} sur le message user, octets lisibles par un membre, 404 ailleurs", async () => {
    const thread = (await client.createThread("Images 2")).id;
    const png = "iVBORw0KGgo=";
    await client.chatCompletion(thread, [{ role: "user", content: [{ type: "text", text: "et ça ?" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] }]);
    const view = await client.getThread(thread);
    const user = view.messages.find((m) => m.role === "user" && m.images?.length)!;
    expect(user.images![0]).toMatchObject({ media_type: "image/png", size: Buffer.from(png, "base64").length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const blob = await client.getThreadImage(thread, user.images![0]!.sha256);
    expect(Buffer.from(await blob.arrayBuffer()).equals(Buffer.from(png, "base64"))).toBe(true);
    const other = (await client.createThread("Autre")).id;
    await expect(client.getThreadImage(other, user.images![0]!.sha256)).rejects.toMatchObject({ status: 404 });
  });
});
