import { describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { codeFromSearch, formatCode, isCompleteCode, keyForIssue, linkIssue, minutesLeft, rememberLinkReturn, takeLinkReturn } from "../src/link/code.js";
import { t } from "../src/onboarding/i18n.js";

const mem = (): { data: Map<string, string> } & Pick<Storage, "getItem" | "setItem" | "removeItem"> => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};

describe("saisie du code XXXX-XXXX", () => {
  it("majuscules, tiret automatique, huit caractères au plus", () => {
    expect(formatCode("abcd")).toBe("ABCD");
    expect(formatCode("abcde")).toBe("ABCD-E");
    expect(formatCode("ab cd-ef 2 3 9 9")).toBe("ABCD-EF23");
    expect(formatCode("")).toBe("");
  });

  it("un code collé avec tiret ou espaces est normalisé", () => {
    expect(formatCode(" bcdf-g2h3 ")).toBe("BCDF-G2H3");
    expect(isCompleteCode(formatCode("bcdfg2h3"))).toBe(true);
    expect(isCompleteCode("BCDF-G2H")).toBe(false);
  });

  it("?code= de l'adresse : code complet seulement", () => {
    expect(codeFromSearch("?code=bcdf-g2h3")).toBe("BCDF-G2H3");
    expect(codeFromSearch("?code=BCDF")).toBe("");
    expect(codeFromSearch("")).toBe("");
  });
});

describe("erreurs de la page", () => {
  const err = (status: number) => new NokkerApiError("x", status, undefined);
  it("401 session, 404 code inconnu/expiré, 429 trop d'essais, réseau", () => {
    expect(linkIssue(err(401))).toBe("unauthorized");
    expect(linkIssue(err(404))).toBe("unknown");
    expect(linkIssue(err(429))).toBe("rate");
    expect(linkIssue(err(500))).toBe("other");
    expect(linkIssue(new TypeError("fetch failed"))).toBe("network");
  });

  it("chaque cas a un message dans les deux langues", () => {
    for (const i of ["unauthorized", "unknown", "rate", "network", "other"] as const) {
      expect(t("fr", keyForIssue(i)).length).toBeGreaterThan(5);
      expect(t("en", keyForIssue(i)).length).toBeGreaterThan(5);
    }
  });

  it("minutes annoncées : arrondi au-dessus, jamais zéro", () => {
    expect(minutesLeft(0)).toBe(1);
    expect(minutesLeft(61)).toBe(2);
    expect(minutesLeft(600)).toBe(10);
  });
});

describe("retour de connexion", () => {
  it("le détour Google garde l'adresse /link?code=… une seule fois", () => {
    const s = mem();
    rememberLinkReturn("BCDF-G2H3", s);
    expect(takeLinkReturn(s)).toBe("/link?code=BCDF-G2H3");
    expect(takeLinkReturn(s)).toBeNull();
  });

  it("une valeur étrangère n'est jamais suivie (pas de redirection ouverte)", () => {
    const s = mem();
    s.setItem("nokker.link.return", "https://evil.example/");
    expect(takeLinkReturn(s)).toBeNull();
  });
});
