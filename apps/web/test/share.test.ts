import { describe, expect, it } from "vitest";
import { clearShare, pendingShares, sharePrefill, shareTitle, type SharedBatch } from "../src/platform/share.js";
import { NATIVE_PLUGINS } from "../src/platform/plugins.js";

const b = (items: SharedBatch["items"]): SharedBatch => ({ id: "s1", created_at: "2026-11-06T02:00:00Z", items });
const img = "data:image/jpeg;base64," + "A".repeat(400);

describe("Partager vers Nokker (P5a)", () => {
  it("titre : le PDF, l'hôte de l'adresse, la première ligne du texte, sinon le repli", () => {
    expect(shareTitle(b([{ kind: "pdf", name: "Facture octobre.pdf", text: "…" }]), "Partage")).toBe("Facture octobre");
    expect(shareTitle(b([{ kind: "url", url: "https://www.example.org/a/b" }]), "Partage")).toBe("example.org");
    expect(shareTitle(b([{ kind: "text", text: "Liste de courses\nlait" }]), "Partage")).toBe("Liste de courses");
    expect(shareTitle(b([{ kind: "text", text: "x".repeat(90) }]), "Partage")).toHaveLength(60);
    expect(shareTitle(b([{ kind: "image", data_url: img }]), "Partage")).toBe("Partage");
  });
  it("composeur : texte et adresse à la suite, texte du PDF sous son nom, 4 images au plus, rien d'autre", () => {
    const p = sharePrefill(
      b([
        { kind: "text", text: "  à lire  " },
        { kind: "url", url: "https://example.org" },
        { kind: "pdf", name: "doc.pdf", text: "Contenu du PDF" },
        ...Array.from({ length: 5 }, () => ({ kind: "image" as const, data_url: img })),
        { kind: "image", data_url: "javascript:alert(1)" },
      ]),
      (n) => `Document partagé : ${n}`,
    );
    expect(p.key).toBe("s1");
    expect(p.text).toBe("à lire\n\nhttps://example.org\n\nDocument partagé : doc.pdf\n\nContenu du PDF");
    expect(p.images).toHaveLength(4);
    expect(p.images.every((i) => i.dataUrl.startsWith("data:image/jpeg"))).toBe(true);
  });
  it("hors de l'app : aucune boîte ; dans l'app : le plugin NokkerShare, enregistré avec les autres", async () => {
    expect(await pendingShares({})).toEqual([]);
    const cleared: string[] = [];
    const w = { Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios", Plugins: { NokkerShare: { pending: async () => ({ shares: [b([{ kind: "text", text: "x" }])] }), clear: async ({ id }: { id: string }) => void cleared.push(id) } } } };
    expect((await pendingShares(w)).map((s) => s.id)).toEqual(["s1"]);
    await clearShare("s1", w);
    expect(cleared).toEqual(["s1"]);
    expect(NATIVE_PLUGINS).toContain("NokkerShare");
  });
});
