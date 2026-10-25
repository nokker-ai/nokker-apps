import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NokkerApiError,
  NokkerClient,
  generateDeviceKeyPair,
  signChallenge,
  type Approval,
  type Bubble,
  type NokkerEvent,
} from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let client: NokkerClient;

async function login(c: NokkerClient): Promise<void> {
  const keys = await generateDeviceKeyPair();
  const dev = await c.enrollDevice({ name: "test", public_key_spki: keys.publicKeySpkiB64Url });
  const { challenge } = await c.requestSessionChallenge(dev.id);
  await c.createSession({ device_id: dev.id, challenge, signature: await signChallenge(keys.privateKey, challenge, "login") });
}

/** Collecte les événements SSE ; `waitFor` attend un prédicat (timeout court : speed 0.01). */
function collect(c: NokkerClient) {
  const events: NokkerEvent[] = [];
  const waiters: { pred: (e: NokkerEvent) => boolean; resolve: (e: NokkerEvent) => void }[] = [];
  const sub = c.subscribeEvents({
    onEvent: (e) => {
      events.push(e);
      for (const w of [...waiters]) if (w.pred(e)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(e));
    },
  });
  return {
    events,
    close: () => sub.close(),
    waitFor<T extends NokkerEvent>(pred: (e: NokkerEvent) => boolean, ms = 3000): Promise<T> {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit as T);
      return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("événement attendu non reçu")), ms);
        waiters.push({ pred, resolve: (e) => (clearTimeout(t), resolve(e as T)) });
      });
    },
  };
}

async function say(threadId: string, text: string): Promise<string> {
  const r = await client.chatCompletion(threadId, [{ role: "user", content: text }]);
  return r.choices[0]!.message.content;
}

beforeEach(async () => {
  mock = await startMockServer({ speed: 0.01 });
  client = new NokkerClient({ baseUrl: mock.url });
  await login(client);
});
afterEach(async () => {
  await mock.close();
});

describe("fils (§1)", () => {
  it("liste les fils de démo triés par updated_at desc, crée et renomme un fil", async () => {
    const threads = await client.listThreads();
    expect(threads.map((t) => t.title)).toEqual(["Général", "Infra", "Compta", "Recrutement"]);
    expect(threads[0]!.id).toMatch(/^th_[0-9a-f]{12}$/);
    const t = await client.createThread("Perso");
    expect((await client.listThreads())[0]!.id).toBe(t.id);
    expect((await client.patchThread(t.id, { title: "Perso 2" })).title).toBe("Perso 2");
    const view = await client.getThread(mock.demo!.infra);
    expect(view.thread.title).toBe("Infra");
    expect(view.messages.length).toBeGreaterThan(0);
    expect(view.bubbles.map((b) => b.kind)).toEqual(["script"]);
  });

  it("un X-Session-Id inconnu crée le fil (titre = 48 premiers caractères)", async () => {
    await say("th_00000000beef", "x".repeat(80));
    const view = await client.getThread("th_00000000beef");
    expect(view.thread.title).toBe("x".repeat(48));
  });
});

