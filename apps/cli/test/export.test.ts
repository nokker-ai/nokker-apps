import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thread, ThreadMessage, ThreadView } from "@nokker-apps/sdk";
import { defaultExportName, escapeHtml, exportThread, fetchWholeThread, renderHtml, renderMarkdown, type ThreadSource } from "../src/export.js";
import { parseSlashCommand } from "../src/commands.js";
import { setLang } from "../src/i18n/index.js";

const thread = { id: "th_abcdef123456", title: "Fix <b>bug</b> & co", owner: "u", members: [], created_at: "", updated_at: "", working: false, unread: 0, bubble_count: 0, last_snippet: "" } as Thread;
const NOW = new Date("2026-11-02T10:00:00.000Z");

/** Fil de `n` tours, servi comme le noyau : `limit` derniers tours avant `before`. */
function fakeSource(n: number): ThreadSource & { calls: Array<{ before?: number; limit?: number }> } {
  const all: ThreadMessage[] = [];
  for (let i = 0; i < n; i++) {
    all.push({ index: i, role: "user", content: `q${i}` }, { index: i, role: "assistant", content: `a${i}` });
  }
  const calls: Array<{ before?: number; limit?: number }> = [];
  return {
    calls,
    async getThread(_id, opts = {}): Promise<ThreadView> {
      calls.push(opts);
      const lim = opts.limit ?? 50;
      const turns = all.filter((m) => opts.before === undefined || m.index < opts.before).map((m) => m.index);
      const keep = new Set([...new Set(turns)].slice(-lim));
      return { thread, messages: all.filter((m) => keep.has(m.index)), bubbles: [] };
    },
  };
}

