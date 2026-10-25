/** Rendu Ink complet de l'App contre le mock : session locale, appels d'outils, carte, résumé, annulation. */
import React from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import { App } from "../src/ui/App.js";

let dir: string;
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

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-cli-app-"));
  process.env.NOKKER_CONFIG_DIR_OVERRIDE = dir;
  mock = await startMockServer({ port: 0, seed: false, speed: 0.05 });
});
afterAll(async () => {
  await mock.close();
  if (keep === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
  else process.env.NOKKER_CONFIG_DIR_OVERRIDE = keep;
  await rm(dir, { recursive: true, force: true });
});

describe("App (saisie pendant la connexion, en-tête)", () => {
  it("une ligne tapée AVANT la fin de la connexion est mise en attente puis envoyée exactement une fois", async () => {
    const r = render(<App baseUrl={mock.url} cwd="/work/attente" />);
    r.stdin.write("bonjour"); // aucune session encore : la connexion n'a même pas commencé
    await wait(20);
    r.stdin.write("\r");
    await frameHas(r, "partira dès que la session sera prête");
    await frameHas(r, "Session locale sur « attente »"); // la réponse du tour
    await wait(300);
    const turns = [...mock.state.threads.values()].flatMap((t) => t.turns).filter((t) => t.user === "bonjour");
    expect(turns).toHaveLength(1);
    r.unmount();
  });

  it("l'en-tête tronque un long titre de fil à 32 caractères", async () => {
    const { shortLabel } = await import("../src/ui/Header.js");
    const t = shortLabel("lance pytest -q et dis le résultat en une phrase");
    expect(t.length).toBe(32);
    expect(t.endsWith("…")).toBe(true);
    expect(shortLabel("th_abc")).toBe("th_abc");
  });
});

describe("App (session locale)", () => {
  it("en-tête du dossier, outils, carte, choix 2, résumé dans le fil, réponse", async () => {
    const r = render(<App baseUrl={mock.url} cwd="/work/mon-projet" />);
    await frameHas(r, "Session de code sur /work/mon-projet");
    expect(r.lastFrame()).toContain("mon-projet");
    expect(r.lastFrame()).toContain("routage auto");
    r.stdin.write("corrige le test add");
    await wait(50);
    r.stdin.write("\r");
    await frameHas(r, "Action à approuver");
    // mode accept_edits : le patch passe sans carte, la première carte est pytest (terminal)
    expect(r.lastFrame()).toContain("✓ patch src/app.py");
    expect(r.lastFrame()).toContain("Commande : pytest -q tests/test_add.py");
    expect(r.lastFrame()).toContain("3. Toujours cette commande");
    // commande de test : « Pour cette session » est la touche 1
    expect(r.lastFrame()).toMatch(/1\. Pour cette session[\s\S]*2\. Une fois/);
    await wait(150); // laisse Ink brancher les touches de la carte
    r.stdin.write("1");
    await frameHas(r, "✓ Approuvé (pour cette session) : terminal pytest -q tests/test_add.py");
    await frameHas(r, "Commande : rm -rf build"); // destructif : carte sans « Toujours »
    expect(r.lastFrame()).not.toContain("3. Toujours");
    await wait(150);
    r.stdin.write("1");
    await frameHas(r, "est nettoyé");
    r.unmount();
  });

  it("noyau réel (carte « en attente ») : l'appel attend sa carte, puis affiche la vraie sortie de l'outil approuvé", async () => {
    mock.state.approvalStyle = "kernel";
    try {
      const r = render(<App baseUrl={mock.url} cwd="/work/noyau" />);
      await frameHas(r, "Session de code sur /work/noyau");
      r.stdin.write("corrige le test add");
      await wait(50);
      r.stdin.write("\r");
      await frameHas(r, "Action à approuver");
      await frameHas(r, "⏸ terminal pytest -q tests/test_add.py (en attente d'approbation)");
      await wait(150);
      r.stdin.write("2"); // Une fois
      // `tool.result` de l'exécuteur (même call_id, approval_id) : la ligne se ferme, sortie dépliée.
      await frameHas(r, "✓ terminal pytest -q tests/test_add.py");
      await frameHas(r, "1 passed in 0.12s");
      await frameHas(r, "Commande : rm -rf build"); // la carte forte arrive dans le tour de suite
      await wait(150);
      r.stdin.write("\u0003"); // refus : rien ne tourne après (continuation « none »)
      await frameHas(r, "✗ Refusé : terminal rm -rf build");
      await frameHas(r, "✗ terminal rm -rf build");
      r.unmount();
    } finally {
      mock.state.approvalStyle = "inline";
    }
  });

  it("Échap pendant une carte ne décide pas ; /cancel annule le tour", async () => {
    const r = render(<App baseUrl={mock.url} cwd="/work/annule-moi" />);
    await frameHas(r, "Session de code sur /work/annule-moi");
    r.stdin.write("corrige le test add");
    await wait(50);
    r.stdin.write("\r");
    await frameHas(r, "Action à approuver");
    await wait(150);
    r.stdin.write("\u001B");
    await wait(300);
    expect(r.lastFrame()).toContain("Action à approuver");
    r.stdin.write("\u0003"); // Ctrl+C : refus (+ annulation du tour s'il tourne encore)
    await frameHas(r, "✗ Refusé : terminal pytest -q tests/test_add.py");
    r.unmount();
  });
});

describe("App (commandes d'outils du noyau)", () => {
  async function open(cwd: string | null) {
    const r = render(<App baseUrl={mock.url} cwd={cwd ?? "/work/cmd"} />);
    await frameHas(r, "Session de code sur");
    return r;
  }
  async function type(r: ReturnType<typeof render>, text: string): Promise<void> {
    r.stdin.write(text);
    await wait(50);
    r.stdin.write("\r");
  }

  it("/checkpoints, /diff (coloré), /plan, /skills, /agents", async () => {
    const r = await open("/work/cmds1");
    await type(r, "/checkpoints");
    await frameHas(r, "Points de retour");
    expect(r.lastFrame()).toContain("avant patch src/app.py");
    await type(r, "/diff");
    await frameHas(r, "+    return a + b");
    await type(r, "/diff 2");
    await frameHas(r, "depuis le point");
    await type(r, "/plan");
    await frameHas(r, "[~] Corriger add() dans src/app.py");
    expect(r.lastFrame()).toContain("[x] Lire le test qui échoue");
    await type(r, "/skills");
    await frameHas(r, "git-bisect");
    expect(r.lastFrame()).toContain("pytest-debug");
    await type(r, "/skills git-bisect");
    await frameHas(r, "Toujours finir par");
    await type(r, "/agents");
    await frameHas(r, "Aucun sous-agent");
    await type(r, "lance un sous-agent");
    await frameHas(r, "terminé (ok)", 8000);
    await type(r, "/agents");
    await frameHas(r, "Sous-agents :");
    expect(r.lastFrame()).toContain("dernier outil : patch");
    expect(r.lastFrame()).toContain("lire les tests et proposer un correctif");
    r.unmount();
  });

  it("ligne de coût sous chaque tour, puis /cost (session et jour)", async () => {
    const r = await open("/work/cout");
    await type(r, "bonjour");
    await frameHas(r, "jetons · ");
    expect(r.lastFrame()).toMatch(/· [\d,]+ k jetons · (?:< )?0,0\d €/);
    expect(r.lastFrame()).not.toMatch(/\d+ tokens \(/); // le pied de tour ne répète pas les jetons
    await type(r, "/cost");
    await frameHas(r, "Coût");
    await frameHas(r, "session : 1 tour(s)");
    expect(r.lastFrame()).toMatch(/jour \(\d{4}-\d{2}-\d{2}, UTC\) : \d+ tour\(s\)/);
    r.unmount();
  });

  it("/rollback : carte, approbation, résumé des fichiers restaurés", async () => {
    const r = await open("/work/cmds2");
    await type(r, "/rollback 2");
    await frameHas(r, "Action à approuver");
    expect(r.lastFrame()).toContain("checkpoint_restore");
    expect(r.lastFrame()).not.toContain("3. Toujours");
    await wait(150);
    r.stdin.write("1");
    await frameHas(r, "Retour à");
    await frameHas(r, "restauré  src/app.py");
    expect(r.lastFrame()).toContain("conservé  notes.md");
    r.unmount();
  });

  it("/rollback refusé : message d'échec", async () => {
    const r = await open("/work/cmds3");
    await type(r, "/rollback");
    await frameHas(r, "Action à approuver");
    await wait(150);
    r.stdin.write("4");
    await frameHas(r, "✗ Retour à");
    r.unmount();
  });

  it("hors session de code (fil ordinaire) : message dédié", async () => {
    const r = await open("/work/cmds4");
    await type(r, "/thread ordinaire");
    await frameHas(r, "Nouveau fil");
    for (const c of ["/diff", "/rollback", "/checkpoints", "/skills", "/plan", "/agents"]) {
      await type(r, c);
      await wait(150);
    }
    const count = (r.lastFrame() ?? "").split("disponible dans une session de code (nokker dans un dossier)").length - 1;
    expect(count).toBe(6);
    r.unmount();
  });
});