describe("transfert (§3)", () => {
  it("move : même id, change de fil, contexte injecté, événements transferred puis updated", async () => {
    const ev = collect(client);
    const { general, infra } = mock.demo!;
    const created = await client.createBubble(general, {
      kind: "monitor",
      title: "Disque host-1",
      state: { target: "host-1:/", metric: "disk_used", value: 91, unit: "%" },
    });
    const res = await client.transferBubble(created.id, infra, "move");
    expect(res.mode).toBe("move");
    expect(res.bubble.id).toBe(created.id);
    expect(res.bubble.thread_id).toBe(infra);
    expect(res.bubble.origin).toEqual({ thread_id: general, bubble_id: created.id, mode: "move" });
    expect((await client.listBubbles(general)).find((b) => b.id === created.id)).toBeUndefined();
    const infraView = await client.getThread(infra);
    expect(infraView.bubbles.some((b) => b.id === created.id)).toBe(true);
    // Contexte : dans la boîte du fil, consommé au PROCHAIN tour (§8) — le mock le cite dans sa réponse.
    expect(mock.state.threads.get(infra)!.box[0]).toMatch(/^\[Bulle reçue de « Général » — monitor « Disque host-1 »\]/);
    expect(mock.state.threads.get(general)!.box[0]).toContain("[Bulle envoyée vers « Infra »");
    expect(await say(infra, "tu as vu ?")).toContain("Bulle reçue de « Général »");
    expect(mock.state.threads.get(infra)!.box).toHaveLength(0);
    const t = await ev.waitFor((e) => e.type === "bubble.transferred");
    expect(t).toMatchObject({ bubble_id: created.id, new_bubble_id: created.id, from_thread: general, to_thread: infra, mode: "move" });
    const iT = ev.events.findIndex((e) => e.type === "bubble.transferred");
    const iU = ev.events.findIndex((e, i) => i > iT && e.type === "bubble.updated");
    expect(iU).toBeGreaterThan(iT);
    ev.close();
  });

  it("copy : nouvelle bulle, la source reste, bubble.created après transferred", async () => {
    const ev = collect(client);
    const { general, compta } = mock.demo!;
    const src = await client.createBubble(general, { kind: "timer", title: "Pause", state: { label: "Pause", started_at: "a", ends_at: "b" } });
    const res = await client.transferBubble(src.id, compta, "copy");
    expect(res.bubble.id).not.toBe(src.id);
    expect(res.bubble.thread_id).toBe(compta);
    expect(res.bubble.origin?.mode).toBe("copy");
    expect((await client.listBubbles(general)).some((b) => b.id === src.id)).toBe(true);
    await ev.waitFor((e) => e.type === "bubble.created" && e.bubble.id === res.bubble.id);
    const tr = ev.events.find((e) => e.type === "bubble.transferred");
    expect(tr).toMatchObject({ bubble_id: src.id, new_bubble_id: res.bubble.id, mode: "copy" });
    ev.close();
  });

  it("refuse un mode invalide, un fil inconnu, le même fil, une notify et la création client d'une notify", async () => {
    const { general } = mock.demo!;
    const b = await client.createBubble(general, { kind: "timer", title: "x", state: { label: "x", started_at: "a", ends_at: "b" } });
    await expect(client.transferBubble(b.id, "th_inconnu", "move")).rejects.toMatchObject({ status: 404 });
    await expect(client.transferBubble(b.id, general, "move")).rejects.toMatchObject({ status: 400 }); // même fil
    await expect(client.transferBubble(b.id, general, "teleport" as never)).rejects.toBeInstanceOf(NokkerApiError);
    await expect(
      client.createBubble(general, { kind: "notify", title: "x", state: { from_thread: general, from_title: "x", text: "x", actions: [] } }),
    ).rejects.toMatchObject({ status: 400 });
    const ev = collect(client);
    await client.sendSessionMessage(general, { from_thread: mock.demo!.compta, text: "coucou" });
    const n = await ev.waitFor<{ type: "bubble.created"; bubble: Bubble }>((e) => e.type === "bubble.created" && e.bubble.kind === "notify");
    await expect(client.transferBubble(n.bubble.id, mock.demo!.infra, "copy")).rejects.toMatchObject({ status: 400 });
    await expect(client.shareBubble(n.bubble.id, { members: ["bob"] })).rejects.toMatchObject({ status: 400 });
    ev.close();
  });

  it("dans le chat : « envoie la bulle disque à Infra » déplace la bulle", async () => {
    const { general, infra } = mock.demo!;
    const ev = collect(client);
    await say(general, "disque");
    const created = await ev.waitFor<{ type: "bubble.created"; bubble: Bubble }>((e) => e.type === "bubble.created" && e.bubble.kind === "monitor");
    const reply = await say(general, "envoie la bulle disque à Infra");
    expect(reply).toContain("déplacée vers Infra");
    expect((await client.getBubble(created.bubble.id)).thread_id).toBe(infra);
    expect(await say(infra, "tu as vu ?")).toContain("Bulle reçue");
    ev.close();
  });
});

