/**
 * Libellés : anglais par défaut, français par le catalogue. Chaque `t("…")` du code a sa traduction, le catalogue n'a pas
 * de clé morte, et aucune chaîne française n'est écrite en dur hors du catalogue (`src/i18n/fr*.ts`), ni dans une chaîne
 * ni dans un texte JSX.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { FR_OPS } from "../src/i18n/fr-ops.js";
import { FR, FR_SESSION } from "../src/i18n/fr.js";
import { detectLang, formatMessage, lang, parseLang, setLang, t } from "../src/i18n/index.js";

const root = join(__dirname, "..");
const FRENCH = /[àâçéèêëîïôûùüœ«»]/i;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}
const isCatalogue = (p: string): boolean => /[\\/]src[\\/]i18n[\\/]fr(-[\w-]+)?\.ts$/.test(p);

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

const files = sources(join(root, "src"))
  .filter((p) => !isCatalogue(p))
  .map((p) => ({ p: relative(root, p), code: withoutComments(readFileSync(p, "utf-8")) }));

afterEach(() => setLang("en"));

describe("catalogue", () => {
  it("chaque t(\"…\") a sa traduction française, aucune clé morte, mêmes marqueurs {n}", () => {
    const keys = new Set<string>();
    for (const { code } of files) for (const m of code.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(JSON.parse(`"${m[1]}"`) as string);
    expect(keys.size).toBeGreaterThan(150);
    expect([...keys].filter((k) => !(k in FR))).toEqual([]);
    expect(Object.keys(FR).filter((k) => !keys.has(k))).toEqual([]);
    for (const [k, v] of Object.entries(FR)) expect([k, (v.match(/\{\d+\}/g) ?? []).sort()]).toEqual([k, (k.match(/\{\d+\}/g) ?? []).sort()]);
    // Une clé est un littéral : jamais t(`…`) ni t(variable) (le test ne pourrait pas la relever).
    const dynamic = files.flatMap(({ p, code }) => [...code.matchAll(/(?<!function )\bt\(\s*([^"\s)])/g)].map((m) => `${p}: t(${m[1]}`));
    expect(dynamic).toEqual([]);
    // Les deux parties du catalogue ne se marchent pas dessus.
    expect(Object.keys(FR_OPS).filter((k) => k in FR_SESSION)).toEqual([]);
  });

  it("aucune chaîne française écrite en dur hors du catalogue (chaînes et texte JSX, hors commentaires)", () => {
    const hits: string[] = [];
    for (const { p, code } of files) {
      for (const m of code.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) if (FRENCH.test(m[2]!)) hits.push(`${p}: ${m[0]}`);
      if (p.endsWith(".tsx")) for (const m of code.matchAll(/>([^<>{}]*)</g)) if (FRENCH.test(m[1]!)) hits.push(`${p}: >${m[1]!.trim()}<`);
    }
    expect(hits).toEqual([]);
  });
});

describe("langue", () => {
  it("anglais par défaut ; français si NOKKER_LANG, LC_ALL, LC_MESSAGES ou LANG commence par fr (premier non vide)", () => {
    expect(detectLang({})).toBe("en");
    expect(detectLang({ LANG: "C.UTF-8" })).toBe("en");
    expect(detectLang({ LANG: "fr_CH.UTF-8" })).toBe("fr");
    expect(detectLang({ LANG: "fr_FR.UTF-8", LC_ALL: "en_US.UTF-8" })).toBe("en");
    expect(detectLang({ LC_ALL: "", LC_MESSAGES: "fr_BE.UTF-8", LANG: "en_GB.UTF-8" })).toBe("fr");
    expect(detectLang({ NOKKER_LANG: "en", LC_ALL: "fr_FR.UTF-8" })).toBe("en");
    expect(detectLang({ NOKKER_LANG: "fr" })).toBe("fr");
    expect(parseLang("fr_CH")).toBe("fr");
    expect(parseLang("EN")).toBe("en");
    expect(parseLang("de")).toBeNull();
  });

  it("t() : source anglaise, traduction française, marqueurs", () => {
    setLang("en");
    expect(lang()).toBe("en");
    expect(t("Once")).toBe("Once");
    setLang("fr");
    expect(t("Once")).toBe("Une fois");
    expect(formatMessage("a {0} b {1} {2}", ["x", 2])).toBe("a x b 2 {2}");
  });
});

describe("lignes d'outils, carte, coût, aide en anglais", () => {
  it("rendu anglais par défaut, français sur demande", async () => {
    const { formatToolLine } = await import("../src/toolview.js");
    const { choiceLabel, decisionSummary, effectLabel, strongText } = await import("../src/approval-model.js");
    const { turnCostLine } = await import("../src/cost.js");
    const { helpText } = await import("../src/commands.js");
    const line = { callId: "c", name: "patch", args: { path: "src/app.py" }, effect: "write" as const, ok: null, ms: null, preview: null, depth: 0 };
    const card = { tool_name: "terminal", arguments: { command: "pytest -q" } } as never;
    setLang("en");
    expect(formatToolLine(line)).toBe("⟳ patch src/app.py (write)");
    expect(formatToolLine({ ...line, approvalId: "a1" })).toBe("⏸ patch src/app.py (waiting for approval)");
    expect(effectLabel("destructive")).toBe("destructive");
    expect(choiceLabel({ id: "always", key: "3b" }, "terminal")).toBe("Always commands starting with this prefix");
    expect(decisionSummary(card, "approved", "session")).toBe("✓ Approved (for this session): terminal pytest -q");
    expect(strongText({ forwarded: true })).toBe("Strong action: it waits for your phone.");
    expect(turnCostLine({ total_tokens: 12_400, cost: { EUR: 0.0312 } })).toBe("12.4k tokens · €0.03");
    expect(helpText().split("\n")[0]).toBe("Commands:");
    setLang("fr");
    expect(formatToolLine(line)).toBe("⟳ patch src/app.py (écriture)");
    expect(decisionSummary(card, "expired")).toBe("⌛ Approbation expirée — refusée : terminal pytest -q");
    expect(turnCostLine({ total_tokens: 12_400, cost: { EUR: 0.0312 } })).toBe("12,4 k jetons · 0,03 €");
    expect(helpText()).toContain("/memory forget <note>");
  });
});
