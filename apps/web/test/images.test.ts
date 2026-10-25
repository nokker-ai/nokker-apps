import { describe, expect, it } from "vitest";
import { MAX_IMAGES, MAX_IMAGE_BYTES, messageContent, refuseImage } from "../src/composer/images.js";

describe("images jointes (X7)", () => {
  it("refus : type, taille, nombre", () => {
    expect(refuseImage({ type: "image/png", size: 10 }, 0)).toBeNull();
    expect(refuseImage({ type: "image/svg+xml", size: 10 }, 0)).toBe("type");
    expect(refuseImage({ type: "application/pdf", size: 10 }, 0)).toBe("type");
    expect(refuseImage({ type: "image/jpeg", size: MAX_IMAGE_BYTES + 1 }, 0)).toBe("size");
    expect(refuseImage({ type: "image/webp", size: 10 }, MAX_IMAGES)).toBe("count");
  });
  it("contenu : texte seul sans image, parties sinon", () => {
    expect(messageContent("bonjour", [])).toBe("bonjour");
    expect(messageContent("regarde", [{ dataUrl: "data:image/png;base64,AA" }])).toEqual([
      { type: "text", text: "regarde" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
    ]);
    expect(messageContent("  ", [{ dataUrl: "data:image/png;base64,AA" }])).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }]);
  });
});
