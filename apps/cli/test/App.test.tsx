/** Rendu Ink complet de l'App contre le mock : session locale, appels d'outils, carte, résumé, annulation. */
import React from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBubble, startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import { App } from "../src/ui/App.js";

let dir: string;
let mock: MockServerHandle;
const keep = process.env.NOKKER_CONFIG_DIR_OVERRIDE;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Décision d'une carte (contrat du 07.11) : choisir, puis Entrée après le silence exigé par la carte (600 ms). */
async function decide(r: { stdin: { write: (s: string) => void } }, key: string): Promise<void> {
  await wait(700);
  r.stdin.write(key);
  await wait(700);
  r.stdin.write("\r");
}
async function frameHas(r: ReturnType<typeof render>, text: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!(r.lastFrame() ?? "").includes(text)) {
    if (Date.now() - t0 > ms) throw new Error(`absent : ${text}\n${r.lastFrame()}`);
    await wait(25);
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-cli-app-"));
  process.env.NOKKER_CONFIG_DIR_OVERRIDE = dir;
  mock = await startMockServer({ port: 0, seed: false, speed: 0.05 });
});
afterAll(async () => {
  await mock.close();
  if (keep === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
  else process.env.NOKKER_CONFIG_DIR_OVERRIDE = keep;
  await rm(dir, { recursive: true, force: true });
});

describe("App (saisie pendant la connexion, en-tête)", () => {
  it("une ligne tapée AVANT la fin de la connexion est mise en attente puis envoyée exactement une fois", async () => {
    const r = render(<App baseUrl={mock.url} cwd="/work/attente" />);
    r.stdin.write("bonjour"); // aucune session encore : la connexion n'a même pas commencé
    await wait(20);
    r.stdin.write("\r");
    await frameHas(r, "will be sent as soon as the session is ready");
    await frameHas(r, "Local session on “attente”"); // la réponse du tour
    await wait(300);
    const turns = [...mock.state.threads.values()].flatMap((t) => t.turns).filter((t) => t.user === "bonjour");
    expect(turns).toHaveLength(1);
    r.unmount();
  });

  it("l'en-tête tronque un long titre de fil à 32 caractères", async () => {
    const { shortLabel } = await import("../src/ui/Header.js");
    const t = shortLabel("lance pytest -q et dis le résultat en une phrase");
    expect(t.length).toBe(32);
    expect(t.endsWith("…")).toBe(true);
    expect(shortLabel("th_abc")).toBe("th_abc");
  });
});

describe("App (session locale)", () => {
  it("en-tête du dossier, outils, carte, choix 2, résumé dans le fil, réponse", async () => {
    const r = render(<App baseUrl={mock.url} cwd="/work/mon-projet" />);
    await frameHas(r, "Code session on /work/mon-projet");
    expect(r.lastFrame()).toContain("mon-projet");
    await frameHas(r, "no model set"); // premier lancement : aucun défaut, pas de Router relié
    expect(r.lastFrame()).not.toContain("auto routing");
    expect(r.lastFrame()).toContain("Set a model");
    r.stdin.write("corrige le test add");
    await wait(50);
    r.stdin.write("\r");
    await frameHas(r, "Action to approve");
    // mode accept_edits : le patch passe sans carte, la première carte est pytest (terminal)
    expect(r.lastFrame()).toContain("✓ patch src/app.py");
    expect(r.lastFrame()).toContain("Command: pytest -q tests/test_add.py");
    expect(r.lastFrame()).toContain("3. Always this exact command");
    // commande de test : même ordre que la légende (ticket T5a) — 1/a une fois, 2/s cette session (libellé d'après `suggested_rule_kinds`)
    expect(r.lastFrame()).toMatch(/1\. Once \(a\)[\s\S]*2\. This exact command for this session \(s\)/);
    await decide(r, "2");
    await frameHas(r, "✓ Approved (for this session): terminal pytest -q tests/test_add.py");
    await frameHas(r, "Command: rm -rf build"); // destructif : carte sans « Toujours »
    expect(r.lastFrame()).not.toContain("3. Always");
    await decide(r, "1");
    await frameHas(r, "is cleaned up");
    r.unmount();
  });

  it("noyau réel (carte « en attente ») : l'appel attend sa carte, puis affiche la vraie sortie de l'outil approuvé", async () => {
    mock.state.approvalStyle = "kernel";
    try {
      const r = render(<App baseUrl={mock.url} cwd="/work/noyau" />);
      await frameHas(r, "Code session on /work/noyau");
      r.stdin.write("corrige le test add");
      await wait(50);
      r.stdin.write("\r");
      await frameHas(r, "Action to approve");
      await frameHas(r, "⏸ terminal pytest -q tests/test_add.py (waiting for approval)");
      await decide(r, "2");
      // `tool.result` de l'exécuteur (même call_id, approval_id) : la ligne se ferme, sortie dépliée.
      await frameHas(r, "✓ terminal pytest -q tests/test_add.py");
      await frameHas(r, "1 passed in 0.12s");
      await frameHas(r, "Command: rm -rf build"); // la carte forte arrive dans le tour de suite
      await wait(150);
      r.stdin.write("\u0003"); // refus : rien ne tourne après (continuation « none »)
      await frameHas(r, "✗ Rejected: terminal rm -rf build");
      await frameHas(r, "✗ terminal rm -rf build");
      r.unmount();
    } finally {
      mock.state.approvalStyle = "inline";
    }
  });

  it("noyau réel : la réponse du tour de suite (après la carte) s'affiche — le modèle « reprend » (répétition du 07.11)", async () => {
    // La décision locale répond 202 `continuation` : l'outil puis le tour de suite tournent dans la file du fil, hors de
    // toute requête de la CLI. Son texte n'arrive que par `turn.delta` : avant, la CLI l'ignorait sur son propre fil.
    mock.state.approvalStyle = "kernel";
    try {
      const r = render(<App baseUrl={mock.url} cwd="/work/reprise" />);
      await frameHas(r, "Code session on /work/reprise");
      r.stdin.write("corrige le test add");
      await wait(50);
      r.stdin.write("\r");
      await frameHas(r, "⏸ terminal pytest -q tests/test_add.py (waiting for approval)");
      await decide(r, "2");
      await frameHas(r, "Command: rm -rf build"); // 1er tour de suite : sa réponse annonce la carte suivante
      await frameHas(r, "is waiting for your approval on the card");
      await decide(r, "1");
      await frameHas(r, "Test add passes."); // 2e tour de suite : la réponse finale du modèle
      r.unmount();
    } finally {
      mock.state.approvalStyle = "inline";
    }
  });

  it("noyau n27 : un REFUS répond 202 et le tour continue — l'appel se ferme en ✗ refusé, la suite s'affiche une seule fois", async () => {
    // Avant, un refus répondait 200 `none` et rien ne suivait. Maintenant le modèle reçoit le refus (tool.result
    // « refused / declined », même call_id) et CONTINUE : sa réponse arrive par turn.delta, comme après une approbation.
    mock.state.approvalStyle = "kernel";
    try {
      const r = render(<App baseUrl={mock.url} cwd="/work/refus" />);
      await frameHas(r, "Code session on /work/refus");
      r.stdin.write("corrige le test add");
      await wait(50);
      r.stdin.write("\r");
      await frameHas(r, "⏸ terminal pytest -q tests/test_add.py (waiting for approval)");
      await decide(r, "2");
      await frameHas(r, "Command: rm -rf build"); // carte suivante (destructive)
      await wait(150);
      await decide(r, "4"); // Refuser
      await frameHas(r, "✗ Rejected: terminal rm -rf build");
      await frameHas(r, "✗ terminal rm -rf build — refused by you");
      expect(r.lastFrame()).not.toContain("local-owner"); // l'aperçu du noyau (identifiant interne) n'est jamais montré
      await frameHas(r, "One action was refused."); // la suite du tour après le refus
      await wait(300);
      const f = r.lastFrame() ?? "";
      expect(f.split("One action was refused.").length - 1).toBe(1); // une seule fois
      expect(f.split("✗ Rejected: terminal rm -rf build").length - 1).toBe(1);
      expect(f).not.toContain("⏸ terminal rm -rf build"); // plus bloquée sur « attend »
      r.unmount();
    } finally {
      mock.state.approvalStyle = "inline";
    }
  });

  it("surface : les tours de la CLI portent X-Nokker-Surface: cli", async () => {
    mock.state.chatSurfaces.length = 0;
    const r = render(<App baseUrl={mock.url} cwd="/work/surface" />);
    await frameHas(r, "Code session on /work/surface");
    r.stdin.write("bonjour");
    await wait(50);
    r.stdin.write("\r");
    const t0 = Date.now();
    while (mock.state.chatSurfaces.length === 0 && Date.now() - t0 < 10_000) await wait(25);
    expect(mock.state.chatSurfaces.length).toBeGreaterThan(0);
    expect(new Set(mock.state.chatSurfaces)).toEqual(new Set(["cli"]));
    expect(new Set(mock.state.chatLanguages)).toEqual(new Set(["en"])); // langue de la CLI (suite en anglais), jamais le repli du noyau
    r.unmount();
  });

  it("course : le tour de suite d'une carte démarre PENDANT notre requête — son texte s'affiche, une seule fois, sans doubler le nôtre", async () => {
    // La décision part avant la fin de la réponse HTTP du tour qui a posé la carte : la suite démarre alors que `sending`
    // est encore vrai. Le garde `remoteTurn && !sending` jetait ses `turn.delta` ; on distingue par turn_id.
    mock.state.chatTailMs = 2500;
    try {
      const cwd = "/work/course";
      const r = render(<App baseUrl={mock.url} cwd={cwd} />);
      await frameHas(r, "Code session on /work/course");
      r.stdin.write("bonjour");
      await wait(50);
      r.stdin.write("\r");
      await wait(900); // le tour est lancé et son flux reste ouvert (chatTailMs) : la requête est en cours
      const thread = [...mock.state.localSessions.entries()].find(([, v]) => v.cwd === cwd)![0];
      mock.state.publish({ type: "turn.started", thread_id: thread, turn_id: `${thread}:suite` });
      mock.state.publish({ type: "turn.delta", thread_id: thread, turn_id: `${thread}:suite`, text: "Texte du tour de suite." });
      await frameHas(r, "Texte du tour de suite.");
      await wait(3200); // la requête du premier tour se ferme ; rien ne se redit
      const frame = r.lastFrame() ?? "";
      expect(frame.split("Texte du tour de suite.").length - 1).toBe(1);
      r.unmount();
    } finally {
      mock.state.chatTailMs = 0;
    }
  }, 20_000);

  it("turn.delta cumulatif : deux deltas du même turn_id donnent UNE ligne, remplacée par le texte entier", async () => {
    const cwd = "/work/cumul";
    const r = render(<App baseUrl={mock.url} cwd={cwd} />);
    await frameHas(r, "Code session on /work/cumul");
    const thread = [...mock.state.localSessions.entries()].find(([, v]) => v.cwd === cwd)![0];
    mock.state.publish({ type: "turn.started", thread_id: thread, turn_id: `${thread}:cumul` });
    mock.state.publish({ type: "turn.delta", thread_id: thread, turn_id: `${thread}:cumul`, text: "Début de réponse." });
    await frameHas(r, "Début de réponse.");
    mock.state.publish({ type: "turn.delta", thread_id: thread, turn_id: `${thread}:cumul`, text: "Début de réponse. Et la fin." });
    await frameHas(r, "Et la fin.");
    await wait(300);
    const frame = r.lastFrame() ?? "";
    expect(frame.split("Début de réponse.").length - 1).toBe(1);
    expect(frame.split("Et la fin.").length - 1).toBe(1);
    r.unmount();
  }, 20_000);

  it("carte tranchée : le texte « en attente de ton approbation » disparaît, la ligne d'historique reste", async () => {
    mock.state.approvalStyle = "kernel";
    try {
      const r = render(<App baseUrl={mock.url} cwd="/work/attente" />);
      await frameHas(r, "Code session on /work/attente");
      r.stdin.write("corrige le test add");
      await wait(50);
      r.stdin.write("\r");
      await frameHas(r, "Action to approve");
      await frameHas(r, "The command pytest -q tests/test_add.py is waiting for your approval on the card");
      await decide(r, "2");
      await frameHas(r, "✓ Approved (for this session): terminal pytest -q tests/test_add.py");
      await wait(300);
      expect(r.lastFrame()).not.toContain("The command pytest -q tests/test_add.py is waiting for your approval on the card");
      r.unmount();
    } finally {
      mock.state.approvalStyle = "inline";
    }
  }, 30_000);

  it("la ligne de jetons ferme le tour : la réponse qui arrive après elle se range avant", async () => {
    const cwd = "/work/jetons";
    const r = render(<App baseUrl={mock.url} cwd={cwd} />);
    await frameHas(r, "Code session on /work/jetons");
    const thread = [...mock.state.localSessions.entries()].find(([, v]) => v.cwd === cwd)![0];
    const turn = `${thread}:jetons`;
    mock.state.publish({ type: "turn.started", thread_id: thread, turn_id: turn });
    mock.state.publish({ type: "turn.cost", thread_id: thread, turn_id: turn, total_tokens: 10900, cost: null } as never);
    await frameHas(r, "10");
    mock.state.publish({ type: "turn.delta", thread_id: thread, turn_id: turn, text: "Accusé de fin de tour." });
    await frameHas(r, "Accusé de fin de tour.");
    const lines = (r.lastFrame() ?? "").split("\n");
    const text = lines.findIndex((l) => l.includes("Accusé de fin de tour."));
    const cost = lines.findIndex((l) => /jetons|tokens/.test(l) && l.includes("10"));
    expect(cost).toBeGreaterThan(text);
    r.unmount();
  }, 20_000);

  it("fil ordinaire (hors session de code) : la ligne de jetons vient APRÈS la réponse, même si turn.cost arrive avant le texte", async () => {
    mock.state.costBeforeText = true;
    const r = render(<App baseUrl={mock.url} />);
    await frameHas(r, ">");
    await wait(300);
    r.stdin.write("bonjour fil");
    await wait(50);
    r.stdin.write("\r");
    await frameHas(r, "tokens ·");
    await wait(1500);
    mock.state.costBeforeText = false;
    const lines = (r.lastFrame() ?? "").split("\n");
    const cost = lines.findIndex((l) => /tokens ·/.test(l));
    const reply = lines.findIndex((l) => l.includes("Simulated reply"));
    expect(reply).toBeGreaterThanOrEqual(0);
    expect(cost).toBeGreaterThan(reply);
    r.unmount();
  }, 20_000);

  it("fil ordinaire (/thread, sans dossier) : la carte offre une fois / toujours / refuser, pas seulement appareil et TOTP", async () => {
    mock.state.localAllThreads = true;
    try {
      const r = render(<App baseUrl={mock.url} />);
      await frameHas(r, ">");
      await wait(300);
      r.stdin.write("bonjour carte");
      await wait(50);
      r.stdin.write("\r");
      await frameHas(r, "Simulated reply");
      const thread = [...mock.state.threads.keys()].pop()!;
      const now = new Date().toISOString();
      const approval = { id: "appr_plain", thread_id: thread, turn_index: 0, channel: "cli", tool_name: "execute_code", arguments: { code: "print(1)" }, args_sha256: "", effect: "exec", rule: "", reason: "Run code.", advice: null, strength: "standard", status: "pending", created_at: now, expires_at: new Date(Date.now() + 120_000).toISOString(), decided_by: null, decided_via: null, decided_at: null, result_summary: null, error: null, suggested_rules: ["execute_code"] };
      mock.state.approvals.set("appr_plain", approval as never);
      mock.state.publish({ type: "approval.requested", approval } as never);
      await frameHas(r, "Action to approve");
      const f = r.lastFrame() ?? "";
      expect(f).toContain("1. Once (a)");
      expect(f).toContain("Reject");
      expect(f).not.toContain("[p]");
      expect(f).not.toContain("TOTP");
      await decide(r, "1");
      await frameHas(r, "✓ Approved: execute_code");
      r.unmount();
    } finally {
      mock.state.localAllThreads = false;
      mock.state.approvals.delete("appr_plain");
    }
  }, 30_000);

  it("une carte tranchée ne suit pas le bas de l'écran ; /bubbles la montre encore", async () => {
    const cwd = "/work/collee";
    const clients = mock.state.sseClients.size;
    const r = render(<App baseUrl={mock.url} cwd={cwd} />);
    await frameHas(r, "Code session on /work/collee");
    // Le flux d'événements doit être branché AVANT de créer les bulles (sinon bubble.created se perd, course sous charge).
    for (let i = 0; i < 200 && mock.state.sseClients.size <= clients; i++) await wait(25);
    const thread = [...mock.state.localSessions.entries()].find(([, v]) => v.cwd === cwd)![0];
    createBubble(mock.state, thread, { kind: "approval", title: "terminal_tranchee", status: "done", state: { approval_id: "appr_x" } } as never);
    createBubble(mock.state, thread, { kind: "approval", title: "terminal_ouverte", status: "working", state: { approval_id: "appr_y" } } as never);
    await frameHas(r, "terminal_ouverte");
    expect(r.lastFrame()).not.toContain("terminal_tranchee");
    r.stdin.write("/bubbles");
    await wait(50);
    r.stdin.write("\r");
    await frameHas(r, "Bubbles of this thread:");
    await frameHas(r, "terminal_tranchee");
    r.unmount();
  }, 20_000);

  it("bulle d'approbation reprise « working » alors que la carte est décidée : plus de spinner, recalée sur l'état réel", async () => {
    const cwd = "/work/stale";
    const r = render(<App baseUrl={mock.url} cwd={cwd} />);
    await frameHas(r, "Code session on /work/stale");
    const thread = [...mock.state.localSessions.entries()].find(([, v]) => v.cwd === cwd)![0];
    // Un ancien fil : carte déjà décidée (aucune en attente), mais sa bulle est restée « working ».
    mock.state.approvals.set("appr_stale", { id: "appr_stale", thread_id: thread, tool_name: "sites_connect", status: "executed" } as never);
    createBubble(mock.state, thread, { kind: "approval", title: "sites_connect", status: "working", state: { approval_id: "appr_stale" } } as never);
    createBubble(mock.state, thread, { kind: "approval", title: "carte_en_attente", status: "working", state: { approval_id: "appr_open" } } as never);
    mock.state.approvals.set("appr_open", { id: "appr_open", thread_id: "th_autre_fil", turn_index: 0, channel: "cli", tool_name: "terminal", arguments: { command: "ls" }, args_sha256: "", effect: "read", rule: "", reason: "", advice: null, strength: "standard", status: "pending", created_at: "", expires_at: new Date(Date.now() + 60_000).toISOString(), decided_by: null, decided_via: null, decided_at: null, result_summary: null, error: null } as never);
    r.stdin.write("/bubbles");
    await wait(50);
    r.stdin.write("\r");
    await frameHas(r, "Bubbles of this thread:");
    await wait(300);
    const lines = (r.lastFrame() ?? "").split("\n");
    const spinner = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
    const stale = lines.find((l) => l.includes("sites_connect"))!;
    const open = lines.find((l) => l.includes("carte_en_attente"))!;
    expect(stale).toBeTruthy();
    expect(stale).toContain("✓"); // décidée : terminée
    expect(spinner.test(stale)).toBe(false);
    expect(spinner.test(open)).toBe(true); // vraiment en attente : le spinner reste
    r.unmount();
  }, 20_000);

  it("Échap pendant une carte ne décide pas ; /cancel annule le tour", async () => {
    const r = render(<App baseUrl={mock.url} cwd="/work/annule-moi" />);
    await frameHas(r, "Code session on /work/annule-moi");
    r.stdin.write("corrige le test add");
    await wait(50);
    r.stdin.write("\r");
    await frameHas(r, "Action to approve");
    await wait(150);
    r.stdin.write("\u001B");
    await wait(300);
    expect(r.lastFrame()).toContain("Action to approve");
    r.stdin.write("\u0003"); // Ctrl+C : refus (+ annulation du tour s'il tourne encore)
    await frameHas(r, "✗ Rejected: terminal pytest -q tests/test_add.py");
    r.unmount();
  });
});

describe("App (commandes d'outils du noyau)", () => {
  async function open(cwd: string | null) {
    const r = render(<App baseUrl={mock.url} cwd={cwd ?? "/work/cmd"} />);
    await frameHas(r, "Code session on");
    return r;
  }
  async function type(r: ReturnType<typeof render>, text: string): Promise<void> {
    r.stdin.write(text);
    await wait(50);
    r.stdin.write("\r");
  }

  it("/checkpoints, /diff (coloré), /plan, /skills, /agents", async () => {
    const r = await open("/work/cmds1");
    await type(r, "/checkpoints");
    await frameHas(r, "Checkpoints");
    expect(r.lastFrame()).toContain("before patch src/app.py");
    await type(r, "/diff");
    await frameHas(r, "+    return a + b");
    await type(r, "/diff 2");
    await frameHas(r, "since checkpoint");
    await type(r, "/plan");
    await frameHas(r, "[~] Fix add() in src/app.py");
    expect(r.lastFrame()).toContain("[x] Read the failing test");
    await type(r, "/skills");
    await frameHas(r, "git-bisect");
    expect(r.lastFrame()).toContain("pytest-debug");
    await type(r, "/skills git-bisect");
    await frameHas(r, "Always finish with");
    await type(r, "/agents");
    await frameHas(r, "No sub-agents");
    await type(r, "lance un sous-agent");
    await frameHas(r, "done — 1 commit(s)", 8000);
    await type(r, "/agents");
    await frameHas(r, "Sub-agents:");
    expect(r.lastFrame()).toContain("last tool: patch");
    expect(r.lastFrame()).toContain("read the tests and propose a fix");
    r.unmount();
  });

  it("ligne de coût sous chaque tour, puis /cost (session et jour)", async () => {
    const r = await open("/work/cout");
    await type(r, "bonjour");
    await frameHas(r, "tokens · ");
    expect(r.lastFrame()).toMatch(/· [\d.]+k tokens · (?:< )?€0\.0\d/);
    expect(r.lastFrame()).not.toMatch(/\d+ tokens \(/); // le pied de tour ne répète pas les jetons
    await type(r, "/cost");
    await frameHas(r, "Cost");
    await frameHas(r, "session: 1 turn(s)");
    expect(r.lastFrame()).toMatch(/day \(\d{4}-\d{2}-\d{2}, UTC\): \d+ turn\(s\)/);
    r.unmount();
  });

  it("/rollback : carte, approbation, résumé des fichiers restaurés", async () => {
    const r = await open("/work/cmds2");
    await type(r, "/rollback 2");
    await frameHas(r, "Action to approve");
    expect(r.lastFrame()).toContain("checkpoint_restore");
    expect(r.lastFrame()).not.toContain("3. Always");
    await decide(r, "1");
    await frameHas(r, "Rolled back to");
    await frameHas(r, "restored  src/app.py");
    expect(r.lastFrame()).toContain("kept  notes.md");
    r.unmount();
  });

  it("/rollback refusé : message d'échec", async () => {
    const r = await open("/work/cmds3");
    await type(r, "/rollback");
    await frameHas(r, "Action to approve");
    await decide(r, "4");
    await frameHas(r, "✗ Rollback to");
    r.unmount();
  });

  it("hors session de code (fil ordinaire) : message dédié", async () => {
    const r = await open("/work/cmds4");
    await type(r, "/thread ordinaire");
    await frameHas(r, "New thread");
    for (const c of ["/diff", "/rollback", "/checkpoints", "/skills", "/plan", "/agents"]) {
      await type(r, c);
      await wait(150);
    }
    const count = (r.lastFrame() ?? "").split("available in a code session (nokker in a folder)").length - 1;
    expect(count).toBe(6);
    r.unmount();
  });
});
