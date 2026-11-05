import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { fileLastThreadStore, LAST_THREADS_MAX } from "../src/lastthread.js";
import { hideGoalMarker, isControlTitle, loopThreadTitle, shownUserText } from "../src/controltext.js";
import { btwPrompt, goalCheckPrompt, goalContinuePrompt, loopPrompt } from "../src/prompts.js";
import { setLang } from "../src/i18n/index.js";
import { CliSession } from "../src/session.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "lt-")), "local-threads.json");

describe("dernier fil par dossier (local-threads.json)", () => {
  it("mémorise par serveur ET dossier, fichier 0600", () => {
    const p = tmp();
    const a = fileLastThreadStore("http://127.0.0.1:8744/", p);
    a.set("/w/calc", "th_aaa");
    expect(fileLastThreadStore("http://127.0.0.1:8744", p).get("/w/calc")).toBe("th_aaa");
    expect(fileLastThreadStore("http://127.0.0.1:9999", p).get("/w/calc")).toBeNull();
    expect(a.get("/w/autre")).toBeNull();
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("fichier illisible ou id invalide : rien de mémorisé, aucune erreur", () => {
    const p = tmp();
    writeFileSync(p, "{pas du json");
    const s = fileLastThreadStore("http://h", p);
    expect(s.get("/w")).toBeNull();
    writeFileSync(p, JSON.stringify({ version: 1, entries: { "http://h|/w": { thread_id: "../etc", at: "x" } } }));
    expect(s.get("/w")).toBeNull();
    s.set("/w", "th_ok");
    expect(s.get("/w")).toBe("th_ok");
  });

  it("garde les plus récentes entrées seulement", () => {
    const p = tmp();
    let n = 0;
    const s = fileLastThreadStore("http://h", p, () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++)));
    for (let i = 0; i < LAST_THREADS_MAX + 5; i++) s.set(`/w/${i}`, `th_${i}`);
    const kept = Object.keys(JSON.parse(readFileSync(p, "utf8")).entries);
    expect(kept.length).toBe(LAST_THREADS_MAX);
    expect(s.get("/w/0")).toBeNull();
    expect(s.get(`/w/${LAST_THREADS_MAX + 4}`)).toBe(`th_${LAST_THREADS_MAX + 4}`);
  });
});

describe("openLocal après redémarrage du noyau (liste vide)", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { get: (c: string) => m.get(c) ?? null, set: (c: string, t: string) => void m.set(c, t), m };
  };

  it("redemande le dernier fil du dossier par POST {cwd, thread_id} et relit son historique", async () => {
    const posts: unknown[] = [];
    const fake = {
      listLocalSessions: async () => [],
      createLocalSession: async (req: { cwd: string; thread_id?: string }) => (posts.push(req), { thread_id: req.thread_id ?? "th_neuf", cwd: req.cwd, skills: "off" }),
      getThread: async () => ({ messages: [{ role: "user", content: "avant" }] }),
    };
    const store = mem();
    store.set("/w/calc", "th_ancien");
    const r = await new CliSession(fake as never, null).openLocal("/w/calc", store);
    expect(posts).toEqual([{ cwd: "/w/calc", thread_id: "th_ancien" }]);
    expect(r).toMatchObject({ resumed: true, messages: [{ content: "avant" }], skills: "off" });
  });

  it("fil refusé (404) : fil neuf, et le neuf devient le dernier du dossier", async () => {
    const posts: unknown[] = [];
    const fake = {
      listLocalSessions: async () => [],
      createLocalSession: async (req: { cwd: string; thread_id?: string }) => {
        posts.push(req);
        if (req.thread_id) throw new NokkerApiError("not found", 404, null);
        return { thread_id: "th_neuf", cwd: req.cwd };
      },
    };
    const store = mem();
    store.set("/w/calc", "th_perdu");
    const s = new CliSession(fake as never, null);
    const r = await s.openLocal("/w/calc", store);
    expect(r.resumed).toBe(false);
    expect(posts).toHaveLength(2);
    expect(s.threadId).toBe("th_neuf");
    expect(store.get("/w/calc")).toBe("th_neuf");
  });

  it("le noyau connaît la session : pas de POST, et elle est mémorisée", async () => {
    let posted = false;
    const fake = {
      listLocalSessions: async () => [{ thread_id: "th_k", cwd: "/w/p", last_turn_at: null }],
      createLocalSession: async () => ((posted = true), { thread_id: "x", cwd: "/w/p" }),
      getThread: async () => ({ messages: [] }),
      getLocalSessionSkills: async () => { throw new Error("404"); },
    };
    const store = mem();
    await new CliSession(fake as never, null).openLocal("/w/p", store);
    expect(posted).toBe(false);
    expect(store.get("/w/p")).toBe("th_k");
  });
});

