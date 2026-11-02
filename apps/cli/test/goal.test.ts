import { describe, expect, it } from "vitest";
import { GOAL_MAX_AUTO_TURNS, formatGoal, goalStatusLine, newGoal, nextGoalStep, parseGoalVerdict, splitGoalText, type TurnOutcome } from "../src/goal.js";
import { goalCheckPrompt, goalContinuePrompt } from "../src/prompts.js";
import { parseSlashCommand } from "../src/commands.js";

const out = (o: Partial<TurnOutcome>): TurnOutcome => ({ kind: "user", reply: "", failed: false, cancelled: false, cardPending: false, ...o });

describe("/goal (pur)", () => {
  it("verdict : dernier marqueur, casse et espaces tolérés, null sans marqueur", () => {
    expect(parseGoalVerdict("All good.\nGOAL: DONE")).toBe("done");
    expect(parseGoalVerdict("Not yet\ngoal:continue")).toBe("continue");
    expect(parseGoalVerdict("I would say GOAL: DONE once tests pass, not yet.\nGOAL: CONTINUE")).toBe("continue");
    expect(parseGoalVerdict("Done!")).toBeNull();
  });

  it("fin d'un tour ordinaire → vérification ; CONTINUE → relance ; DONE → atteint ; sans marqueur → arrêt", () => {
    const g = newGoal("tests pass");
    expect(nextGoalStep(g, out({}))).toEqual({ goal: g, send: "check", message: null });
    expect(nextGoalStep(g, out({ kind: "goalCheck", reply: "GOAL: CONTINUE" })).send).toBe("continue");
    const done = nextGoalStep(g, out({ kind: "goalCheck", reply: "ok\nGOAL: DONE" }));
    expect(done.goal.status).toBe("done");
    expect(done.message).toBe("✓ Goal reached: tests pass");
    expect(nextGoalStep(g, out({ kind: "goalCheck", reply: "maybe" })).message).toBe("Goal stopped: the check answer had no GOAL marker.");
    expect(nextGoalStep(g, out({ kind: "goalContinue" })).send).toBe("check");
  });

  it("garde-fous : 10 tours automatiques, carte en attente, annulation, erreur ; un objectif arrêté ne relance rien", () => {
    const g = { ...newGoal("x"), autoTurns: GOAL_MAX_AUTO_TURNS };
    expect(GOAL_MAX_AUTO_TURNS).toBe(10);
    expect(nextGoalStep(g, out({})).message).toBe("Goal stopped: 10 automatic turns reached.");
    expect(nextGoalStep(g, out({ kind: "goalCheck", reply: "GOAL: CONTINUE" })).goal.status).toBe("stopped");
    expect(nextGoalStep(g, out({ kind: "goalCheck", reply: "GOAL: DONE" })).goal.status).toBe("done");
    const a = newGoal("x");
    expect(nextGoalStep(a, out({ cardPending: true })).message).toBe("Goal stopped: an approval card is waiting.");
    expect(nextGoalStep(a, out({ cancelled: true })).message).toBe("Goal stopped: turn cancelled.");
    expect(nextGoalStep(a, out({ failed: true })).message).toBe("Goal stopped: the turn failed.");
    const stopped = nextGoalStep(a, out({ failed: true })).goal;
    expect(nextGoalStep(stopped, out({}))).toEqual({ goal: stopped, send: null, message: null });
  });

  it("barre d'état, /goal, commandes", () => {
    expect(goalStatusLine({ ...newGoal("make the tests pass"), autoTurns: 2 })).toBe("goal: make the tests pass · active, automatic turns 2/10");
    expect(goalStatusLine({ ...newGoal("g"), status: "stopped", reason: "turn cancelled" })).toBe("goal: g · stopped (turn cancelled)");
    expect(formatGoal(null)).toMatch(/^No goal set/);
    expect(parseSlashCommand("/goal")).toEqual({ kind: "goal", action: "show", text: "" });
    expect(parseSlashCommand("/goal clear")).toEqual({ kind: "goal", action: "clear", text: "" });
    expect(parseSlashCommand("/goal all tests green")).toEqual({ kind: "goal", action: "set", text: "all tests green" });
  });

  it("textes exacts envoyés au modèle", () => {
    expect(goalCheckPrompt("all tests green")).toBe(
      [
        "[Vérification du but]",
        "But de la session :",
        "all tests green",
        "",
        "En te fondant uniquement sur le travail déjà fait dans cette session, ce but est-il entièrement atteint ?",
        "N'utilise aucun outil et ne commence aucun nouveau travail dans cette réponse. Réponds en deux phrases au plus,",
        "puis termine par une dernière ligne qui est exactement GOAL: DONE si le but est entièrement atteint, ou GOAL: CONTINUE s'il reste du travail.",
        "[/Vérification du but]",
      ].join("\n"),
    );
    expect(goalContinuePrompt("all tests green")).toBe(
      "[Relance du but]\nContinue vers le but de la session :\nall tests green\n\nChoisis la prochaine étape concrète et fais-la. À la fin de ce tour, dis en une ou deux phrases ce que tu as fait et ce qui reste.\n[/Relance du but]",
    );
  });
});

describe("objectif tenu par le noyau", () => {
  const base = { reply: "", failed: false, cancelled: false, cardPending: false };
  const k = (status: string, extra: Record<string, unknown> = {}) => ({ id: "g", text: "x", driver: "client", status, ...extra }) as never;

  it("un « GOAL: DONE » dans la réponse ne termine rien : l'état du noyau décide", () => {
    const g = newGoal("x", true);
    const step = nextGoalStep(g, { ...base, kind: "goalCheck", reply: "All done.\nGOAL: DONE" }, k("active", { last_grade: { total: 1, max: 2, need: 2, passed: false } }));
    expect(step.goal.status).toBe("active");
    expect(step.send).toBe("continue");
    expect(step.goal.grade).toEqual({ total: 1, max: 2 });
  });

  it("done du noyau → atteint, même sans marqueur dans la réponse", () => {
    const step = nextGoalStep(newGoal("x", true), { ...base, kind: "goalCheck", reply: "" }, k("done"));
    expect(step.goal.status).toBe("done");
  });

  it("budget → arrêt avec l'état du noyau, pas « no GOAL marker »", () => {
    const step = nextGoalStep(newGoal("x", true), { ...base, kind: "goalCheck", reply: "[Correcteur] Objectif arrêté" }, k("budget", { stop_reason: "budget atteint : 2 tours" }));
    expect(step.goal.status).toBe("stopped");
    expect(step.message).toBe("Goal stopped: by the core: budget reached — budget atteint : 2 tours.");
    expect(step.message).not.toMatch(/marker/);
  });

  it("état illisible → arrêt", () => {
    expect(nextGoalStep(newGoal("x", true), { ...base, kind: "goalCheck" }, null).goal.status).toBe("stopped");
  });

  it("splitGoalText : première ligne = objectif, suivantes = critères", () => {
    expect(splitGoalText("ship it\n- tests pass\n2) docs updated")).toEqual({ text: "ship it", criteria: ["tests pass", "docs updated"] });
  });
});
