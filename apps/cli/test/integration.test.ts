/**
 * Test d'intégration CLI ↔ mock-server — exerce le chemin réel (`auth.ts`/`session.ts`, le code
 * utilisé par `ui/App.tsx`) contre un vrai serveur HTTP en mémoire, pas des mocks de `fetch`.
 * Volontairement SANS rendu Ink : tester un terminal rendu est fragile et ne couvre pas mieux le
 * contrat que de tester directement la couche réseau que l'UI appelle.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NokkerClient, type Approval } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import { ensureDeviceIdentity, login } from "../src/auth.js";
import { CliSession, StrongApprovalRequiresDeviceError } from "../src/session.js";

let mock: MockServerHandle;
let configDir: string;

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), "nokker-cli-test-"));
  process.env.NOKKER_CONFIG_DIR_OVERRIDE = configDir;
  mock = await startMockServer({ port: 0 });
});

afterAll(async () => {
  await mock.close();
  delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
  await rm(configDir, { recursive: true, force: true });
});

describe("CLI ↔ mock-server", () => {
  it("enrôle un appareil, se connecte, discute, et le flux d'approbation va jusqu'à l'exécution", async () => {
    const client = new NokkerClient({ baseUrl: mock.url });

    const token = await login(client, "test-device");
    expect(token.user).toBe("alice");
    expect(client as unknown).toBeDefined();

    const { identity } = await ensureDeviceIdentity(client, "test-device");
    expect(identity.deviceId).toMatch(/^dev_/);

    const session = new CliSession(client, identity, undefined, token.user);
    const chunks: string[] = [];
    const reply = await session.sendMessage("Peux-tu envoie ce message au client ?", (chunk) => {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) chunks.push(delta);
    });

    expect(chunks.length).toBeGreaterThan(1); // vraiment streamé, pas un seul bloc
    expect(reply).toContain("approbation");

    const pending = await session.listApprovals("pending");
    expect(pending).toHaveLength(1);
    const approval = pending[0]!;
    expect(approval.strength).toBe("standard");
    expect(approval.effect).toBe("send_external");
    expect(approval.thread_id).toBe(session.threadId);

    const decided = await session.decideByDevice(approval.id, "approve");
    expect(decided.status).toBe("executed");
    expect(decided.decided_via).toBe("signature");

    const view = await client.getThread(session.threadId);
    const last = view.messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.content).toContain("[Approbation]");

    const stillPending = await session.listApprovals("pending");
    expect(stillPending).toHaveLength(0);
  });

  it("reçoit approval.requested via /v1/events pour un envoi déclenché dans un autre fil", async () => {
    const client = new NokkerClient({ baseUrl: mock.url });
    const token = await login(client, "test-device-2");
    const { identity } = await ensureDeviceIdentity(client, "test-device-2");
    const session = new CliSession(client, identity, undefined, token.user);

    const received: string[] = [];
    const sub = session.subscribeEvents({ onEvent: (e) => received.push(e.type) });
    try {
      await session.sendMessage("envoie la facture", () => {});
      await new Promise((r) => setTimeout(r, 200));
      expect(received).toContain("approval.requested");
    } finally {
      sub.close();
    }
  });

  it("refuse le TOTP pour une approbation strong AVANT même d'appeler le serveur", async () => {
    const client = new NokkerClient({ baseUrl: mock.url });
    const token = await login(client, "test-device-3");
    const { identity } = await ensureDeviceIdentity(client, "test-device-3");
    const session = new CliSession(client, identity, undefined, token.user);

    const fakeStrongApproval: Approval = {
      id: "appr_fake",
      thread_id: session.threadId,
      turn_index: 0,
      channel: "cli",
      tool_name: "wipe_everything",
      arguments: {},
      args_sha256: "0".repeat(64),
      effect: "destructive",
      rule: "effect:destructive",
      reason: "test",
      advice: null,
      strength: "strong",
      status: "pending",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 1000).toISOString(),
      decided_by: null,
      decided_via: null,
      decided_at: null,
      result_summary: null,
      error: null,
    };

    await expect(session.decideByTotp(fakeStrongApproval, "approve", "123456")).rejects.toBeInstanceOf(
      StrongApprovalRequiresDeviceError,
    );
  });

  it("TOTP correct approuve (niveau standard), TOTP incorrect est refusé par le serveur", async () => {
    const client = new NokkerClient({ baseUrl: mock.url });
    const token = await login(client, "test-device-4");
    const { identity } = await ensureDeviceIdentity(client, "test-device-4");
    const session = new CliSession(client, identity, undefined, token.user);

    await client.chatCompletion(session.threadId, [{ role: "user", content: "envoie le rapport" }]);
    const [approval] = await session.listApprovals("pending");
    expect(approval).toBeDefined();

    await expect(session.decideByTotp(approval!, "approve", "000001")).rejects.toThrow();

    const stillPending = await session.getApproval(approval!.id);
    expect(stillPending.status).toBe("pending"); // le mauvais code n'a rien décidé

    const decided = await session.decideByTotp(approval!, "approve", "000000"); // MOCK_TOTP_CODE
    expect(decided.status).toBe("executed");
    expect(decided.decided_via).toBe("totp");
  });
});
