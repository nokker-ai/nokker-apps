/**
 * Coque du web : anglais source (`tr("…")`, `trIn(lang, "…")`), français par le catalogue `src/i18n/fr*.ts`. Chaque clé
 * du code a sa traduction, le catalogue n'a pas de clé morte, les marqueurs `{n}` concordent, et aucune chaîne française
 * n'est écrite en dur hors du catalogue et des dictionnaires FR/EN propres à un écran (liste `DICTIONARIES`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { FR } from "../src/i18n/fr.js";
import { formatMessage, setShellLang, shellLang, tr, trIn } from "../src/i18n/index.js";

const root = join(__dirname, "..");
const FRENCH = /[àâçéèêëîïôûùüœ«»]/i;

/** Écrans qui portent déjà leurs propres tables FR/EN (le français y est à sa place). */
const DICTIONARIES = new Set(["src/onboarding/i18n.ts", "src/household/model.ts", "src/crew/i18n.ts", "src/crew/mail.ts", "src/crew/model.ts", "src/code/model.ts", "src/sso/text.ts", "src/approvals/remote.ts"]);
/** Textes du noyau que le web compare tels quels (jamais affichés par lui) : la ligne qui les porte est permise. */
const KERNEL_TEXT = ["|Message de la session|Réponse de la session|Relevé)/", "aucune relève du courrier", "aucune boîte mail reliée"];
/** Exceptions temporaires, à retirer quand le fichier est traduit (HouseholdTab : après le lot du foyer en attente). */
const PENDING = new Set(["src/household/HouseholdTab.tsx"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}
const isCatalogue = (p: string): boolean => /^src[\\/]i18n[\\/]fr(-[\w-]+)?\.ts$/.test(p);

/** Le code sans ses commentaires (lecture caractère par caractère : un `//` dans une chaîne n'est pas un commentaire ;
 * les littéraux d'expression régulière sont recopiés tels quels). */
function withoutComments(code: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (quote) {
      out += c;
      if (c === "\\") out += code[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && /[=(,:!&|?{};\n]\s*$/.test(out)) {
      let j = i + 1;
      let cls = false;
      while (j < code.length && (code[j] !== "/" || cls) && code[j] !== "\n") {
        if (code[j] === "\\") j++;
        else if (code[j] === "[") cls = true;
        else if (code[j] === "]") cls = false;
        j++;
      }
      out += code.slice(i, j + 1);
      i = j;
      continue;
    }
    out += c;
  }
  return out;
}

const all = sources(join(root, "src")).map((p) => ({ p: relative(root, p).split("\\").join("/"), code: withoutComments(readFileSync(p, "utf-8")) }));
const files = all.filter((f) => !isCatalogue(f.p) && f.p !== "src/i18n/index.ts");

afterEach(() => setShellLang(null));

/** Clés littérales de `tr("…")` et `trIn(x, "…")`. */
function keysOf(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\btr\(\s*"((?:[^"\\]|\\.)*)"/g)) out.push(JSON.parse(`"${m[1]}"`) as string);
  for (const m of code.matchAll(/\btrIn\(\s*[^,()]+,\s*"((?:[^"\\]|\\.)*)"/g)) out.push(JSON.parse(`"${m[1]}"`) as string);
  return out;
}
const markers = (s: string): string => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join(",");

describe("catalogue de la coque", () => {
  it("chaque tr(\"…\") a sa traduction française, aucune clé morte, mêmes marqueurs {n}, clés littérales", () => {
    const used = new Set(files.flatMap((f) => keysOf(f.code)));
    const missing = [...used].filter((k) => !(k in FR));
    expect(missing).toEqual([]);
    const dead = Object.keys(FR).filter((k) => !used.has(k));
    expect(dead).toEqual([]);
    const badMarkers = Object.entries(FR).filter(([k, v]) => markers(k) !== markers(v)).map(([k]) => k);
    expect(badMarkers).toEqual([]);
    const nonLiteral = files.filter((f) => /\btr\(\s*[^"\s)]/.test(f.code) || /\btrIn\(\s*[^,()]+,\s*[^"\s]/.test(f.code)).map((f) => f.p);
    expect(nonLiteral).toEqual([]);
  });

  it("aucune chaîne française écrite en dur hors du catalogue et des dictionnaires (chaînes et texte JSX, hors commentaires)", () => {
    const offenders = files
      .filter((f) => !DICTIONARIES.has(f.p) && !PENDING.has(f.p))
      .flatMap((f) => f.code.split("\n").map((line, i) => ({ f: f.p, i: i + 1, line })))
      .filter((l) => FRENCH.test(l.line) && !KERNEL_TEXT.some((k) => l.line.includes(k)))
      .map((l) => `${l.f}:${l.i}: ${l.line.trim().slice(0, 120)}`);
    expect(offenders).toEqual([]);
  });
});

describe("langue de la coque", () => {
  it("suit la langue de l'interface ; tr et trIn traduisent, marqueurs remplacés", () => {
    setShellLang("en");
    expect(shellLang()).toBe("en");
    setShellLang("fr");
    expect(shellLang()).toBe("fr");
    expect(formatMessage("{0} of {1}", [1, 2])).toBe("1 of 2");
    const [k, v] = Object.entries(FR)[0] ?? ["", ""];
    if (k) {
      expect(trIn("en", k)).toBe(formatMessage(k, []));
      expect(trIn("fr", k)).toBe(formatMessage(v, []));
      expect(tr(k)).toBe(formatMessage(v, []));
    }
    expect(trIn("fr", "untranslated source")).toBe("untranslated source");
  });
});
