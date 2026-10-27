import { describe, expect, it } from "vitest";
import { incidentStateLabel, planCardKindLabel, planCardStatusLabel } from "../src/index.js";

describe("libellés du SDK : anglais source, français par les tables *_FR", () => {
  it("états d'incident et cartes du plan", () => {
    expect(incidentStateLabel("in_progress")).toBe("in progress");
    expect(incidentStateLabel("resolved", "fr")).toBe("résolu");
    expect(planCardStatusLabel("todo")).toBe("to do");
    expect(planCardStatusLabel("blocked", "fr")).toBe("bloqué");
    expect(planCardKindLabel("milestone")).toBe("milestone");
    expect(planCardKindLabel("task", "fr")).toBe("tâche");
  });
});
