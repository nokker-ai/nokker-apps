import { afterEach, describe, expect, it } from "vitest";
import { eventLabel } from "../src/house/HouseView.js";
import { navViews } from "../src/nav/views.js";
import { setShellLang } from "../src/i18n/index.js";

afterEach(() => setShellLang(null));
const labels = { team: "Team", household: "Household", connectors: "Connectors", account: "My account", incidents: () => "", invitations: () => "", learning: "Learning", waiting: () => "", house: "Home" };
const flags = { agents: 0, liveIncidents: null, plan: false, teamInvites: null, householdInvites: null, packs: false, code: false, local: false, learning: null };

describe("« Maison » room", () => {
  it("an event shows a badge of its type, in the interface language", () => {
    setShellLang("fr");
    expect(eventLabel("memory.report")).toBe("mémoire");
    expect(eventLabel("mail.arrived")).toBe("courrier");
    expect(eventLabel(null)).toBeNull();
  });
  it("the view is in the drawer (work) only when the core serves it", () => {
    expect(navViews({ ...flags, house: false }, labels).some((v) => v.id === "house")).toBe(false);
    const v = navViews({ ...flags, house: true }, labels).find((x) => x.id === "house");
    expect(v).toMatchObject({ group: "work", label: "Home" });
  });
});
