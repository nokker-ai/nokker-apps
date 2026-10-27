import { describe, expect, it } from "vitest";
import { agentStatusLabel, bubbleLabel } from "@nokker-apps/brand";

describe("libellés de la marque : anglais source, français par les tables *_FR", () => {
  it("bulles et états d'agent de la marque", () => {
    expect(bubbleLabel("search")).toBe("Web search");
    expect(bubbleLabel("search", "fr")).toBe("Recherche web");
    expect(bubbleLabel("hologramme")).toBe("Bubble");
    expect(bubbleLabel("hologramme", "fr")).toBe("Bulle");
    expect(agentStatusLabel("failed")).toBe("Failing");
    expect(agentStatusLabel("failed", "fr")).toBe("En échec");
    expect(agentStatusLabel("weird", "fr")).toBe("Au repos");
  });
});
