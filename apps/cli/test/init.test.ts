import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initPrompt, initPromptFor } from "../src/init.js";
import { parseSlashCommand } from "../src/commands.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "nokker-init-"));
  dirs.push(d);
  return d;
};

describe("/init", () => {
  it("le parseur reconnaît /init", () => {
    expect(parseSlashCommand("/init")).toEqual({ kind: "init" });
    expect(parseSlashCommand("/INIT extra")).toEqual({ kind: "init" });
  });

  it("sans AGENTS.md : demande de le créer, sans toucher à autre chose", () => {
    const p = initPrompt(false);
    expect(p).toMatch(/structure/);
    expect(p).toMatch(/build/);
    expect(p).toMatch(/conventions/);
    expect(p).toMatch(/create it at the repository root/);
    expect(p).toMatch(/Touch nothing else/);
    expect(p).not.toMatch(/Do NOT overwrite/);
  });

  it("avec AGENTS.md : demande de le compléter sans écraser les sections manuelles", () => {
    const p = initPrompt(true);
    expect(p).toMatch(/already exists/);
    expect(p).toMatch(/Do NOT overwrite/);
    expect(p).toMatch(/written by hand/);
  });

  it("initPromptFor détecte le fichier dans le dossier", () => {
    const d = tmp();
    expect(initPromptFor(d)).toBe(initPrompt(false));
    writeFileSync(join(d, "AGENTS.md"), "# x\n");
    expect(initPromptFor(d)).toBe(initPrompt(true));
  });

  it("ne nomme aucun produit tiers", () => {
    expect(initPrompt(true) + initPrompt(false)).not.toMatch(/hermes|claude code/i);
  });
});