describe("partage (§2)", () => {
  it("remplace la liste ; un fil partagé voit la bulle en lecture (shared: true) ; membre inconnu refusé", async () => {
    const { general, recrutement } = mock.demo!;
    const b = await client.createBubble(general, { kind: "timer", title: "Partagée", state: { label: "x", started_at: "a", ends_at: "b" } });
    const s1 = await client.shareBubble(b.id, { members: ["bob"], threads: [recrutement] });
    expect(s1.shared_with).toEqual({ members: ["bob"], threads: [recrutement] });
    expect(s1.version).toBe(b.version + 1);
    const seen = (await client.listBubbles(recrutement)).find((x) => x.id === b.id);
    expect(seen?.shared).toBe(true);
    const s2 = await client.shareBubble(b.id, { threads: [] });
    expect(s2.shared_with).toEqual({ members: ["bob"], threads: [] });
    expect((await client.listBubbles(recrutement)).some((x) => x.id === b.id)).toBe(false);
    await expect(client.shareBubble(b.id, { members: ["mallory"] })).rejects.toMatchObject({ status: 400 });
  });
});

describe("bulles vivantes et événements (§2, §6)", () => {
  it("PATCH avec if_version : 409 (current_version) si périmé ; close publie bubble.closed", async () => {
    const ev = collect(client);
    const { general } = mock.demo!;
    const b = await client.createBubble(general, { kind: "timer", title: "t", state: { label: "t", started_at: "a", ends_at: "b" } });
    const p = await client.patchBubble(b.id, { status: "done", if_version: b.version });
    expect(p.version).toBe(b.version + 1);
    const conflict = await client.patchBubble(b.id, { status: "idle", if_version: b.version }).catch((e: NokkerApiError) => e);
    expect(conflict).toMatchObject({ status: 409 });
    expect((conflict as NokkerApiError).currentVersion).toBe(p.version);
    await client.closeBubble(b.id);
    await ev.waitFor((e) => e.type === "bubble.closed" && e.bubble_id === b.id);
    expect((await client.listBubbles(general)).some((x) => x.id === b.id)).toBe(false);
    expect((await client.listBubbles(general, { includeClosed: true })).some((x) => x.id === b.id)).toBe(true);
    ev.close();
  });

  it("« disque » : monitor working puis done avec l'action purge, qui passe par une approbation", async () => {
    const ev = collect(client);
    const { general } = mock.demo!;
    await say(general, "disque");
    const done = await ev.waitFor<{ type: "bubble.updated"; bubble: Bubble }>(
      (e) => e.type === "bubble.updated" && e.bubble.kind === "monitor" && e.bubble.status === "done",
    );
    expect(ev.events.some((e) => e.type === "bubble.created" && e.bubble.kind === "monitor" && e.bubble.status === "working")).toBe(true);
    expect(done.bubble.actions[0]?.id).toBe("purge");
    const res = await client.bubbleAction(done.bubble.id, "purge");
    expect(res).toEqual({ accepted: true, thread_id: general }); // 202 : l'action devient un tour du fil
    await ev.waitFor((e) => e.type === "approval.requested");
    await ev.waitFor((e) => e.type === "bubble.created" && e.bubble.kind === "approval");
    const view = await client.getThread(general);
    expect(view.messages.some((m) => m.role === "user" && m.content.startsWith("[Action « Proposer une purge » demandée sur la bulle"))).toBe(true);
    await expect(client.bubbleAction(done.bubble.id, "nope")).rejects.toMatchObject({ status: 404 });
    ev.close();
  });

  it("« cherche … » : search avec 4 résultats puis aperçus remplis par bubble.updated, image re-servie", async () => {
    const ev = collect(client);
    await say(mock.demo!.general, "cherche comment libérer de l'espace docker");
    const done = await ev.waitFor<{ type: "bubble.updated"; bubble: Bubble }>(
      (e) => e.type === "bubble.updated" && e.bubble.kind === "search" && e.bubble.status === "done",
    );
    if (done.bubble.kind !== "search") throw new Error("kind");
    expect(done.bubble.state.results).toHaveLength(4);
    expect(done.bubble.state.results.every((r) => r.preview?.image?.startsWith("/v1/previews/img/"))).toBe(true);
    const img = await fetch(client.resolveUrl(done.bubble.state.results[0]!.preview!.image)!);
    expect(img.headers.get("content-type")).toBe("image/svg+xml");
    const p = await client.getPreview("https://example.org/x");
    expect(p.site_name).toBe("example.org");
    ev.close();
  });

  it("« crée un agent … » : agent_draft se remplit, activate → bubble.closed + agent.created", async () => {
    const ev = collect(client);
    const before = (await client.listAgents()).length;
    await say(mock.demo!.general, "crée un agent qui relance les factures impayées");
    const ready = await ev.waitFor<{ type: "bubble.updated"; bubble: Bubble }>(
      (e) => e.type === "bubble.updated" && e.bubble.kind === "agent_draft" && e.bubble.kind === "agent_draft" && e.bubble.state.fill === 1,
    );
    await expect(client.bubbleAction(ready.bubble.id, "autre")).rejects.toMatchObject({ status: 404 }); // seule activate
    const res = await client.bubbleAction(ready.bubble.id, "activate");
    if (!("activated" in res)) throw new Error("activate doit répondre {activated, agent} (§9.4)");
    expect(res.agent).toMatchObject({ name: "Relanceur factures", status: "armed", created_by: "alice" });
    await ev.waitFor((e) => e.type === "bubble.closed" && e.bubble_id === ready.bubble.id);
    const created = await ev.waitFor<{ type: "agent.created"; agent: { name: string } }>((e) => e.type === "agent.created");
    expect(created.agent.name).toBe("Relanceur factures");
    expect((await client.listAgents()).length).toBe(before + 1);
    ev.close();
  });
});

