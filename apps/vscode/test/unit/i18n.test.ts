/**
 * Libellés : anglais par défaut, français par le paquet l10n de VS Code. Chaque `t("…")` du code a sa traduction,
 * chaque `%clé%` du manifeste existe en anglais et en français, et aucune chaîne française n'est écrite en dur.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { choiceLabel, costLang, editorTexts, effectLabel, english, formatMessage, fromBundle, strongText } from "../../src/i18n.js";

const root = join(__dirname, "..", "..");
const fr = JSON.parse(readFileSync(join(root, "l10n/bundle.l10n.fr.json"), "utf-8")) as Record<string, string>;
const T = fromBundle(fr);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}
/** Le code sans ses commentaires (lecture caractère par caractère : un `/*` dans une chaîne n'est pas un commentaire ;
 * les gabarits `${…}` imbriqués ne sont pas suivis, ce qui suffit ici). */
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
      // littéral d'expression régulière : recopié tel quel jusqu'au « / » de fin
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
const files = sources(join(root, "src")).map((p) => ({ p, code: withoutComments(readFileSync(p, "utf-8")) }));

describe("l10n", () => {
  it("chaque t(\"…\") du code a sa traduction française, et le paquet n'a pas de clé morte", () => {
    const keys = new Set<string>();
    for (const { code } of files) for (const m of code.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(JSON.parse(`"${m[1]}"`) as string);
    expect(keys.size).toBeGreaterThan(50);
    const missing = [...keys].filter((k) => !(k in fr));
    expect(missing).toEqual([]);
    const dead = Object.keys(fr).filter((k) => !keys.has(k));
    expect(dead).toEqual([]);
    // Mêmes marqueurs {n} des deux côtés.
    for (const [k, v] of Object.entries(fr)) expect((v.match(/\{\d+\}/g) ?? []).sort()).toEqual((k.match(/\{\d+\}/g) ?? []).sort());
  });

  it("aucune chaîne française écrite en dur dans le code (hors commentaires)", () => {
    const hits: string[] = [];
    for (const { p, code } of files) {
      for (const m of code.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
        if (/[àâçéèêëîïôûùüœ]/i.test(m[2]!)) hits.push(`${p.slice(root.length)}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("manifeste : chaque %clé% existe en anglais et en français", () => {
    const pkgText = readFileSync(join(root, "package.json"), "utf-8");
    const en = JSON.parse(readFileSync(join(root, "package.nls.json"), "utf-8")) as Record<string, string>;
    const frNls = JSON.parse(readFileSync(join(root, "package.nls.fr.json"), "utf-8")) as Record<string, string>;
    const used = new Set([...pkgText.matchAll(/"%([\w.]+)%"/g)].map((m) => m[1]!));
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((k) => !(k in en))).toEqual([]);
    expect(Object.keys(frNls).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(en).filter((k) => !used.has(k))).toEqual([]);
    expect(JSON.parse(pkgText).l10n).toBe("./l10n");
  });

  it("anglais par défaut, français si VS Code est en français", () => {
    expect(costLang("fr")).toBe("fr");
    expect(costLang("fr-CA")).toBe("fr");
    expect(costLang("en")).toBe("en");
    expect(costLang("de")).toBe("en");
    expect(formatMessage("a {0} b {1} {2}", ["x", 2])).toBe("a x b 2 {2}");
    expect(english("Restore failed: {0}", "boum")).toBe("Restore failed: boum");
    expect(T("Restore failed: {0}", "boum")).toBe("Retour impossible : boum");
  });

  it("choix des cartes et carte forte : mêmes choix que le SDK, texte de strongCardText", () => {
    expect(choiceLabel(english, { id: "once", key: "1" }, "terminal")).toBe("Once");
    expect(choiceLabel(T, { id: "session", key: "2" }, "terminal")).toBe("Pour cette session");
    expect(choiceLabel(english, { id: "always", key: "3b" }, "terminal")).toBe("Always commands starting with this prefix");
    expect(choiceLabel(T, { id: "always", key: "3" }, "patch")).toBe("Toujours ce fichier (règle)");
    expect(choiceLabel(english, { id: "reject", key: "4" }, "patch")).toBe("Reject");
    expect(strongText(english, { forwarded: true })).toBe("Strong action: it waits for your phone.");
    expect(strongText(T, { forwarded: false })).toBe("Action forte : à décider dans le terminal (`nokker`).");
    expect(strongText(T, {})).toBe("Action forte : à décider dans le terminal (`nokker`).");
    expect(effectLabel(T, "write")).toBe("écriture");
    expect(effectLabel(english, "send_external")).toBe("send");
    expect(editorTexts(english).subagentFinished("ok", 2)).toBe("Sub-agent finished (ok): 2 commit(s)");
    expect(editorTexts(T).rejected).toBe("Refusée : non exécutée.");
  });
});
