/** Rendu Ink de l'App contre le mock : skills du dépôt (carte de confiance, /skills), mémoire de projet (/memory, oubli
 * confirmé), sous-agents en arrière-plan (/agents, résultat, annulation), et l'anglais par défaut. */
import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import { App } from "../src/ui/App.js";
import { setLang } from "../src/i18n/index.js";

let dir: string;
let work: string;
let mock: MockServerHandle;
const keep = process.env.NOKKER_CONFIG_DIR_OVERRIDE;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function frameHas(r: ReturnType<typeof render>, text: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!(r.lastFrame() ?? "").includes(text)) {
    if (Date.now() - t0 > ms) throw new Error(`absent : ${text}\n${r.lastFrame()}`);
    await wait(25);
  }
}
/** La carte est affichée : elle n'écoute le clavier qu'après CONFIRM_ARM_MS (anti-frappe anticipée). */
async function key(r: ReturnType<typeof render>, k: string): Promise<void> {
  await wait(650);
  r.stdin.write(k);
}
async function type(r: ReturnType<typeof render>, text: string): Promise<void> {
  await wait(100); // une carte vient peut-être de se fermer : le champ reprend le focus
  r.stdin.write(text);
  await wait(50);
  await key(r, "\r");
}
/** Dépôt avec `.git`, un fichier d'instructions et deux skills de dépôt. */
async function repo(name: string): Promise<string> {
  const root = join(work, name);
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, ".nokker", "skills", "dev", "lint"), { recursive: true });
  await mkdir(join(root, ".nokker", "skills", "dev", "fmt"), { recursive: true });
  await writeFile(join(root, ".nokker", "skills", "dev", "lint", "SKILL.md"), "---\nname: lint\ndescription: Run the linter\n---\n# lint\n");
  await writeFile(join(root, ".nokker", "skills", "dev", "fmt", "SKILL.md"), "---\nname: fmt\ndescription: Format the code\n---\n# fmt\n");
  await writeFile(join(root, "AGENTS.md"), "# Build\n\nRun `make`.\n\n## Tests\n\npytest -q\n");
  return root;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-cli-lokkal-"));
  work = await mkdtemp(join(tmpdir(), "nokker-cli-work-"));
  process.env.NOKKER_CONFIG_DIR_OVERRIDE = dir;
  mock = await startMockServer({ port: 0, seed: false, speed: 0.05, projectSkills: true });
});
afterAll(async () => {
  await mock.close();
  if (keep === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
  else process.env.NOKKER_CONFIG_DIR_OVERRIDE = keep;
  await rm(dir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});
// Ces scénarios vérifient le français : la langue est posée ici (la suite tourne en anglais) puis remise à l'anglais.
beforeEach(() => setLang("fr"));
afterEach(() => setLang("en"));

describe("skills du dépôt", () => {
  it("carte de confiance à l'ouverture (racine, nombre, empreinte) ; o = POST trust, /skills montre la confiance et les skills", async () => {
    const root = await repo("trusted");
    const r = render(<App baseUrl={mock.url} cwd={root} />);
    await frameHas(r, "Faire confiance aux skills de ce dépôt ?");
    const frame = r.lastFrame()!;
    expect(frame).toContain(root);
    expect(frame).toMatch(/Skills : 2 dans \.nokker\/skills/);
    expect(frame).toMatch(/Empreinte : [0-9a-f]{64}/);
    await key(r, "o");
    await frameHas(r, "✓ Skills du dépôt de confiance");
    const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
    expect(settings.trusted_project_skills).toEqual([{ root, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    await type(r, "/skills");
    await frameHas(r, "2 de confiance, empreinte");
    await frameHas(r, "[project]");
    expect(r.lastFrame()).toContain("Run the linter");
    r.unmount();
  });

  it("n = pas maintenant : skills ignorés ; /skills le dit ; /skills trust rouvre la carte", async () => {
    const root = await repo("later");
    const r = render(<App baseUrl={mock.url} cwd={root} />);
    await frameHas(r, "Faire confiance aux skills de ce dépôt ?");
    await key(r, "n");
    await frameHas(r, "laissés sans confiance");
    expect(r.lastFrame()).not.toContain("Faire confiance aux skills de ce dépôt ?");
    await type(r, "/skills");
    await frameHas(r, "SANS confiance, ignorés");
    expect(r.lastFrame()).not.toContain("[project]");
    await type(r, "/skills trust");
    await frameHas(r, "Faire confiance aux skills de ce dépôt ?");
    await key(r, "\r"); // Entrée ne vaut jamais confiance
    await wait(200);
    expect(r.lastFrame()).not.toContain("✓ Skills du dépôt de confiance");
    await key(r, "o");
    await frameHas(r, "✓ Skills du dépôt de confiance");
    r.unmount();
  });
});

describe("carte de confiance : frappe anticipée", () => {
  it("une commande tapée au moment où la carte s'ouvre ne lui répond pas", async () => {
    const root = await repo("typeahead");
    const r = render(<App baseUrl={mock.url} cwd={root} />);
    await frameHas(r, "Faire confiance aux skills de ce dépôt ?");
    r.stdin.write("/memory");
    r.stdin.write("\r");
    await wait(300);
    expect(r.lastFrame()).toContain("Faire confiance aux skills de ce dépôt ?");
    expect(r.lastFrame()).not.toContain("✓ Skills du dépôt de confiance");
    await key(r, "n");
    await frameHas(r, "laissés sans confiance");
    r.unmount();
  });
});

describe("mémoire de projet", () => {
  it("/memory liste notes, sections et mémoire longue ; /memory <note> ; oubli confirmé ; une section ne s'oublie pas", async () => {
    const root = await repo("memo");
    const r = render(<App baseUrl={mock.url} cwd={root} />);
    await frameHas(r, "Faire confiance aux skills");
    await key(r, "n");
    await frameHas(r, "laissés sans confiance");
    await type(r, "/memory");
    await frameHas(r, "Notes apprises (2) :");
    let f = r.lastFrame()!;
    expect(f).toContain("[règle] Run the test suite before every commit");
    expect(f).toContain("toujours dans le contexte");
    expect(f).toContain("AGENTS.md");
    expect(f).toMatch(/• Build {2}\(src-[0-9a-f]{8}-1\)/);
    expect(f).toContain("Mémoire longue : direct, saine, 12 note(s) indexée(s).");
    await type(r, "/memory fact-api");
    await frameHas(r, "vite.config.ts sets server.port to 5173.");
    await type(r, "/memory forget src-");
    await frameHas(r, "Note introuvable : src-");
    const section = /\((src-[0-9a-f]{8}-1)\)/.exec(f)![1]!;
    await type(r, `/memory forget ${section}`);
    await frameHas(r, "vient d'un fichier d'instructions");
    await type(r, "/memory forget rule-run");
    await frameHas(r, "Oublier cette note ?");
    await key(r, "o");
    await frameHas(r, "✓ Oubliée : Run the test suite before every commit (rule-run-tests-before-commit-3f2a).");
    await type(r, "/memory");
    await frameHas(r, "Notes apprises (1) :");
    f = r.lastFrame()!;
    expect(f.slice(f.lastIndexOf("Notes apprises (1)"))).not.toContain("rule-run-tests");
    r.unmount();
  });

  it("drapeau éteint côté noyau : message clair", async () => {
    mock.state.projectMemory = false;
    try {
      const r = render(<App baseUrl={mock.url} cwd={join(work, "nomem")} />);
      await frameHas(r, "Session de code sur");
      await type(r, "/memory");
      await frameHas(r, "Mémoire du projet indisponible sur ce noyau (local.project_memory est éteint).");
      r.unmount();
    } finally {
      mock.state.projectMemory = true;
    }
  });
});

describe("sous-agents en arrière-plan", () => {
  it("/agents : état, dernier outil, durée, résultat ; arrêt d'un seul (403 du noyau) puis de tous", async () => {
    const r = render(<App baseUrl={mock.url} cwd={join(work, "bg")} />);
    await frameHas(r, "Session de code sur");
    await type(r, "lance deux sous-agents en arrière-plan");
    await frameHas(r, "(arrière-plan) : audit the test suite");
    // les deux enfants finis, et le tour du parent rendu (delegate_status répond 409 pendant un tour)
    for (let i = 0; i < 200 && (r.lastFrame() ?? "").split("pour son résultat.").length < 3; i++) await wait(25);
    await wait(200);
    await type(r, "/agents");
    await frameHas(r, "Sous-agents :");
    const f = r.lastFrame()!;
    expect(f).toMatch(/• \w+ {2}terminé +\(arrière-plan\) {2}audit the test suite for flaky tests {2}dernier outil : patch/);
    expect(f).toContain("1 commit(s)");
    expect(f).toContain("résultat : Read the tests and fixed add()");
    const id = /Sous-agent en arrière-plan (\w+) fini/.exec(f)![1]!;
    await type(r, `/agents ${id.slice(0, 4)}`);
    await frameHas(r, `Sous-agent ${id} (arrière-plan)`);
    expect(r.lastFrame()).toContain("worktree : nokker/sa-");
    expect(r.lastFrame()).toMatch(/coût : 4210 jetons · .*CHF/);
    await type(r, `/agents cancel ${id}`);
    await frameHas(r, "Ce noyau ne sait pas encore arrêter un seul sous-agent");
    await type(r, "/agents cancel all");
    await frameHas(r, "sous-agent(s) arrêté(s)");
    r.unmount();
  });
});

describe("anglais par défaut", () => {
  it("carte de confiance, aide et lignes en anglais", async () => {
    setLang("en");
    const root = await repo("english");
    const r = render(<App baseUrl={mock.url} cwd={root} />);
    await frameHas(r, "Trust this repository's skills?");
    expect(r.lastFrame()).toContain("Fingerprint:");
    await key(r, "y");
    await frameHas(r, "✓ Repository skills trusted");
    await type(r, "/help");
    await frameHas(r, "Commands:");
    expect(r.lastFrame()).toContain("/memory forget <note>");
    await type(r, "/agents");
    await frameHas(r, "No sub-agents on this thread.");
    r.unmount();
  });
});
