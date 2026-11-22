import { describe, expect, it } from "vitest";
import { effectLabel } from "../src/approval-model.js";

describe("libellé d'effet d'une carte", () => {
  it("un code qui s'exécute n'est pas « destructive » ; une vraie suppression l'est", () => {
    expect(effectLabel("destructive", "terminal", { command: 'python3 -c "print(6*7)"' })).toBe("runs code");
    expect(effectLabel("destructive", "terminal", { command: "rm -rf build" })).toBe("destructive");
    expect(effectLabel("destructive", "terminal", { command: "git reset --hard HEAD~3" })).toBe("destructive");
    expect(effectLabel("destructive", "delete_file", { path: "a" })).toBe("destructive");
    expect(effectLabel("destructive", "maison_action_forte", { action: "lampe" })).toBe("acts on a device");
    expect(effectLabel("destructive", "maison", {})).toBe("acts on a device");
    // Un outil MCP d'hôte au nom proche n'est pas un appareil de la maison.
    expect(effectLabel("destructive", "light_control", {})).toBe("destructive");
    expect(effectLabel("destructive", "device_reset", {})).toBe("destructive");
    expect(effectLabel("write", "terminal", {})).toBe("write");
    expect(effectLabel("destructive")).toBe("destructive");
  });
});
