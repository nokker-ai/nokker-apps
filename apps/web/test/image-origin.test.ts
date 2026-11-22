import { describe, expect, it } from "vitest";
import type { ThreadMessage } from "@nokker-apps/sdk";
import { isPersonImage, splitImages, toolImagesByTurn } from "../src/components/imageOrigin.js";

const im = (sha256: string, origin?: string) => ({ sha256, media_type: "image/png", size: 10, name: `${sha256}.png`, ...(origin ? { origin } : {}) });

describe("origine des images d'un tour (r44)", () => {
  it("sans origine ou « user » : la personne ; « tool:read_file » (et tout tool:…) : Nina, jamais la personne", () => {
    expect(isPersonImage(im("a"))).toBe(true);
    expect(isPersonImage(im("b", "user"))).toBe(true);
    expect(isPersonImage(im("c", "tool:read_file"))).toBe(false);
    expect(isPersonImage(im("d", "tool:autre"))).toBe(false);
    const s = splitImages([im("a"), im("c", "tool:read_file")]);
    expect([s.person.map((x) => x.sha256), s.tool.map((x) => x.sha256)]).toEqual([["a"], ["c"]]);
  });
  it("les images lues par Nina vont au tour, côté réponse", () => {
    const msgs: ThreadMessage[] = [
      { index: 0, role: "user", content: "lis cap.png", images: [im("cap", "tool:read_file")] },
      { index: 0, role: "assistant", content: "c'est un cap" },
      { index: 1, role: "user", content: "et ma photo", images: [im("moi")] },
    ];
    const t = toolImagesByTurn(msgs);
    expect([...t.keys()]).toEqual([0]);
    expect(t.get(0)!.map((x) => x.sha256)).toEqual(["cap"]);
  });
});
