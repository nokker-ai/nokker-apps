/**
 * Rendu réel (ink-testing-library, MIT) de la ligne de bulle — vérifie ce que `bubbleLineModel.test.ts`
 * ne peut pas : que le composant Ink affiche effectivement titre, libellé et indice dans le texte rendu.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { Bubble } from "@nokker-apps/sdk";
import { BubbleLine } from "../src/ui/BubbleLine.js";

const searchBubble: Bubble = {
  id: "bu_search1",
  thread_id: "th_general",
  kind: "search",
  title: "Libérer de l'espace",
  status: "working",
  state: { query: "libérer de l'espace docker", took_ms: 0, engines: ["démo"], results: [] },
  actions: [],
  origin: null,
  shared_with: { members: [], threads: [] },
  created_by: "nina",
  created_at: "2026-10-18T00:00:00Z",
  updated_at: "2026-10-18T00:00:00Z",
  closed_at: null,
  version: 1,
} as Bubble;

const notifyBubble: Bubble = {
  id: "bu_notify1",
  thread_id: null,
  kind: "notify",
  title: "Compta",
  status: "done",
  state: { from_thread: "th_compta", from_title: "Compta", text: "Facture reçue", approval_id: null, actions: [] },
  actions: [],
  origin: null,
  shared_with: { members: ["alice"], threads: [] },
  created_by: "nina",
  created_at: "2026-10-18T00:00:00Z",
  updated_at: "2026-10-18T00:00:00Z",
  closed_at: null,
  version: 1,
} as Bubble;

describe("BubbleLine (ink-testing-library)", () => {
  it("affiche le titre et le libellé de la bulle", () => {
    const { lastFrame } = render(<BubbleLine bubble={searchBubble} spinnerFrame={0} />);
    const frame = lastFrame();
    expect(frame).toContain("Libérer de l'espace");
    expect(frame).toContain("Recherche web");
  });

  it("affiche l'indice /goto pour une bulle notify", () => {
    const { lastFrame } = render(<BubbleLine bubble={notifyBubble} spinnerFrame={0} />);
    expect(lastFrame()).toContain("/goto th_compta");
  });

  it("tient sur une seule ligne (compact)", () => {
    const { lastFrame } = render(<BubbleLine bubble={searchBubble} spinnerFrame={0} />);
    const frame = lastFrame() ?? "";
    expect(frame.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1);
  });

  it("artifact : titre + « page <nom> »", () => {
    const b = {
      ...searchBubble,
      kind: "artifact",
      title: "Tarifs",
      status: "done",
      state: { page_id: "pg_0123456789abcdef", path: "tarifs.html", title: "Tarifs", mime: "text/html", version: 1, size: 10, public: false, updated_at: "2026-10-24T00:00:00Z" },
    } as unknown as Bubble;
    const frame = render(<BubbleLine bubble={b} spinnerFrame={0} />).lastFrame();
    expect(frame).toContain("Tarifs");
    expect(frame).toContain("page tarifs.html");
  });

  it("ignore proprement un kind inconnu du client", () => {
    const b = { ...searchBubble, kind: "hologramme", title: "Futur", state: {} } as unknown as Bubble;
    const frame = render(<BubbleLine bubble={b} spinnerFrame={0} />).lastFrame();
    expect(frame).toContain("Futur");
  });
});