describe("§9 — notifications, utilisateurs, Crew, images signées", () => {
  it("GET /v1/notifications rend les notify ouvertes adressées à l'appelant", async () => {
    const ev = collect(client);
    await client.sendSessionMessage(mock.demo!.compta, { from_thread: mock.demo!.general, text: "facture ?" });
    const n = await ev.waitFor<{ type: "bubble.created"; bubble: Bubble }>((e) => e.type === "bubble.created" && e.bubble.kind === "notify");
    const list = await client.listNotifications();
    expect(list.map((b) => b.id)).toContain(n.bubble.id);
    expect(list.every((b) => b.thread_id === null && b.kind === "notify" && !b.closed_at)).toBe(true);
    await client.bubbleAction(n.bubble.id, "goto");
    expect((await client.listNotifications()).map((b) => b.id)).not.toContain(n.bubble.id);
    ev.close();
  });

  it("GET /v1/users et POST /v1/agents (armed, 400 sans name/role)", async () => {
    expect(await client.listUsers()).toEqual([
      { id: "alice", name: "Alice", initials: "AL" },
      { id: "bob", name: "Bob", initials: "BO" },
    ]);
    const a = await client.createAgent({ name: "Veille", role: "Surveille" });
    expect(a).toMatchObject({ status: "armed", created_by: "alice", tools: [] });
    expect(a.id).toMatch(/^ag_/);
    await expect(client.createAgent({ name: "", role: "x" })).rejects.toMatchObject({ status: 400 });
  });

  it("image d'aperçu : URL signée servie sans jeton, signature fausse refusée", async () => {
    const p = await client.getPreview("https://example.org/x");
    expect(p.image).toMatch(/^\/v1\/previews\/img\/[0-9a-f]{64}\?exp=\d+&sig=[0-9a-f]{32}$/);
    const ok = await fetch(client.resolveUrl(p.image)!);
    expect(ok.status).toBe(200);
    const bad = await fetch(client.resolveUrl(p.image!.replace(/sig=[0-9a-f]{4}/, "sig=0000"))!);
    expect(bad.status).toBe(401);
  });
});

