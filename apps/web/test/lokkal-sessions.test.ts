import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, type Thread } from "@nokker-apps/sdk";
import { cwdByThread, folderName, joinUnderRoot, mergeLocalSessions, openSessionError } from "../src/lokkal/sessions.js";
import { NewCodeSession } from "../src/lokkal/NewCodeSession.js";
import { Drawer } from "../src/components/Drawer.js";
import { setShellLang } from "../src/i18n/index.js";

afterEach(() => setShellLang(null));

const thread = (id: string, title: string, updated = "2026-10-26T10:00:00Z"): Thread => ({
  id,
  title,
  owner: "alice",
  members: ["alice"],
  created_at: updated,
  updated_at: updated,
  working: false,
  unread: 0,
  bubble_count: 0,
  last_snippet: "",
});

describe("sessions de code du web servi par Lokkal", () => {
  it("dossier choisi : racine + sous-dossier, jamais hors de la racine", () => {
    expect(folderName("/home/alice/projects/site")).toBe("site");
    expect(folderName("/home/alice/projects/site/")).toBe("site");
    expect(joinUnderRoot("/home/alice/projects", "")).toBe("/home/alice/projects");
    expect(joinUnderRoot("/home/alice/projects/", "site/api")).toBe("/home/alice/projects/site/api");
    expect(joinUnderRoot("/", "srv")).toBe("/srv");
    expect(joinUnderRoot("/home/alice/projects", "../bob")).toBeNull();
    expect(joinUnderRoot("/home/alice/projects", "/etc")).toBeNull();
    expect(joinUnderRoot("/home/alice/projects", "a/./b")).toBeNull();
  });

  it("une session sans tour (inconnue du hub) entre dans la liste, titrée par son dossier ; les fils connus restent tels quels", () => {
    const hub = [thread("th_1", "General")];
    const sessions = [
      { thread_id: "th_1", cwd: "/home/alice/projects/site", title: "General" },
      { thread_id: "th_2", cwd: "/home/alice/projects/api", title: null, working: true },
    ];
    const merged = mergeLocalSessions(hub, sessions, "alice", "2026-10-26T12:00:00Z");
    expect(merged.map((t) => [t.id, t.title])).toEqual([
      ["th_1", "General"],
      ["th_2", "api"],
    ]);
    expect(merged[1]).toMatchObject({ owner: "alice", working: true, bubble_count: 0, updated_at: "2026-10-26T12:00:00Z" });
    expect(cwdByThread(sessions)).toEqual({ th_1: "/home/alice/projects/site", th_2: "/home/alice/projects/api" });
  });

  it("refus d'ouverture : 403 = dossier non autorisé, FR et EN", () => {
    const e403 = new NokkerApiError("x", 403, { error: { message: "dossier hors des racines déclarées" } });
    expect(openSessionError(e403)).toMatch(/not allowed/);
    setShellLang("fr");
    expect(openSessionError(e403)).toMatch(/n'est pas autorisé/);
    expect(openSessionError(new Error("réseau"))).toMatch(/n'a pas pu s'ouvrir/);
  });

  it("formulaire : racines déclarées en liste, chemin libre sans racine connue", () => {
    const two = renderToStaticMarkup(createElement(NewCodeSession, { roots: ["/home/alice/projects", "/srv"], onOpen: async () => undefined, onCancel: () => undefined }));
    expect(two).toContain("<select");
    expect(two).toContain("/srv");
    expect(two).toContain("New code session");
    const none = renderToStaticMarkup(createElement(NewCodeSession, { roots: [], onOpen: async () => undefined, onCancel: () => undefined }));
    expect(none).not.toContain("<select");
    expect(none).toContain("/home/alice/project");
  });

  it("barre des sessions : une session de code porte l'icône dossier et son dossier en sous-titre", () => {
    const html = renderToStaticMarkup(
      createElement(Drawer, {
        threads: [thread("th_1", "General"), thread("th_2", "api")],
        currentId: "th_1",
        dropTargetId: null,
        onSelect: () => undefined,
        onCreate: () => undefined,
        onDelete: () => undefined,
        codeSessions: { th_2: "/home/alice/projects/api" },
        roots: ["/home/alice/projects"],
        onCreateCode: async () => undefined,
      }),
    );
    expect(html).toContain("Code session api, folder /home/alice/projects/api");
    expect(html).toMatch(/class="session-row[^"]*\bcode\b"/);
    expect(html).toContain(">/home/alice/projects/api<");
  });
});
