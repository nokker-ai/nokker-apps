import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalTargetFull, ApprovalTargetLine } from "../src/approvals/TargetLine.js";
import { setShellLang } from "../src/i18n/index.js";

const face = (a: { tool_name: string; target?: unknown }): string => renderToStaticMarkup(createElement(ApprovalTargetLine, { approval: a }));
const full = (a: { target?: unknown }): string => renderToStaticMarkup(createElement(ApprovalTargetFull, { approval: a }));

describe("face d'une carte : ce qui va partir (target du noyau)", () => {
  it("AVEC target : une ligne monospace, « Will run » pour une commande, « Target » pour le reste, le texte tel quel", () => {
    setShellLang("en");
    const cmd = face({ tool_name: "terminal", target: "sh livrer.sh 2.1 && echo ok" });
    expect(cmd).toContain("data-approval-target");
    expect(cmd).toContain("Will run");
    expect(cmd).toContain("sh livrer.sh 2.1 &amp;&amp; echo ok");
    expect(cmd).toMatch(/<code class="mono"/);
    const other = face({ tool_name: "write_file", target: "src/app.py" });
    expect(other).toContain("Target");
    expect(other).not.toContain("Will run");
    setShellLang("fr");
    expect(face({ tool_name: "terminal", target: "ls" })).toContain("Va exécuter");
    expect(face({ tool_name: "write_file", target: "a.py" })).toContain("Cible");
    setShellLang(null);
  });
  it("SANS target : rien du tout (ni ligne, ni objet d'arguments), qu'il manque, soit vide ou ne soit pas du texte", () => {
    expect(face({ tool_name: "terminal" })).toBe("");
    expect(face({ tool_name: "terminal", target: "" })).toBe("");
    expect(face({ tool_name: "terminal", target: "   " })).toBe("");
    expect(face({ tool_name: "terminal", target: null })).toBe("");
    expect(face({ tool_name: "terminal", target: { command: "ls" } })).toBe("");
    expect(full({})).toBe("");
  });
  it("120 caractères visibles puis « … » sur la face, le texte ENTIER dans Détails ; rien en Détails si ça tient", () => {
    const long = "x".repeat(200);
    const f = face({ tool_name: "terminal", target: long });
    const shown = />([^<]*)<\/code>/.exec(f)![1]; // le texte VISIBLE (l'infobulle `title` garde le texte entier)
    expect(shown).toBe("x".repeat(120) + "…");
    expect(f).toContain(`title="${long}"`);
    expect(full({ target: long })).toContain(long);
    expect(full({ target: "court" })).toBe("");
    // jamais coupé au milieu d'un caractère (emoji)
    expect(face({ tool_name: "terminal", target: "\u{1F600}".repeat(150) })).not.toContain("�");
  });
  it("le texte du noyau est échappé (aucun balisage exécuté)", () => {
    expect(face({ tool_name: "terminal", target: "<img src=x onerror=alert(1)>" })).not.toContain("<img");
  });
});
