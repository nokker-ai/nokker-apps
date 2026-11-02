/** Rendu Ink de l'App contre le mock : diagnostics de langage, file de prompts, /btw, /goal, /loop (anglais par défaut). */
import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import { App } from "../src/ui/App.js";

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
async function type(r: ReturnType<typeof render>, text: string): Promise<void> {
  await wait(100);
  r.stdin.write(text);
  await wait(50);
  await wait(100);
  r.stdin.write("\r");
}
async function repo(name: string): Promise<string> {
  const root = join(work, name);
  await mkdir(join(root, ".git"), { recursive: true });
  return root;
}
async function ready(r: ReturnType<typeof render>): Promise<void> {
  await frameHas(r, "/help for the commands.");
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-cli-next-"));
  work = await mkdtemp(join(tmpdir(), "nokker-cli-next-work-"));
  process.env.NOKKER_CONFIG_DIR_OVERRIDE = dir;
  mock = await startMockServer({ port: 0, seed: false, speed: 0.05, lsp: true });
});
afterAll(async () => {
  await mock.close();
  if (keep === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
  else process.env.NOKKER_CONFIG_DIR_OVERRIDE = keep;
  await rm(dir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

describe("diagnostics de langage", () => {
  it("ligne sous l'outil quand une édition casse le typage, « no errors » à la réparation, /diagnostics [chemin], 403 clair", async () => {
    const r = render(<App baseUrl={mock.url} cwd={await repo("lsp")} />);
    await ready(r);
    await type(r, "break the types in calc");
    await frameHas(r, "⚠ 2 errors in src/calc.py");
    const f = r.lastFrame()!;
    expect(f.indexOf("⚠ 2 errors in src/calc.py")).toBeGreaterThan(f.lastIndexOf("patch"));
    await type(r, "/diagnostics");
    await frameHas(r, "Language diagnostics (last state per file):");
    expect(r.lastFrame()).toContain('12:5 error reportAttributeAccessIssue: Cannot access attribute "foo" for class "int"');
    await type(r, "/diagnostics src/calc.py");
    await frameHas(r, "Language servers: pyright");
    await type(r, "fix the type errors");
    await frameHas(r, "✓ src/calc.py: no errors");
    mock.state.lsp = false;
    try {
      await type(r, "/diagnostics src/calc.py");
      await frameHas(r, "Language diagnostics are not available on this core");
    } finally {
      mock.state.lsp = true;
    }
    r.unmount();
  });
});

/** Tours du fil côté mock (texte utilisateur reçu par le « noyau »). */
const userTurns = (th: string): string[] => (mock.state.threads.get(th)?.turns ?? []).map((t) => t.user);
const threadOf = (cwd: string): string => [...mock.state.localSessions.entries()].find(([, v]) => v.cwd === cwd)![0];
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

describe("file de prompts", () => {
  it("messages tapés pendant un tour : en file (affichée), envoyés un par un dans l'ordre ; /queue ; jamais deux requêtes à la fois", async () => {
    const cwd = await repo("queue");
    const r = render(<App baseUrl={mock.url} cwd={cwd} />);
    await ready(r);
    process.env.NOKKER_MOCK_THINK_MS = "1200";
    let maxActive = 0;
    const probe = setInterval(() => (maxActive = Math.max(maxActive, mock.state.activeTurns.size + (mock.state.threadBusy(threadOf(cwd)) ? 0 : 0))), 5);
    try {
      await type(r, "first message");
      await frameHas(r, "turn in progress");
      await type(r, "second message");
      await type(r, "third message");
      await frameHas(r, "queued (2): second message · third message");
      await type(r, "/queue");
      await frameHas(r, "Queued messages (2), sent one by one after the turn in progress:");
      expect(r.lastFrame()).toContain("  2. third message");
      const th = threadOf(cwd);
      const t0 = Date.now();
      while (userTurns(th).length < 3 && Date.now() - t0 < 15_000) await wait(50);
      expect(userTurns(th)).toEqual(["first message", "second message", "third message"]);
      const t1 = Date.now();
      while (count(r.lastFrame()!, "Local session on") < 3 && Date.now() - t1 < 5000) await wait(50);
      expect(count(r.lastFrame()!, "Local session on")).toBe(3);
      expect(r.lastFrame()).not.toContain("queued (1): third message"); // la barre de file a disparu
    } finally {
      clearInterval(probe);
      delete process.env.NOKKER_MOCK_THINK_MS;
    }
    expect(maxActive).toBeLessThanOrEqual(1);
    r.unmount();
  });

  it("/cancel sans tour : le noyau rend l'id du fil et running: false → « No turn in progress. » (D4)", async () => {
    const cwd = await repo("cancel-idle");
    const r = render(<App baseUrl={mock.url} cwd={cwd} />);
    await ready(r);
    try {
      await type(r, "/cancel");
      await frameHas(r, "No turn in progress.");
      expect(r.lastFrame()).not.toContain("cancellation requested");
    } finally {
      r.unmount();
    }
  });

  it("Échap pendant une réponse en flux : reset puis « Annulé à ta demande. », aucun reste du texte partiel, file vidée (D6)", async () => {
    const cwd = await repo("cancel-stream");
    const r = render(<App baseUrl={mock.url} cwd={cwd} />);
    await ready(r);
    const speed = mock.state.speed;
    mock.state.speed = 5; // 200 ms par mot : l'annulation tombe au milieu du texte
    try {
      await type(r, "write a long answer");
      await frameHas(r, "Here is a long");
      await type(r, "queued then dropped");
      await frameHas(r, "queued (1)");
      r.stdin.write("\u001b");
      await frameHas(r, "Queue cleared: 1 message(s) not sent.");
      await frameHas(r, "Annulé à ta demande.");
      await frameHas(r, "turn cancelled");
      const t0 = Date.now();
      while (r.lastFrame()!.includes("turn in progress") && Date.now() - t0 < 10_000) await wait(50);
      await wait(400);
      const frame = r.lastFrame()!;
      expect(frame).not.toContain("Here is a long");
      expect(frame.match(/Annulé à ta demande\./g)).toHaveLength(1);
      expect(userTurns(threadOf(cwd)).filter((u) => u.startsWith("queued then"))).toEqual([]);
    } finally {
      mock.state.speed = speed;
      r.unmount();
    }
  });

  it("Échap annule le tour en cours ET vide la file (message) ; /queue clear vide sans annuler", async () => {
    const cwd = await repo("queue-esc");
    const r = render(<App baseUrl={mock.url} cwd={cwd} />);
    await ready(r);
    // Tour long et sans carte : outils lents (vitesse ×100), terminal permis pour la session.
    const speed = mock.state.speed;
    mock.state.speed = 5;
    mock.state.sessionRules.set(threadOf(cwd), ["terminal"]);
    try {
      await type(r, "fix test test_app");
      await frameHas(r, "turn in progress");
      await type(r, "never sent one");
      await type(r, "never sent two");
      await frameHas(r, "queued (2)");
      const t9 = Date.now();
      while (!mock.state.activeTurns.has(threadOf(cwd)) && Date.now() - t9 < 8000) await wait(20);
      expect(mock.state.activeTurns.has(threadOf(cwd))).toBe(true);
      r.stdin.write("\u001b");
      await frameHas(r, "Queue cleared: 2 message(s) not sent.");
      await frameHas(r, "cancellation requested");
      const t0 = Date.now();
      while (r.lastFrame()!.includes("turn in progress") && Date.now() - t0 < 10_000) await wait(50);
      await wait(800);
      expect(userTurns(threadOf(cwd)).filter((u) => u.startsWith("never sent"))).toEqual([]);

      mock.state.speed = speed;
      process.env.NOKKER_MOCK_THINK_MS = "1500";
      await type(r, "plain one");
      await frameHas(r, "turn in progress");
      await type(r, "dropped by clear");
      await frameHas(r, "queued (1)");
      await type(r, "/queue clear");
      await frameHas(r, "Queue cleared: 1 message(s) not sent.");
      const t1 = Date.now();
      while (!userTurns(threadOf(cwd)).includes("plain one") && Date.now() - t1 < 10_000) await wait(50);
      await wait(800);
      expect(userTurns(threadOf(cwd))).not.toContain("dropped by clear");
    } finally {
      mock.state.speed = speed;
      delete process.env.NOKKER_MOCK_THINK_MS;
    }
    r.unmount();
  });
});

describe("/mode (§7.4.10)", () => {
  it("barre d'état, /mode, /mode <nom>, 400 lisibles, session.mode d'un autre client", async () => {
    const cwd = await repo("mode");
    const r = render(<App baseUrl={mock.url} cwd={cwd} />);
    await ready(r);
    try {
      await frameHas(r, "· mode: accept_edits");
      await type(r, "/mode");
      await frameHas(r, "Mode of this session: accept_edits");
      await frameHas(r, "Modes: default, accept_edits, auto, plan");
      await type(r, "/mode plan");
      await frameHas(r, "Mode of this session: plan.");
      await frameHas(r, "· mode: plan");
      expect(mock.state.effectiveSettings(threadOf(cwd)).mode).toBe("plan");
      await type(r, "/mode yolo");
      await frameHas(r, "Unknown mode: yolo (modes: default, accept_edits, auto, plan).");
      // Le dépôt impose `default` : `auto` refusé ; le choix d'avant (plan) reste.
      process.env.MOCK_PROJECT_MODE = "default";
      await type(r, "/mode auto");
      await frameHas(r, "Mode auto refused: the repository or a team imposes a stricter mode on this session.");
      // Un autre client (VS Code…) a changé le mode avant la restriction : l'événement `session.mode` met la barre à jour.
      mock.state.sessionModes.set(threadOf(cwd), "accept_edits");
      mock.state.publish({ type: "session.mode", thread_id: threadOf(cwd), mode: "accept_edits", effective: "default" });
      await frameHas(r, "· mode: accept_edits → default");
    } finally {
      delete process.env.MOCK_PROJECT_MODE;
      r.unmount();
    }
  });
});

describe("/btw", () => {
  it("pendant un tour : fil séparé, contexte court (dossier, titre), réponse dans l'encadré ; le fil courant n'en garde rien", async () => {
    const cwd = await repo("btw");
    const r = render(<App baseUrl={mock.url} cwd={cwd} />);
    await ready(r);
    process.env.NOKKER_MOCK_THINK_MS = "1500";
    try {
      await type(r, "main work");
      await frameHas(r, "turn in progress");
      await type(r, "/btw what does HTTP 418 mean?");
      await frameHas(r, "by the way");
      await frameHas(r, "› what does HTTP 418 mean?");
      const main = threadOf(cwd);
      const t0 = Date.now();
      let btw: string | undefined;
      while (Date.now() - t0 < 10_000) {
        btw = [...mock.state.threads.values()].find((rec) => rec.thread.title === "annexe" && rec.turns.some((tu) => tu.user.includes("HTTP 418")))?.thread.id;
        if (btw && userTurns(main).includes("main work")) break;
        await wait(50);
      }
      expect(btw).toBeDefined();
      expect(btw).not.toBe(main);
      const sent = userTurns(btw!).at(-1)!;
      expect(sent).toContain("[Question annexe]");
      expect(sent).toContain(`dossier de travail ${cwd}`);
      expect(sent).toContain("\nwhat does HTTP 418 mean?\n[/Question annexe]");
      expect(sent).not.toContain("main work"); // pas d'historique
      expect(userTurns(main)).toEqual(["main work"]);
      expect(r.lastFrame()).not.toContain("[other thread");
      // Deuxième question : même fil séparé.
      await type(r, "/btw and 451?");
      const t1 = Date.now();
      while (!userTurns(btw!).some((u) => u.includes("and 451?")) && Date.now() - t1 < 10_000) await wait(50);
      expect(userTurns(btw!).length).toBe(2);
      expect(userTurns(main)).toEqual(["main work"]);
    } finally {
      delete process.env.NOKKER_MOCK_THINK_MS;
    }
    r.unmount();
  });
});

describe("/goal", () => {
  it("barre d'état ; vérification après le tour ; CONTINUE → relance ; DONE → atteint ; plus rien ensuite", async () => {
    const cwd = await repo("goal-done");
    const r = render(<App baseUrl={mock.url} cwd={cwd} />);
    await ready(r);
    await type(r, "/goal say hello to the team");
    await frameHas(r, "◎ goal: say hello to the team · active, automatic turns 0/10");
    await type(r, "hello there");
    await frameHas(r, "✓ Goal reached: say hello to the team", 20_000);
    await frameHas(r, "goal: say hello to the team · reached");
    const turns = userTurns(threadOf(cwd));
    expect(turns).toHaveLength(4);
    expect(turns[0]).toBe("hello there");
    expect(turns[1]).toMatch(/^\[Vérification du but\]\nBut de la session :\nsay hello to the team\n/);
    expect(turns[2]).toMatch(/^\[Relance du but\]\nContinue vers le but de la session :\nsay hello to the team\n/);
    expect(turns[3]).toMatch(/^\[Vérification du but\]/);
    expect(r.lastFrame()).toContain("› (goal) is the goal reached? (1/10)");
    expect(r.lastFrame()).toContain("› (goal) continue toward the goal (2/10)");
    await wait(800);
    expect(userTurns(threadOf(cwd))).toHaveLength(4);
    await type(r, "/goal clear");
    await frameHas(r, "Goal cleared.");
    expect(r.lastFrame()).not.toContain("◎ goal:");
    r.unmount();
  });

  it("10 tours automatiques au plus", async () => {
    const cwd = await repo("goal-limit");
    const before = mock.state.goalChecksBeforeDone;
    mock.state.goalChecksBeforeDone = 1000;
    try {
      const r = render(<App baseUrl={mock.url} cwd={cwd} />);
      await ready(r);
      await type(r, "/goal never satisfied");
      await type(r, "start");
      await frameHas(r, "Goal stopped: 10 automatic turns reached.", 80_000);
      await wait(800);
      expect(userTurns(threadOf(cwd))).toHaveLength(11);
      await type(r, "/goal");
      await frameHas(r, "goal: never satisfied · stopped (10 automatic turns reached)");
      r.unmount();
    } finally {
      mock.state.goalChecksBeforeDone = before;
    }
  }, 120_000);

  describe("objectif tenu par le noyau (GET …/goal répond)", () => {
    function kernelGoals(on: boolean, gradesBeforePass = 1): () => void {
      const prev = [mock.state.goals, mock.state.goalGradesBeforePass] as const;
      mock.state.goals = on;
      mock.state.goalGradesBeforePass = gradesBeforePass;
      return () => {
        mock.state.goals = prev[0];
        mock.state.goalGradesBeforePass = prev[1];
      };
    }

    it("/goal pose l'objectif chez le noyau ; un « GOAL: DONE » du modèle ne termine rien, seule la note du noyau", async () => {
      const restore = kernelGoals(true, 2);
      try {
        const cwd = await repo("goal-kernel-done");
        const r = render(<App baseUrl={mock.url} cwd={cwd} />);
        await ready(r);
        await type(r, "/goal ship the release notes");
        await frameHas(r, "Goal set on the core: ship the release notes");
        const tid = threadOf(cwd);
        expect(mock.state.kernelGoals.get(tid)).toMatchObject({ text: "ship the release notes", driver: "client", status: "active" });
        await type(r, "go");
        await frameHas(r, "✓ Goal reached (graded by the core): ship the release notes", 30_000);
        // Le modèle a écrit « GOAL: DONE » dès le premier tour : la CLI a quand même suivi le correcteur (3 notes).
        const turns = userTurns(tid);
        expect(turns).toHaveLength(6); // go, check, continue, check, continue, check
        expect(mock.state.kernelGoals.get(tid)).toMatchObject({ status: "done", gradings: 3 });
        expect(r.lastFrame()).not.toContain("no GOAL marker");
        await type(r, "/goal");
        await frameHas(r, "Graded by the core");
        r.unmount();
      } finally {
        restore();
      }
    }, 60_000);

    it("arrêt sur budget : l'état rendu par le noyau, pas « no GOAL marker »", async () => {
      const restore = kernelGoals(true, 1000);
      try {
        const cwd = await repo("goal-kernel-budget");
        const r = render(<App baseUrl={mock.url} cwd={cwd} />);
        await ready(r);
        await type(r, "/goal never done");
        await frameHas(r, "Goal set on the core: never done");
        const tid = threadOf(cwd);
        mock.state.kernelGoals.set(tid, { ...mock.state.kernelGoals.get(tid)!, budget: { turns: 2 } });
        await type(r, "go");
        await frameHas(r, "Goal stopped: by the core: budget reached — budget atteint : 2 tours.", 30_000);
        expect(r.lastFrame()).not.toContain("no GOAL marker");
        expect(mock.state.kernelGoals.get(tid)).toMatchObject({ status: "budget" });
        await wait(600);
        expect(userTurns(tid)).toHaveLength(4); // go, check, continue, check
        r.unmount();
      } finally {
        restore();
      }
    }, 60_000);

    it("/goal clear arrête l'objectif chez le noyau", async () => {
      const restore = kernelGoals(true, 1000);
      try {
        const cwd = await repo("goal-kernel-clear");
        const r = render(<App baseUrl={mock.url} cwd={cwd} />);
        await ready(r);
        await type(r, "/goal something long");
        await frameHas(r, "Goal set on the core: something long");
        await type(r, "/goal clear");
        await frameHas(r, "Goal cleared.");
        const tid = threadOf(cwd);
        await wait(300);
        expect(mock.state.kernelGoals.get(tid)).toMatchObject({ status: "stopped" });
        r.unmount();
      } finally {
        restore();
      }
    }, 30_000);
  });

  it("arrêt sur carte d'approbation : aucune vérification n'est envoyée", async () => {
    const cwd = await repo("goal-card");
    const r = render(<App baseUrl={mock.url} cwd={cwd} />);
    await ready(r);
    await type(r, "/goal fix it all");
    await type(r, "fix test test_app");
    await frameHas(r, "Goal stopped: an approval card is waiting.");
    await frameHas(r, "Action to approve");
    await wait(700);
    r.stdin.write("4"); // refuser
    await wait(50);
    r.stdin.write("\r");
    const t0 = Date.now();
    while (r.lastFrame()!.includes("Action to approve") && Date.now() - t0 < 10_000) await wait(50);
    await wait(1500);
    expect(userTurns(threadOf(cwd)).filter((u) => u.startsWith("[Vérification du but]"))).toEqual([]);
    expect(r.lastFrame()).toContain("stopped (an approval card is waiting)");
    r.unmount();
  });
});

describe("/loop", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanup.splice(0)) c();
  });
  it("première relance tout de suite, puis à l'intervalle ; jamais pendant un tour (une seule en file) ; Échap ne l'arrête pas ; /loop, /loop stop", async () => {
    const cwd = await repo("loop");
    const r = render(<App baseUrl={mock.url} cwd={cwd} loopTimeScale={0.01} />);
    cleanup.push(() => r.unmount());
    await ready(r);
    await type(r, "/loop 10s ping status");
    await frameHas(r, "Interval raised to the 30s floor.");
    await frameHas(r, "⟳ loop #1 every 30s");
    const th = threadOf(cwd);
    const t0 = Date.now();
    while (userTurns(th).length < 3 && Date.now() - t0 < 10_000) await wait(25);
    const turns = userTurns(th);
    expect(turns[0]).toBe("[Exécution planifiée 1/50, toutes les 30 s]\nPars de l'état actuel ; si rien n'a changé depuis la dernière exécution, dis-le en une ligne.\n\nping status\n[/Exécution planifiée]");
    expect(turns[1]).toMatch(/^\[Exécution planifiée 2\/50, toutes les 30 s\]/);
    expect(r.lastFrame()).toContain("› (loop #1, 1/50) ping status");

    // Un tour long : les relances qui tombent pendant ce tour attendent, une seule à la fois dans la file.
    process.env.NOKKER_MOCK_THINK_MS = "1500";
    try {
      await type(r, "long work");
      await frameHas(r, "turn in progress");
      // Plusieurs échéances (300 ms) tombent pendant ce tour : jamais plus d'une relance de la boucle dans la file.
      for (let k = 0; k < 12; k++) {
        await wait(100);
        const bar = r.lastFrame()!.split("\n").find((l) => l.startsWith("queued (")) ?? "";
        expect(bar.split("(loop #1").length - 1).toBeLessThanOrEqual(1);
      }
      // Échap : le tour et la file, pas la boucle.
      r.stdin.write("\u001b");
      await frameHas(r, "Queue cleared");
    } finally {
      delete process.env.NOKKER_MOCK_THINK_MS;
    }
    await type(r, "/loop");
    await frameHas(r, "Loops (1):");
    await type(r, "/loop stop");
    await frameHas(r, "Stopped: #1.");
    expect(r.lastFrame()).not.toContain("⟳ loop #1");
    await wait(1500);
    const n = userTurns(th).length;
    await wait(1000);
    expect(userTurns(th).length).toBe(n);
    r.unmount();
  });
});
