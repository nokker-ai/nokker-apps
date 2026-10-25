import { describe, expect, it } from "vitest";
import { ageLabel, agentBreathes, loadSummary, moveTargets } from "../src/crew/deckModel.js";

describe("deck multi-machines (X15)", () => {
  it("charge lisible", () => {
    const l = loadSummary({ ram: { total_mb: 32768, free_mb: 8192 }, cpu: { count: 16, load1: 8, rel: 0.5 }, gpus: [{ name: "g", memory_total_mb: 1, memory_free_mb: 1, util_pct: 1 }], sessions: 1, active_turns: 0 });
    expect(l).toEqual({ ramPct: 75, cpuPct: 50, text: "8,0 Go libres sur 32 · CPU 50 % · 1 GPU" });
    expect(loadSummary(null)).toBeNull();
  });
  it("respiration, âge, destinations", () => {
    expect(agentBreathes({ status: "armed", live_run: { run_id: "r", status: "running", machine_id: "mc_a" } })).toBe(true);
    expect(agentBreathes({ status: "paused", live_run: null })).toBe(false);
    expect(ageLabel(null)).toBe("jamais vue");
    expect(ageLabel(150)).toBe("il y a 2 min");
    const t = moveTargets([{ machine_id: "mc_a", name: "Atelier", online: true }, { machine_id: "mc_b", name: "Portable", online: false }], "mc_a");
    expect(t.map((x) => x.to)).toEqual(["web", "auto", "mc_b"]);
    expect(t[2]!.label).toBe("Portable (hors ligne)");
    expect(moveTargets([], null).map((x) => x.to)).toEqual(["auto"]);
  });
});
