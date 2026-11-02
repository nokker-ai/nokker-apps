import { describe, expect, it } from "vitest";
import { LOOP_MAX_RUNS, LOOP_MIN_MS, clampInterval, formatInterval, formatLoops, loopTickDecision, loopsStatusLine, parseInterval } from "../src/loop.js";
import { loopPrompt, intervalFr } from "../src/prompts.js";
import { parseSlashCommand } from "../src/commands.js";

describe("/loop (pur)", () => {
  it("intervalle : s, m, 1m30s ; plancher 30 s ; 50 relances", () => {
    expect(parseInterval("45s")).toBe(45_000);
    expect(parseInterval("5m")).toBe(300_000);
    expect(parseInterval("1m30s")).toBe(90_000);
    expect(parseInterval("5")).toBeNull();
    expect(parseInterval("2h")).toBeNull();
    expect(parseInterval("0s")).toBeNull();
    expect(clampInterval(10_000)).toEqual({ ms: LOOP_MIN_MS, raised: true });
    expect(clampInterval(60_000)).toEqual({ ms: 60_000, raised: false });
    expect(formatInterval(90_000)).toBe("1m30s");
    expect(formatInterval(30_000)).toBe("30s");
    expect(LOOP_MIN_MS).toBe(30_000);
    expect(LOOP_MAX_RUNS).toBe(50);
  });

  it("échéance : relance numérotée, sautée si la précédente attend encore, 50e = dernière, rien au-delà", () => {
    expect(loopTickDecision({ runs: 0 }, false)).toEqual({ skip: false, run: 1, last: false });
    expect(loopTickDecision({ runs: 3 }, true)).toEqual({ skip: true });
    expect(loopTickDecision({ runs: 49 }, false)).toEqual({ skip: false, run: 50, last: true });
    expect(loopTickDecision({ runs: 50 }, false)).toEqual({ skip: true });
  });

  it("commandes", () => {
    expect(parseSlashCommand("/loop")).toEqual({ kind: "loop", action: "list" });
    expect(parseSlashCommand("/loop stop")).toEqual({ kind: "loop", action: "stop", id: null });
    expect(parseSlashCommand("/loop stop #2")).toEqual({ kind: "loop", action: "stop", id: 2 });
    expect(parseSlashCommand("/loop 5m check the CI status")).toEqual({ kind: "loop", action: "start", interval: "5m", prompt: "check the CI status" });
  });

  it("liste, barre d'état, texte exact envoyé au modèle", () => {
    expect(formatLoops([], 0)).toMatch(/^No loop running/);
    const l = { id: 1, everyMs: 300_000, every: "5m", prompt: "check the CI", runs: 3, nextAt: 130_000 };
    expect(formatLoops([l], 0)).toBe("Loops (1):\n  #1  every 5m · 3/50 runs · next in 2m10s  check the CI\n/loop stop [#id] stops them (all by default).");
    expect(loopsStatusLine([l])).toBe("loop #1 every 5m (3/50)");
    expect(loopsStatusLine([])).toBeNull();
    expect(loopPrompt("check the CI", 3, 50, 300_000)).toBe(
      "[Exécution planifiée 3/50, toutes les 5 min]\nPars de l'état actuel ; si rien n'a changé depuis la dernière exécution, dis-le en une ligne.\n\ncheck the CI\n[/Exécution planifiée]",
    );
    expect(intervalFr(30_000)).toBe("30 s");
    expect(intervalFr(90_000)).toBe("1 min 30 s");
    expect(intervalFr(3_600_000)).toBe("1 h");
  });
});