describe("sessions qui se parlent (§4)", () => {
  it("POST /messages sans ask : boîte de contexte, session.message, notify sans fil pour les membres du fil qui reçoit", async () => {
    const ev = collect(client);
    const { general, compta } = mock.demo!;
    const r = await client.sendSessionMessage(compta, { from_thread: general, text: "Le loyer est payé ?" });
    expect(r).toEqual({ delivered: true, ask: false });
    await ev.waitFor((e) => e.type === "session.message" && e.to_thread === compta);
    const n = await ev.waitFor<{ type: "bubble.created"; bubble: Bubble }>((e) => e.type === "bubble.created" && e.bubble.kind === "notify");
    expect(n.bubble.thread_id).toBeNull();
    expect(n.bubble.shared_with.members.sort()).toEqual(["alice", "bob"]); // membres de Compta
    if (n.bubble.kind !== "notify") throw new Error("kind");
    expect(n.bubble.state).toMatchObject({ from_thread: general, to_thread: compta, actions: [] });
    expect(mock.state.threads.get(compta)!.box).toEqual(["[Message de la session « Général »] Le loyer est payé ?"]);
    const goto = await client.bubbleAction(n.bubble.id, "goto");
    expect(goto).toEqual({ closed: true, goto: general });
    await ev.waitFor((e) => e.type === "bubble.closed" && e.bubble_id === n.bubble.id);
    await expect(client.sendSessionMessage(compta, { from_thread: compta, text: "moi" })).rejects.toMatchObject({ status: 400 });
    ev.close();
  });

  it("POST /messages avec ask : 202, tour de fond dans le destinataire, réponse renvoyée au fil source", async () => {
    const ev = collect(client);
    const { general, compta } = mock.demo!;
    const r = await client.sendSessionMessage(compta, { from_thread: general, text: "Le loyer est payé ?", ask: true });
    expect(r).toEqual({ delivered: true, ask: true });
    expect(mock.state.threads.get(compta)!.box).toHaveLength(0); // le bloc EST l'entrée du tour
    await ev.waitFor((e) => e.type === "turn.done" && e.thread_id === compta);
    await ev.waitFor((e) => e.type === "session.message" && e.from_thread === compta && e.to_thread === general);
    expect(ev.events.some((e) => e.type === "thread.updated" && e.thread.id === compta && e.thread.working)).toBe(true);
    const delta = ev.events.filter((e) => e.type === "turn.delta" && e.thread_id === compta);
    expect(delta).toHaveLength(1); // delta UNIQUE par tour
    expect(mock.state.threads.get(general)!.box[0]).toMatch(/^\[Réponse de la session « Compta »\]/);
    const view = await client.getThread(compta);
    expect(view.messages.at(-2)).toMatchObject({ role: "user", channel: "session" });
    expect(view.messages.at(-2)!.content).toContain("[Message de la session « Général »] Le loyer");
    ev.close();
  });

  it("PATCH members (propriétaire, utilisateurs connus) ; messages par tours (before/limit)", async () => {
    const { recrutement, general } = mock.demo!;
    const t = await client.patchThread(recrutement, { members: ["bob"] });
    expect(t.members.sort()).toEqual(["alice", "bob"]);
    await expect(client.patchThread(recrutement, { members: ["mallory"] })).rejects.toMatchObject({ status: 400 });
    await say(general, "un");
    await say(general, "deux");
    const last = await client.getThread(general, { limit: 1 });
    expect(last.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(last.messages[0]!.content).toBe("deux");
    const before = await client.getThread(general, { before: last.messages[0]!.index, limit: 1 });
    expect(before.messages[0]!.content).toBe("un");
    expect(last.thread.unread).toBe(0);
  });

  it("démo : Compta notifie après la première connexion SSE ; l'action ferme la notify", async () => {
    const ev = collect(client);
    const n = await ev.waitFor<{ type: "bubble.created"; bubble: Bubble }>(
      (e) => e.type === "bubble.created" && e.bubble.kind === "notify" && e.bubble.title === "Compta",
    );
    const res = await client.bubbleAction(n.bubble.id, "prepare");
    expect(res).toEqual({ closed: true, goto: null });
    await ev.waitFor((e) => e.type === "bubble.closed" && e.bubble_id === n.bubble.id);
    await ev.waitFor((e) => e.type === "turn.done" && e.thread_id === mock.demo!.compta && ev.events.filter((x) => x.type === "turn.done").length >= 2);
    ev.close();
  });
});

describe("approbations (APPROVALS.md §5)", () => {
  it("forme snake_case, décision par TOTP (challenge obligatoire), événement approval.decided", async () => {
    const ev = collect(client);
    const { general } = mock.demo!;
    await say(general, "envoie la facture");
    const requested = await ev.waitFor<{ type: "approval.requested"; approval: Approval }>(
      (e) => e.type === "approval.requested",
    );
    const a = requested.approval;
    // Forme CANONIQUE snake_case du noyau (APPROVALS.md §5) — pas les anciens noms camelCase.
    expect(a).toMatchObject({
      thread_id: general,
      tool_name: "send_email_bulk",
      effect: "send_external",
      rule: "effect:send_external",
      strength: "standard",
      status: "pending",
      decided_by: null,
      decided_via: null,
      decided_at: null,
    });
    expect(typeof a.turn_index).toBe("number");
    expect(a.args_sha256).toMatch(/^[0-9a-f]{64}$/);

    const fromGet = await client.getApproval(a.id);
    expect(fromGet.tool_name).toBe("send_email_bulk");

    // Le défi reste obligatoire même pour une décision TOTP (anti-rejeu, APPROVALS.md §2/§3.5).
    const { challenge } = await client.requestChallenge(a.id);
    const decided = await client.decideApproval(a.id, { decision: "approve", challenge, totp: "000000", totp_user: "alice" });
    expect(decided.status).toBe("executed");
    expect(decided.decided_via).toBe("totp");
    expect(decided.decided_by).toBe("alice");
    expect(decided.decided_at).not.toBeNull();

    const d = await ev.waitFor<{ type: "approval.decided"; approval_id: string; decision: string; by: string; via: string }>(
      (e) => e.type === "approval.decided",
    );
    expect(d).toMatchObject({ approval_id: a.id, decision: "approved", by: "alice", via: "totp" });
    ev.close();
  });

  it("refuse une décision TOTP sans défi, sans totp_user, ou dont l'args_sha256 a changé", async () => {
    const { general } = mock.demo!;
    await say(general, "envoie le rapport");
    const [a] = await client.listApprovals("pending");
    expect(a).toBeDefined();

    await expect(client.decideApproval(a!.id, { decision: "approve", totp: "000000" } as never)).rejects.toMatchObject({ status: 401 });

    const { challenge } = await client.requestChallenge(a!.id);
    await expect(
      client.decideApproval(a!.id, { decision: "approve", challenge, totp: "000000", totp_user: "" } as never),
    ).rejects.toMatchObject({ status: 400 });

    // Falsification des arguments APRÈS le défi : args_sha256 ne correspond plus (APPROVALS.md §2).
    const { challenge: challenge2 } = await client.requestChallenge(a!.id);
    mock.state.approvals.get(a!.id)!.arguments = { ...a!.arguments, tampered: true };
    await expect(
      client.decideApproval(a!.id, { decision: "approve", challenge: challenge2, totp: "000000", totp_user: "alice" }),
    ).rejects.toMatchObject({ status: 409 });

    const stillPending = await client.getApproval(a!.id);
    expect(stillPending.status).toBe("pending");
  });
});

describe("relais web → Lokkal (X21, LOKKAL §7.16)", () => {
  it("proposé → accepté → terminé avec la réponse ; une seconde décision : 409", async () => {
    const thread = (await client.createThread("Relais")).id;
    await client.chatCompletion(thread, [{ role: "user", content: "passe le relais a atelier pour le depot site : corrige le test" }]);
    await new Promise((r) => setTimeout(r, 100));
    const b = (await client.listBubbles(thread)).find((x) => x.kind === "handoff")!;
    expect(b.state).toMatchObject({ state: "proposed", online: true, need: { kind: "repo", name: "site" }, machine_name: "Atelier" });
    const r = (await client.bubbleAction(b.id, "accept")) as unknown as { handoff: { state: string } };
    expect(r.handoff.state).toBe("accepted");
    await expect(client.bubbleAction(b.id, "accept")).rejects.toMatchObject({ status: 409 });
    await new Promise((res) => setTimeout(res, 200));
    const done = await client.getBubble(b.id);
    expect(done.status).toBe("done");
    expect((done.state as { reply: string }).reply).toMatch(/^\(démo\)/);
  });

  it("machine éteinte : accepté → waiting, « Annuler » = refuse", async () => {
    const thread = (await client.createThread("Relais 2")).id;
    await client.chatCompletion(thread, [{ role: "user", content: "passe le relais au portable pour le depot api" }]);
    await new Promise((r) => setTimeout(r, 100));
    const b = (await client.listBubbles(thread)).find((x) => x.kind === "handoff")!;
    expect((b.state as { online: boolean }).online).toBe(false);
    await client.bubbleAction(b.id, "accept");
    expect(((await client.getBubble(b.id)).state as { state: string }).state).toBe("waiting");
    await client.bubbleAction(b.id, "refuse");
    expect(((await client.getBubble(b.id)).state as { state: string }).state).toBe("refused");
  });
});
