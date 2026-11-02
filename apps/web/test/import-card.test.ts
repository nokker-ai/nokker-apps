import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyButton, ImportCard } from "../src/onboarding/ImportCard.js";

describe("ImportCard", () => {
  it("names each copy button after what it copies (FR and EN typography)", () => {
    expect(renderToStaticMarkup(createElement(CopyButton, { text: "nokker import cursor", lang: "en" }))).toContain('aria-label="Copy: nokker import cursor"');
    expect(renderToStaticMarkup(createElement(CopyButton, { text: "nokker import cursor", lang: "fr" }))).toContain('aria-label="Copier : nokker import cursor"');
  });
  it("starts with the five sources (Codex included), none chosen, and no Import button before a scan", () => {
    const html = renderToStaticMarkup(createElement(ImportCard, { client: {} as never, lang: "en" }));
    expect(html.match(/aria-pressed="false"/g)?.length).toBe(5);
    expect(html).toContain(">Codex<");
    expect(html).not.toContain("imp-check");
    expect(html).not.toContain(">Import<");
  });
});
