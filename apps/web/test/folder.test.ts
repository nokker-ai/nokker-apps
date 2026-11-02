import { afterEach, describe, expect, it } from "vitest";
import { folderProgress, folderRunMoving } from "@nokker-apps/sdk";
import { actionLabel, apiCodeText, cardText, runStatusLabel, stepLabel, zonePath } from "../src/folder/model.js";
import { navViews } from "../src/nav/views.js";
import { setShellLang } from "../src/i18n/index.js";

afterEach(() => setShellLang(null));
const labels = { team: "Team", household: "Household", connectors: "Connectors", account: "My account", incidents: () => "", invitations: () => "", learning: "Learning", waiting: () => "", house: "Home", folder: "Folder" };
const flags = { agents: 0, liveIncidents: null, plan: false, teamInvites: null, householdInvites: null, packs: false, code: false, local: true, learning: null, house: false };

describe("folder mode (FOLDER-MODE §6)", () => {
  it("the view exists only when the machine serves it", () => {
    expect(navViews(flags, labels).some((v) => v.id === "folder")).toBe(false);
    expect(navViews({ ...flags, folder: true }, labels).find((v) => v.id === "folder")).toMatchObject({ group: "work", icon: "folder" });
  });
  it("moving runs are read again; progress counts steps done or not done", () => {
    expect(folderRunMoving("planning") && folderRunMoving("running")).toBe(true);
    expect(folderRunMoving("awaiting_approval") || folderRunMoving("done")).toBe(false);
    expect(folderProgress({ steps: ["fait", "non fait", "en attente"] })).toEqual({ done: 2, total: 3 });
  });
  it("says the core's French words in the interface language", () => {
    expect(actionLabel("deplacer")).toBe("move");
    expect(zonePath("sortie/jpg/a.jpg")).toBe("output › jpg/a.jpg");
    setShellLang("fr");
    expect(runStatusLabel("awaiting_approval")).toBe("plan à valider");
    expect(runStatusLabel("undone")).toBe("défait");
    expect(stepLabel("non fait")).toBe("non fait");
    expect(actionLabel("corbeille")).toBe("à la corbeille");
    expect(zonePath("dossier/a.jpg")).toBe("dossier › a.jpg");
    expect(cardText(true)).toMatch(/dossier lui-même/);
    expect(apiCodeText("outside_roots", "x")).toMatch(/dossier déclaré/);
    expect(apiCodeText(undefined, "brut")).toBe("brut");
  });
});