const dirs: string[] = [];
afterEach(() => {
  setLang("en");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("/export : parseur", () => {
  it("format, fichier, extension, guillemets", () => {
    expect(parseSlashCommand("/export")).toEqual({ kind: "export", format: "md", file: null });
    expect(parseSlashCommand("/export html")).toEqual({ kind: "export", format: "html", file: null });
    expect(parseSlashCommand("/export md out.md")).toEqual({ kind: "export", format: "md", file: "out.md" });
    expect(parseSlashCommand("/export out.html")).toEqual({ kind: "export", format: "html", file: "out.html" });
    expect(parseSlashCommand('/export html "my dir/a b.html"')).toEqual({ kind: "export", format: "html", file: "my dir/a b.html" });
  });
});

describe("fetchWholeThread : pagination par before", () => {
  it("450 tours en 200 + 200 + 50, dans l'ordre, sans doublon", async () => {
    const src = fakeSource(450);
    const { messages } = await fetchWholeThread(src, thread.id);
    expect(src.calls).toEqual([{ limit: 200 }, { limit: 200, before: 250 }, { limit: 200, before: 50 }]);
    expect(messages).toHaveLength(900);
    expect(messages[0]).toMatchObject({ index: 0, role: "user", content: "q0" });
    expect(messages[1]).toMatchObject({ index: 0, role: "assistant" });
    expect(messages.at(-1)).toMatchObject({ index: 449, role: "assistant", content: "a449" });
    expect(new Set(messages.map((m) => `${m.index}:${m.role}`)).size).toBe(900);
  });

  it("une seule page quand le fil est court ; un fil vide ne boucle pas", async () => {
    const a = fakeSource(3);
    expect((await fetchWholeThread(a, thread.id)).messages).toHaveLength(6);
    expect(a.calls).toHaveLength(1);
    const e = fakeSource(0);
    expect((await fetchWholeThread(e, thread.id)).messages).toEqual([]);
    expect(e.calls).toHaveLength(1);
  });

  it("exactement 200 tours : une page de plus (vide) puis fin", async () => {
    const src = fakeSource(200);
    const { messages } = await fetchWholeThread(src, thread.id);
    expect(messages).toHaveLength(400);
    expect(src.calls).toEqual([{ limit: 200 }, { limit: 200, before: 0 }]);
  });
});

describe("rendu", () => {
  const msgs: ThreadMessage[] = [
    { index: 0, role: "user", content: "look <script>alert(1)</script> & \"x\"", images: [{ sha256: "deadbeef00", media_type: "image/png", size: 1, name: "shot.png" }, { sha256: "cafebabe99", media_type: "image/jpeg", size: 1 }] },
    { index: 0, role: "assistant", content: "ok **done**" },
  ];

  it("Markdown : titre, cwd, date, avertissement outils, images par nom", () => {
    const md = renderMarkdown(thread, msgs, { cwd: "/work/repo", exportedAt: NOW });
    expect(md).toMatch(/^# Fix <b>bug<\/b> & co\n/);
    expect(md).toContain("- Working folder: /work/repo");
    expect(md).toContain("- Exported: 2026-11-02T10:00:00.000Z");
    expect(md).toContain("Tool calls are not included");
    expect(md).toContain("## You");
    expect(md).toContain("## Assistant");
    expect(md).toContain("_Image: shot.png_");
    expect(md).toContain("_Image: cafebabe.jpeg_");
    expect(md).toContain("ok **done**");
  });

  it("Markdown en français par le catalogue", () => {
    setLang("fr");
    const md = renderMarkdown(thread, msgs, { cwd: null, exportedAt: NOW });
    expect(md).toContain("## Toi");
    expect(md).toContain("Les appels d'outils ne sont pas inclus");
    expect(md).not.toContain("Working folder");
  });

  it("HTML : autonome, tout le texte échappé, styles inline, pas de script", () => {
    const html = renderHtml(thread, msgs, { cwd: "/w/<x>", exportedAt: NOW });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Fix &lt;b&gt;bug&lt;/b&gt; &amp; co</title>");
    expect(html).toContain("look &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;");
    expect(html).toContain("/w/&lt;x&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<link|<style|src=|href=/);
    expect(html).toContain("Image: shot.png");
  });

  it("escapeHtml", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});

describe("exportThread : écriture du fichier", () => {
  it("nom par défaut dans le dossier de base, puis nom explicite relatif", async () => {
    const base = mkdtempSync(join(tmpdir(), "nokker-export-"));
    dirs.push(base);
    const src = fakeSource(2);
    expect(defaultExportName(thread.id, "md", NOW)).toBe("nokker-session-abcdef12-2026-11-02.md");
    const a = await exportThread(src, thread.id, { format: "md", file: null, base, cwd: base, now: NOW });
    expect(a).toEqual({ path: join(base, "nokker-session-abcdef12-2026-11-02.md"), turns: 2 });
    expect(readFileSync(a.path, "utf8")).toContain("a1");
    const b = await exportThread(src, thread.id, { format: "html", file: "out.html", base, cwd: null, now: NOW });
    expect(b.path).toBe(join(base, "out.html"));
    expect(readFileSync(b.path, "utf8")).toContain("<!doctype html>");
  });
});

describe("exportThread contre le mock-server (vrai getThread HTTP)", () => {
  it("deux tours envoyés par la session, puis exportés en Markdown", async () => {
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { NokkerClient } = await import("@nokker-apps/sdk");
    const { startMockServer } = await import("@nokker-apps/mock-server");
    const { login } = await import("../src/auth.js");
    const { CliSession } = await import("../src/session.js");
    const dir = await mkdtemp(join(tmpdir(), "nokker-export-mock-"));
    const keep = process.env.NOKKER_CONFIG_DIR_OVERRIDE;
    process.env.NOKKER_CONFIG_DIR_OVERRIDE = dir;
    const mock = await startMockServer({ port: 0 });
    try {
      const client = new NokkerClient({ baseUrl: mock.url });
      const tok = await login(client, "export-device");
      const session = new CliSession(client, null, undefined, tok.user);
      await session.sendMessage("first question", () => undefined);
      await session.sendMessage("second question", () => undefined);
      const r = await exportThread(client, session.threadId, { format: "md", file: join(dir, "t.md"), base: dir, cwd: null, now: NOW });
      expect(r.turns).toBe(2);
      const md = await readFile(r.path, "utf8");
      expect(md.indexOf("first question")).toBeGreaterThan(0);
      expect(md.indexOf("second question")).toBeGreaterThan(md.indexOf("first question"));
    } finally {
      await mock.close();
      if (keep === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
      else process.env.NOKKER_CONFIG_DIR_OVERRIDE = keep;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
