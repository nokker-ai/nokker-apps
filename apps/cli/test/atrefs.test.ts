import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeAtRef, expandAtRefs, findAtTokens, MAX_DIR_ENTRIES, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from "../src/atrefs.js";
import { parseSlashCommand } from "../src/commands.js";
import { setLang } from "../src/i18n/index.js";

let root: string;
let outside: string;

beforeAll(async () => {
  setLang("en");
  const base = await mkdtemp(join(tmpdir(), "nokker-atrefs-"));
  root = join(base, "repo");
  outside = join(base, "secret.txt");
  await mkdir(join(root, "src", "deep", "deeper"), { recursive: true });
  await mkdir(join(root, "proj", ".git"), { recursive: true });
  await mkdir(join(root, "proj", "node_modules", "x"), { recursive: true });
  await mkdir(join(root, "proj", "src", "deep"), { recursive: true });
  await writeFile(join(root, "proj", "src", "a.ts"), "a");
  await writeFile(join(root, "proj", "src", "deep", "b.ts"), "b");
  await writeFile(join(root, "proj", ".git", "HEAD"), "ref");
  await writeFile(join(root, "proj", "node_modules", "x", "i.js"), "i");
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "node_modules", "x"), { recursive: true });
  await writeFile(outside, "TOP SECRET");
  await writeFile(join(root, "README.md"), "# Hello\n");
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src", "with fence.md"), "```js\nx\n```\n");
  await writeFile(join(root, "src", "deep", "b.ts"), "b");
  await writeFile(join(root, "src", "deep", "deeper", "c.ts"), "c");
  await writeFile(join(root, ".git", "HEAD"), "ref");
  await writeFile(join(root, "node_modules", "x", "i.js"), "i");
  await writeFile(join(root, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  await writeFile(join(root, "photo.JPG"), Buffer.from([0xff, 0xd8, 0xff]));
  await writeFile(join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  await symlink(outside, join(root, "link.txt"));
  await mkdir(join(root, "big"));
  await writeFile(join(root, "big", "huge.txt"), "x".repeat(MAX_FILE_BYTES + 5000));
  for (const n of [1, 2, 3, 4]) await writeFile(join(root, "big", `f${n}.txt`), "y".repeat(MAX_FILE_BYTES));
  await mkdir(join(root, "many"));
  for (let i = 0; i < MAX_DIR_ENTRIES + 30; i++) await writeFile(join(root, "many", `f${String(i).padStart(4, "0")}.txt`), "");
});
afterAll(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

describe("findAtTokens", () => {
  it("jetons en début ou après un blanc, jamais dans une adresse mail", () => {
    expect(findAtTokens("see @src/a.ts, and bob@example.com or @\"my file.txt\" @https://x.io").map((t) => t.value)).toEqual(["src/a.ts,", "my file.txt", "https://x.io"]);
  });
});

describe("expandAtRefs", () => {
  it("fichier texte : bloc délimité avec le chemin, texte d'origine conservé", async () => {
    const r = await expandAtRefs("explain @src/a.ts please", root);
    expect(r.text.startsWith("explain @src/a.ts please\n\n")).toBe(true);
    expect(r.text).toContain("File `src/a.ts` (20 B):\n```\nexport const a = 1;\n```");
    expect(r.added).toEqual(["src/a.ts"]);
    expect(r.attachments).toEqual([]);
  });

  it("ponctuation finale tolérée ; le même fichier cité deux fois n'est inséré qu'une fois", async () => {
    const r = await expandAtRefs("look @README.md, then @README.md.", root);
    expect(r.text.match(/File `README.md`/g)).toHaveLength(1);
  });

  it("le contenu avec des ``` reçoit une barrière plus longue", async () => {
    const r = await expandAtRefs('@"src/with fence.md"', root);
    expect(r.text).toContain("````\n```js\nx\n```\n````");
  });

  it("un chemin qui sort du dossier est refusé et laissé tel quel (.., absolu, lien symbolique)", async () => {
    for (const tok of ["@../secret.txt", `@${outside}`, "@link.txt"]) {
      const r = await expandAtRefs(`read ${tok}`, root);
      expect(r.text).toBe(`read ${tok}`);
      expect(r.text).not.toContain("TOP SECRET");
      expect(r.warnings.join("\n")).toContain("outside the session folder");
    }
  });

  it("un chemin absolu DANS le dossier est accepté", async () => {
    const r = await expandAtRefs(`@${join(root, "src", "a.ts")}`, root);
    expect(r.text).toContain("File `src/a.ts`");
  });

  it("images : pièces jointes {path} relatives, extension insensible à la casse, aucun contenu inséré", async () => {
    const r = await expandAtRefs("what is @shot.png and @photo.JPG ?", root);
    expect(r.attachments).toEqual([{ path: "shot.png" }, { path: "photo.JPG" }]);
    expect(r.text).toBe("what is @shot.png and @photo.JPG ?");
  });

  it("images : 4 au plus, 5 Mo au plus", async () => {
    const dir = join(root, "imgs");
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 6; i++) await writeFile(join(dir, `i${i}.png`), Buffer.from([0x89, 0x50]));
    const r = await expandAtRefs([0, 1, 2, 3, 4, 5].map((i) => `@imgs/i${i}.png`).join(" "), root);
    expect(r.attachments).toHaveLength(4);
    expect(r.warnings).toHaveLength(2);
    await writeFile(join(dir, "huge.webp"), Buffer.alloc(5 * 1024 * 1024 + 1));
    const big = await expandAtRefs("@imgs/huge.webp", root);
    expect(big.attachments).toEqual([]);
    expect(big.warnings.join()).toContain("over 5 MB");
  });

  it("dossier : profondeur 2, sans .git ni node_modules, dossiers terminés par /", async () => {
    const r = await expandAtRefs("@proj", root);
    expect(r.text).toContain("src/\n");
    expect(r.text).toContain("src/a.ts\n");
    expect(r.text).toContain("src/deep/\n");
    expect(r.text).not.toContain("src/deep/b.ts"); // profondeur 3
    expect(r.text).not.toContain(".git");
    expect(r.text).not.toContain("node_modules");
    const src = await expandAtRefs("@src", root);
    expect(src.text).toContain("deep/b.ts");
    expect(src.text).not.toContain("deeper/c.ts");
  });

  it("dossier : 200 entrées au plus, le reste est compté", async () => {
    const r = await expandAtRefs("@many", root);
    const listed = r.text.split("\n").filter((l) => /^f\d{4}\.txt$/.test(l));
    expect(listed).toHaveLength(MAX_DIR_ENTRIES);
    expect(r.text).toContain("30 more not listed");
    expect(r.warnings.join()).toContain("cut at 200");
  });

  it("fichier : plafond 100 Ko, tronqué avec mention ; total 300 Ko", async () => {
    const one = await expandAtRefs("@big/huge.txt", root);
    expect(one.text).toContain("truncated to the first 100 KB");
    expect(one.text.length).toBeLessThan(MAX_FILE_BYTES + 1000);
    const many = await expandAtRefs("@big/f1.txt @big/f2.txt @big/f3.txt @big/f4.txt", root);
    expect(many.text.length).toBeLessThan(MAX_TOTAL_BYTES + 2000);
    expect(many.text).toContain("total size limit");
    expect(many.warnings.join()).toContain("total limit of 300 KB");
  });

  it("fichier binaire : pas inséré", async () => {
    const r = await expandAtRefs("@bin.dat", root);
    expect(r.text).toBe("@bin.dat");
    expect(r.warnings.join()).toContain("binary");
  });

  it("http(s) : rien de téléchargé, une ligne web_fetch ; marche aussi sans dossier de session", async () => {
    const r = await expandAtRefs("summarise @https://example.com/a?b=1.", null);
    expect(r.text).toContain("Read the page at https://example.com/a?b=1 with your web_fetch tool");
    expect(r.attachments).toEqual([]);
  });

  it("un @ qui ne correspond à rien reste tel quel (mail, mot, fichier absent)", async () => {
    for (const s of ["write to bob@example.com", "ping @nobody", "@missing.ts", "@ alone"]) {
      const r = await expandAtRefs(s, root);
      expect(r.text).toBe(s);
      expect(r.added).toEqual([]);
      expect(r.warnings).toEqual([]);
    }
  });

  it("sans session de code : les fichiers ne sont pas lus", async () => {
    const r = await expandAtRefs("@README.md", null);
    expect(r.text).toBe("@README.md");
  });
});

describe("completeAtRef (Tab)", () => {
  it("préfixe commun, un seul candidat fichier → espace, dossier → /", async () => {
    expect((await completeAtRef("see @RE", root))?.value).toBe("see @README.md ");
    expect((await completeAtRef("see @sr", root))?.value).toBe("see @src/");
    const s = await completeAtRef("@src/", root);
    expect(s?.candidates).toEqual(["a.ts", "deep/", "with fence.md"]);
    expect(s?.value).toBe("@src/");
    expect((await completeAtRef("@src/d", root))?.value).toBe("@src/deep/");
  });

  it("cache .git et node_modules, ignore ce qui n'est pas une référence", async () => {
    const all = await completeAtRef("@", root);
    expect(all?.candidates).not.toContain(".git/");
    expect(all?.candidates).not.toContain("node_modules/");
    expect(await completeAtRef("no ref here", root)).toBeNull();
    expect(await completeAtRef("mail bob@ex", root)).toBeNull();
    expect(await completeAtRef("@zzz", root)).toBeNull();
    expect(await completeAtRef("@https://ex", root)).toBeNull();
  });
});

describe("/init n'est pas affecté", () => {
  it("le parseur n'a pas changé de forme", () => {
    expect(parseSlashCommand("/init")).toEqual({ kind: "init" });
  });
});

describe("CliSession.sendMessage : attachments", () => {
  it("les pièces jointes partent avec le tour (streamChatCompletion, 5e argument)", async () => {
    const { CliSession } = await import("../src/session.js");
    const seen: Array<{ messages: unknown; opts: Record<string, unknown> }> = [];
    const fake = {
      streamChatCompletion: async (_id: string, messages: unknown, _on: unknown, _model: string, opts: Record<string, unknown>) => {
        seen.push({ messages, opts });
      },
    };
    const s = new CliSession(fake as never, null);
    await s.sendMessage("hi", () => undefined, { attachments: [{ path: "shot.png" }] });
    await s.sendMessage("plain", () => undefined);
    expect(seen[0]!.opts.attachments).toEqual([{ path: "shot.png" }]);
    expect(seen[1]!.opts).not.toHaveProperty("attachments");
  });
});
