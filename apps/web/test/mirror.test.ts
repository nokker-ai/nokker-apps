import { afterEach, describe, expect, it } from "vitest";
import { teamMemoryProjects } from "@nokker-apps/sdk";
import { fmtBytes, fmtDuration, lagText, light, pendingText } from "../src/mirror/model.js";
import { teamLine } from "../src/mirror/MirrorPanel.js";
import { setShellLang } from "../src/i18n/index.js";

afterEach(() => setShellLang(null));

describe("écran Miroir (§7.23)", () => {
  it("voyant : vert sans échec, orange sinon", () => {
    expect(light({ last_ok_at: 1, failures: 0, last_error: null, retry_in_s: 0 })).toBe("ok");
    expect(light({ last_ok_at: 1, failures: 3, last_error: { at: 1, kind: "ConnectTimeout", message: "ConnectTimeout" }, retry_in_s: 20 })).toBe("retry");
  });

  it("retard : à jour, en retard de N avec ce qui attend, ou rien n'est parti", () => {
    expect(lagText({ enabled: true, behind_s: 0, pending: { turns: 0 } })).toBe("Up to date: nothing is waiting.");
    expect(lagText({ enabled: true, behind_s: 125, pending: { turns: 3, pages: 1, notes: 0 } })).toBe("Behind by 2 min: 3 turns, 1 page waiting.");
    expect(lagText({ enabled: true, behind_s: null, pending: { turns: 1 } })).toBe("Nothing has left yet (1 turn waiting).");
    expect(pendingText({ turns: 0, team_notes: 2 })).toBe("2 team notes");
  });

  it("projet d'équipe : son nom quand la synchro l'a appris, sinon « Team project »", () => {
    const m = teamMemoryProjects({ enabled: true, team: { projects: { "pj_a|p-1": { cursor: 1, notes: 0, name: "Site" }, "pj_b|p-2": { cursor: null, notes: 0 } }, errors: {} } });
    expect([...m]).toEqual([["p-1", "Site"], ["p-2", null]]);
    expect(teamLine("Site", true)).toBe("Team project “Site”: its notes also go to the other members of the project.");
    expect(teamLine(null, false)).toMatch(/^Team project: mirrored/);
  });

  it("durées et tailles lisibles", () => {
    expect(fmtDuration(40)).toBe("40 s");
    expect(fmtDuration(7200)).toBe("2 h");
    expect(fmtDuration(5400)).toBe("1.5 h");
    expect(fmtBytes(48_200)).toBe("47 KiB");
    expect(fmtBytes(50 * 1048576)).toBe("50 MiB");
  });

  it("en français : virgule décimale, unités et phrases françaises", () => {
    setShellLang("fr");
    expect(fmtDuration(5400)).toBe("1,5 h");
    expect(fmtBytes(48_200)).toBe("47 Kio");
    expect(fmtBytes(50 * 1048576)).toBe("50 Mio");
    expect(lagText({ enabled: true, behind_s: 125, pending: { turns: 3, pages: 1, notes: 0 } })).toBe("En retard de 2 min : 3 tours, 1 page en attente.");
    expect(teamLine("Site", true)).toBe("Projet d'équipe « Site » : ses notes passent aussi aux autres membres du projet.");
  });
});
