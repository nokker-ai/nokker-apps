import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contentSecurityPolicy, escapeHtml, panelHtml } from "../../src/html.js";
import { parseInline, parseMarkdown } from "../../src/webview/markdown.js";
import { composeMessage, contextBlock, contextLabel, relativeTo, type SelectionContext } from "../../src/context.js";
import { english, fromBundle, webviewStrings } from "../../src/i18n.js";

const root = join(__dirname, "..", "..");

describe("page du panneau : CSP stricte", () => {
  const html = panelHtml({
    cspSource: "vscode-webview://x",
    nonce: "abc123",
    scriptUri: "vscode-webview://x/dist/webview.js",
    styleUri: "vscode-webview://x/media/chat.css",
    strings: webviewStrings(english),
    lang: "en",
  });
  it("rien de distant, un seul script à nonce, pas de style ni de script en ligne", () => {
    const csp = contentSecurityPolicy("vscode-webview://x", "abc123");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-abc123'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
    expect(html).toContain(`content="${csp}"`);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('<script nonce="abc123" src=');
    expect(html).not.toMatch(/<style|\sstyle="|\son\w+="/);
    expect(html).not.toMatch(/https?:\/\//);
  });
  it("libellés traduits passés dans data-strings, échappés (aucun HTML injecté par une traduction)", () => {
    expect(html).toContain('placeholder="Ask Nokker… (Enter sends, Shift+Enter adds a line)"');
    expect(html).toContain(">Send</button>");
    const fr = JSON.parse(readFileSync(join(root, "l10n/bundle.l10n.fr.json"), "utf-8")) as Record<string, string>;
    const htmlFr = panelHtml({ cspSource: "c", nonce: "n", scriptUri: "s", styleUri: "y", strings: webviewStrings(fromBundle(fr)), lang: "fr" });
    expect(htmlFr).toContain('<html lang="fr">');
    expect(htmlFr).toContain(">Envoyer</button>");
    const evil = panelHtml({ cspSource: "c", nonce: "n", scriptUri: "s", styleUri: "y", strings: { send: '"><script>x</script>' }, lang: "en" });
    expect(evil.match(/<script/g)).toHaveLength(1);
    expect(escapeHtml(`<a href="x">'`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;");
  });
  it("les fichiers du paquet n'appellent rien de distant", () => {
    const css = readFileSync(join(root, "media/chat.css"), "utf-8");
    expect(css).not.toMatch(/url\(|@import|https?:/);
    const main = readFileSync(join(root, "src/webview/main.ts"), "utf-8");
    expect(main).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|\bfetch\(|XMLHttpRequest|WebSocket|\beval\(/);
  });
});

describe("markdown du panneau (arbre, jamais du HTML)", () => {
  it("code, listes, citations, en ligne", () => {
    const b = parseMarkdown("Voici :\n\n```py\nx = 1\n```\n- `a` puis **b**\n- _c_\n> note");
    expect(b.map((x) => x.kind)).toEqual(["p", "code", "list", "quote"]);
    expect(b[1]).toEqual({ kind: "code", lang: "py", text: "x = 1" });
    expect(parseInline("un `code` et **gras**").map((i) => i.kind)).toEqual(["text", "code", "text", "strong"]);
    expect(parseMarkdown("<img src=x onerror=alert(1)>")[0]).toEqual({ kind: "p", inlines: [{ kind: "text", text: "<img src=x onerror=alert(1)>" }] });
  });
});

describe("envoyer la sélection", () => {
  const c: SelectionContext = { kind: "selection", id: "1", relPath: "src/app.py", startLine: 3, endLine: 5, languageId: "python", text: "a\n```\nb" };
  it("fichier + lignes en tête du message, bloc de code qui ne se ferme pas trop tôt", () => {
    expect(contextLabel(c)).toBe("src/app.py:3-5");
    expect(contextLabel({ ...c, endLine: 3 })).toBe("src/app.py:3");
    expect(contextBlock(c)).toBe("Context: `src/app.py`, lines 3-5:\n````python\na\n```\nb\n````");
    const fr = JSON.parse(readFileSync(join(root, "l10n/bundle.l10n.fr.json"), "utf-8")) as Record<string, string>;
    expect(contextBlock(c, fromBundle(fr))).toBe("Contexte : `src/app.py`, lignes 3-5 :\n````python\na\n```\nb\n````");
    expect(composeMessage("explique", [c]).text.endsWith("\n\nexplique")).toBe(true);
    expect(composeMessage("seul", [])).toEqual({ text: "seul", attachments: [] });
  });
  it("chemin relatif au dossier, null hors du dossier", () => {
    expect(relativeTo("/home/alice/calc", "/home/alice/calc/src/a.py")).toBe("src/a.py");
    expect(relativeTo("C:\\u\\calc", "C:\\u\\calc\\src\\a.py")).toBe("src/a.py");
    expect(relativeTo("/home/alice/calc", "/home/alice/calcul/a.py")).toBeNull();
  });
});

describe("manifeste", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  it("aucun secret dans les réglages : l'adresse du noyau (portée machine, non synchronisée) et un booléen", () => {
    const props = pkg.contributes.configuration.properties;
    expect(Object.keys(props)).toEqual(["nokker.serverUrl", "nokker.liveWrite.openEditor"]);
    expect(props["nokker.serverUrl"].scope).toBe("machine");
    expect(props["nokker.liveWrite.openEditor"].type).toBe("boolean");
  });
  it("commandes et vues déclarées ; dossier de confiance exigé", () => {
    const cmds = pkg.contributes.commands.map((c: { command: string }) => c.command);
    for (const c of ["nokker.sendSelection", "nokker.addFile", "nokker.addProblems", "nokker.fixProblems", "nokker.addTerminalOutput", "nokker.newThread", "nokker.cancel", "nokker.reconnect", "nokker.refreshSessions", "nokker.openSession", "nokker.review.accept", "nokker.review.refuse", "nokker.review.acceptAll", "nokker.review.openDiff", "nokker.openLive"]) {
      expect(cmds).toContain(c);
    }
    expect(pkg.contributes.views.nokker.map((v: { id: string }) => v.id)).toEqual(["nokker.chat", "nokker.changes", "nokker.sessions"]);
    expect(pkg.contributes.views.nokker[0]).toMatchObject({ type: "webview", id: "nokker.chat" });
    expect(pkg.capabilities.untrustedWorkspaces.supported).toBe(false);
  });
});
