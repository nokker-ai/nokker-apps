import { describe, expect, it } from "vitest";
import { clip, formatQueue, queueLine, type QueuedPrompt } from "../src/promptqueue.js";
import { parseSlashCommand } from "../src/commands.js";

const q = (shown: string, kind: QueuedPrompt["kind"] = "user"): QueuedPrompt => ({ text: shown, shown, kind });

describe("file de prompts (pur)", () => {
  it("barre « queued (n) » avec aperçu, coupée au-delà de 3 ; vide sans file", () => {
    expect(queueLine([])).toBe("");
    expect(queueLine([q("a"), q("b")])).toBe("queued (2): a · b");
    expect(queueLine([q("a"), q("b"), q("c"), q("d")])).toBe("queued (4): a · b · c · …");
    expect(queueLine([q("x".repeat(50))])).toBe(`queued (1): ${"x".repeat(29)}…`);
    expect(clip("  a \n b  ")).toBe("a b");
  });

  it("/queue : liste numérotée, boucles marquées ; /queue clear", () => {
    expect(formatQueue([])).toBe("The queue is empty.");
    expect(formatQueue([q("first"), q("check CI", "loop")])).toBe("Queued messages (2), sent one by one after the turn in progress:\n  1. first\n  2. check CI (loop)");
    expect(parseSlashCommand("/queue")).toEqual({ kind: "queue", clear: false });
    expect(parseSlashCommand("/queue clear")).toEqual({ kind: "queue", clear: true });
  });
});
