import { describe, expect, it } from "vitest";
import { NokkerApiError, type NokkerEvent } from "@nokker-apps/sdk";
import { TEXTS, codeError, subStatus } from "../src/code/model.js";
import { eventSession, shortSha } from "../src/code/SessionExtras.js";

describe("sessions de code : skills du dépôt et sous-agents (écran)", () => {
  it("un événement est rattaché à sa session, fil d'enfant et préfixe du locataire compris", () => {
    const started = { type: "subagent.started", thread_id: "cs_0123456789abcdef/sa-sa1", parent_thread_id: "cs_0123456789abcdef", parent_turn: 0, child_id: "sa1", goal: "g" } as NokkerEvent;
    expect(eventSession(started)).toBe("cs_0123456789abcdef");
    const scoped = { type: "subagent.finished", parent_thread_id: "tn_1:cs_0123456789abcdef", child_id: "sa1", status: "completed", commits: 0, dirty: false } as NokkerEvent;
    expect(eventSession(scoped)).toBe("cs_0123456789abcdef");
    const progress = { type: "subagent.progress", thread_id: "tn_1:cs_0123456789abcdef/sa-sa2", child_id: "sa2", tool: "read_file", ms: 3 } as NokkerEvent;
    expect(eventSession(progress)).toBe("cs_0123456789abcdef");
    const untrusted = { type: "skill.untrusted", thread_id: "tn_1:cs_0123456789abcdef", session_id: "cs_0123456789abcdef", root: "/workspace", sha256: "a", count: 2, notice: "n" } as NokkerEvent;
    expect(eventSession(untrusted)).toBe("cs_0123456789abcdef");
    expect(eventSession({ type: "turn.done", thread_id: "th_1", turn_id: "x" } as unknown as NokkerEvent)).toBeNull();
  });

  it("libellés et refus de la confiance, dans les deux langues", () => {
    expect(shortSha("0123456789abcdef0123")).toBe("0123456789ab");
    expect(shortSha(null)).toBe("—");
    expect(subStatus("fr", "interrupted")).toBe("interrompu");
    expect(subStatus("en", "running")).toBe("running");
    expect(subStatus("en", "weird")).toBe("weird");
    for (const code of ["skills_absent", "skills_changed"]) {
      const e = new NokkerApiError("x", code === "skills_changed" ? 409 : 404, { error: { code, message: "m" } });
      expect(codeError("fr", e)).toBe(TEXTS.fr[`e_${code}` as keyof (typeof TEXTS)["fr"]]);
      expect(codeError("en", e)).toBe(TEXTS.en[`e_${code}` as keyof (typeof TEXTS)["en"]]);
    }
  });
});
