import { describe, expect, it } from "vitest";
import { argsSha256, canonicalJson, sha256Hex } from "../src/canonical.js";

describe("canonicalJson", () => {
  it("trie les clés récursivement", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { d: 1, c: 2 }, a: [3, 2, 1] })).toBe('{"a":[3,2,1],"z":{"c":2,"d":1}}');
  });

  it("ne produit aucun espace", () => {
    const out = canonicalJson({ a: 1, b: "x", c: [1, 2] });
    expect(out).not.toContain(" ");
  });

  it("l'ordre des tableaux n'est jamais touché (sémantique, pas tri)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("deux objets JS avec un ordre d'insertion différent donnent le même JSON canonique", () => {
    const a = { to: "alice@example.com", subject: "x", cc: [] as string[] };
    const b = { subject: "x", cc: [] as string[], to: "alice@example.com" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

describe("sha256Hex / argsSha256", () => {
  it("hash connu (SHA-256 de la chaîne vide)", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("argsSha256 est stable pour des arguments équivalents (ordre de clés différent)", () => {
    const h1 = argsSha256({ to: "x", amount: 10 });
    const h2 = argsSha256({ amount: 10, to: "x" });
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it("argsSha256 change si un argument change (détecte une falsification — APPROVALS.md §2)", () => {
    const h1 = argsSha256({ amount: 10 });
    const h2 = argsSha256({ amount: 11 });
    expect(h1).not.toBe(h2);
  });
});