describe("textes de contrôle cachés", () => {
  it("titre de fil d'un /loop reconnu et remplacé par le texte tapé", () => {
    const first = loopPrompt("Réponds seulement le mot : tic", 1, 50, 30_000);
    expect(isControlTitle(first.slice(0, 32) + "…")).toBe(true);
    expect(isControlTitle("[Vérification du but]")).toBe(true);
    expect(isControlTitle("Lance les tests")).toBe(false);
    expect(isControlTitle("[WIP] refonte")).toBe(false);
    expect(isControlTitle(null)).toBe(false);
    expect(loopThreadTitle("Réponds seulement le mot :   tic")).toBe("/loop Réponds seulement le mot : tic");
    expect(loopThreadTitle("x".repeat(100))!.length).toBe(60);
    expect(loopThreadTitle("  ")).toBeNull();
  });

  it("historique relu : blocs de contrôle sous leur forme courte, le reste tel quel", () => {
    const goal = "Le fichier hello.txt existe et contient bonjour.";
    expect(shownUserText(loopPrompt("Réponds seulement le mot : tic", 3, 50, 30_000))).toBe("(loop) Réponds seulement le mot : tic");
    expect(shownUserText(goalCheckPrompt(goal))).toBe("(goal) is the goal reached?");
    expect(shownUserText(goalContinuePrompt(goal))).toBe("(goal) continue toward the goal");
    expect(shownUserText(btwPrompt({ cwd: "/w", threadTitle: null }, "Capitale de la Suisse ?"))).toBe("(by the way) Capitale de la Suisse ?");
    expect(shownUserText("[WIP] corrige le test\n[/WIP]")).toBe("[WIP] corrige le test\n[/WIP]");
    expect(shownUserText("Lance les tests")).toBe("Lance les tests");
    setLang("fr");
    try {
      expect(shownUserText(goalCheckPrompt(goal))).toBe("(objectif) est-il atteint ?");
    } finally {
      setLang("en");
    }
  });

  it("GOAL: DONE / CONTINUE masqué, en ligne seule ou en fin de ligne, et pendant le streaming", () => {
    expect(hideGoalMarker("Oui, le but est atteint.\n\nGOAL: DONE")).toBe("Oui, le but est atteint.");
    expect(hideGoalMarker("Pas encore. GOAL: CONTINUE\n")).toBe("Pas encore.");
    expect(hideGoalMarker("Fini.\ngoal: done")).toBe("Fini.");
    expect(hideGoalMarker("Fini.\nGOAL: D", true)).toBe("Fini.");
    expect(hideGoalMarker("Fini.\nGOAL: D")).toBe("Fini.\nGOAL: D"); // historique : pas de préfixe partiel retiré
    expect(hideGoalMarker("Texte normal\nGO", false)).toBe("Texte normal\nGO");
    expect(hideGoalMarker("Le marqueur GOAL: DONE est au milieu, pas à la fin.")).toBe("Le marqueur GOAL: DONE est au milieu, pas à la fin.");
  });
});
