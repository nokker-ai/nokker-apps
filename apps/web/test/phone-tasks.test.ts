import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { PhoneTaskNote } from "@nokker-apps/sdk";
import { PhoneTaskNotes, phoneNameShort, phoneOpLabel, phoneTaskText } from "../src/components/PhoneFetch.js";
import { setShellLang } from "../src/i18n/index.js";

afterEach(() => setShellLang(null));
const NB = " ";
const note = (status: PhoneTaskNote["status"], op = "ocr.image", name = "iPhone de Léa"): PhoneTaskNote => ({ task_id: `tk_${status}`, op, machine_id: "mc_ph_1", name, status });
const STATUSES = ["pending", "done", "failed", "expired", "cancelled"] as const;

// Textes figés à la relecture des textes le 06.11 (bulle phone_task), mot pour mot ; espaces ordinaires, comme le reste du catalogue.
const FROZEN = [
  `Texte d'une image${NB}: demande envoyée à ton téléphone «${NB}iPhone de Léa${NB}»…`,
  `Texte d'une image${NB}: résultat reçu de ton téléphone «${NB}iPhone de Léa${NB}»`,
  `Texte d'une image${NB}: n'a pas abouti sur ton téléphone «${NB}iPhone de Léa${NB}»`,
  `Texte d'une image${NB}: ton téléphone «${NB}iPhone de Léa${NB}» n'a pas répondu à temps`,
  `Texte d'une image${NB}: demande annulée`,
];

describe("bulle phone_task (P7b, textes figés à la relecture)", () => {
  it("les cinq états, mot pour mot, et leur empreinte", () => {
    setShellLang("fr");
    const got = STATUSES.map((s) => phoneTaskText(note(s)));
    expect(got).toEqual(FROZEN);
    expect(createHash("sha256").update(got.join("\n")).digest("hex")).toBe(createHash("sha256").update(FROZEN.join("\n")).digest("hex"));
    // Aucune espace insécable (relecture des textes : la cohérence avec le catalogue l'emporte).
    for (const t of got) expect(t).not.toMatch(/[\u00a0\u202f]/);
  });
  it("opérations avec majuscule et accent ; une opération inconnue garde son nom", () => {
    setShellLang("fr");
    expect([phoneOpLabel("zone.state"), phoneOpLabel("ocr.image"), phoneOpLabel("calendar.list"), phoneOpLabel("x.y")]).toEqual(["État de zone", "Texte d'une image", "Agenda", "x.y"]);
    expect(phoneTaskText(note("done", "calendar.list"))).toBe(`Agenda${NB}: résultat reçu de ton téléphone «${NB}iPhone de Léa${NB}»`);
  });
  it("nom : espaces normalisés, coupé à 40 caractères avec « … »", () => {
    expect(phoneNameShort("  iPad   de\tla  cuisine ")).toBe("iPad de la cuisine");
    const long = "Téléphone de démonstration avec un nom vraiment très long";
    expect(phoneNameShort(long)).toBe(`${long.slice(0, 40)}…`);
    expect(phoneNameShort("x".repeat(40))).toBe("x".repeat(40));
  });
  it("rendu : un paragraphe par tâche, état en attribut", () => {
    setShellLang("en");
    const out = renderToStaticMarkup(createElement(PhoneTaskNotes, { items: STATUSES.map((s) => note(s)) }));
    expect(out.match(/data-phone-task="/g)).toHaveLength(5);
    expect(out).toContain("Text from an image: request sent to your phone iPhone de Léa…");
  });
});
