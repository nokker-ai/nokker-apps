import { describe, expect, it } from "vitest";
import { applyLiveInputEvent, liveTail, type LiveInputs } from "../src/live-input.js";
import { NOKKER_EVENT_TYPES, type ToolInputDeltaEvent } from "../src/types.js";

function delta(seq: number, text: string, extra: Partial<ToolInputDeltaEvent> = {}): ToolInputDeltaEvent {
  return { type: "tool.input.delta", thread_id: "th_1", turn_id: "th_1:0", call_id: "c1", name: "write_file", seq, text, ...extra };
}

describe("tool.input.delta (X22)", () => {
  it("fait partie des événements connus", () => {
    expect(NOKKER_EVENT_TYPES).toContain("tool.input.delta");
  });

  it("accumule par call_id, garde le chemin, ignore un seq déjà vu", () => {
    let live: LiveInputs = new Map();
    live = applyLiveInputEvent(live, delta(0, "", { path: "index.html", field: "content" }));
    live = applyLiveInputEvent(live, delta(1, "<html>\n"));
    const same = applyLiveInputEvent(live, delta(1, "<html>\n"));
    expect(same).toBe(live);
    live = applyLiveInputEvent(live, delta(2, "<body>\n"));
    const l = live.get("c1")!;
    expect(l.text).toBe("<html>\n<body>\n");
    expect(l.path).toBe("index.html");
    expect(l.field).toBe("content");
    expect(l.seq).toBe(2);
  });

  it("truncated fige le bloc ; discarded le retire", () => {
    let live: LiveInputs = applyLiveInputEvent(new Map(), delta(0, "a\n", { path: "a.txt" }));
    live = applyLiveInputEvent(live, delta(1, "b\n", { truncated: true }));
    expect(live.get("c1")!.truncated).toBe(true);
    expect(applyLiveInputEvent(live, delta(2, "c\n"))).toBe(live);
    live = applyLiveInputEvent(live, delta(3, "", { discarded: true }));
    expect(live.has("c1")).toBe(false);
  });

  it("tool.result du même call_id ou turn.done du tour clôt le bloc", () => {
    let live: LiveInputs = applyLiveInputEvent(new Map(), delta(0, "x", { path: "a" }));
    live = applyLiveInputEvent(live, { ...delta(0, "y"), call_id: "c2" });
    live = applyLiveInputEvent(live, { type: "tool.result", thread_id: "th_1", call_id: "c1", name: "write_file", is_error: false });
    expect([...live.keys()]).toEqual(["c2"]);
    const other = applyLiveInputEvent(live, { type: "turn.done", thread_id: "th_1", turn_id: "th_1:9", usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    expect(other).toBe(live);
    live = applyLiveInputEvent(live, { type: "turn.done", thread_id: "th_1", turn_id: "th_1:0", usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    expect(live.size).toBe(0);
  });

  it("liveTail : dernières lignes, coupées à la largeur", () => {
    expect(liveTail("1\n2\n3\n4\n", 2)).toEqual(["3", "4"]);
    expect(liveTail("abcdefgh", 1, 5)).toEqual(["abcd…"]);
    expect(liveTail("", 3)).toEqual([]);
  });
});
