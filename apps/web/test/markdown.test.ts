import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/Markdown.js";

const md = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }));

describe("Markdown — tableaux GFM", () => {
  it("rend en-tête, alignements et lignes dans une boîte qui défile", () => {
    const html = md("Voici :\n| Composant | Puissance | Rôle |\n| :--- | ---: | :---: |\n| **Pile H₂** | 7 kW | moyenne |\n| Batterie | 15 kW |\nFin.");
    expect(html).toContain('<div class="md-table"><table>');
    expect(html).toContain("<th>Composant</th>");
    expect(html).toContain('<th style="text-align:right">Puissance</th>');
    expect(html).toContain('<td><strong>Pile H₂</strong></td>');
    expect(html).toContain('<td style="text-align:center"></td>'); // cellule manquante : vide, pas de colonne perdue
    expect(html).toContain("<div>Fin.</div>");
    expect(html).not.toContain(":---");
  });

  it("une ligne avec une barre sans ligne de tirets reste du texte", () => {
    expect(md("a | b\nc")).toBe("<div>a | b</div><div>c</div>");
  });
});
