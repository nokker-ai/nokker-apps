import { beforeEach, describe, expect, it } from "vitest";
import type { DeviceRequestEvent } from "@nokker-apps/sdk";
import { answerRequest, capsToDeclare, minimal, setPimEnabled, type PimPlugin } from "../src/platform/pim.js";
import { NATIVE_PLUGINS } from "../src/platform/plugins.js";

const req = (op: DeviceRequestEvent["op"], args = {}): DeviceRequestEvent => ({ type: "device.request", request_id: "dr_1", op, args, expires_at: new Date(Date.now() + 20_000).toISOString() });
const store: Record<string, string> = {};
beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  (globalThis as unknown as { localStorage: Storage }).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v), removeItem: (k: string) => void delete store[k] } as Storage;
});

describe("données du téléphone à la demande (P8)", () => {
  it("déclare seulement ce qui est allumé, permis par iOS ET branché côté noyau (l'agenda)", () => {
    expect(capsToDeclare({ calendar: true, contacts: true }, { calendar: "granted", contacts: "granted" })).toEqual(["calendar.read"]);
    expect(capsToDeclare({ calendar: true }, { calendar: "denied" })).toEqual([]);
    expect(capsToDeclare({}, { calendar: "granted" })).toEqual([]);
    expect(NATIVE_PLUGINS).toContain("NokkerPim");
  });
  it("formes minimales : champs du contrat seulement, notes coupées à 300, 50 éléments", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ title: `E${i}`, start: "s", end: "e", all_day: false, calendar: "Perso", notes: "x".repeat(400), attendees: ["secret"], id: "EK123" }));
    const out = minimal("calendar.list", items) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(50);
    expect(Object.keys(out[0]!).sort()).toEqual(["all_day", "calendar", "end", "notes", "start", "title"]);
    expect((out[0]!.notes as string).length).toBe(300);
  });
  it("répond : agenda allumé → les éléments ; éteint ou pas encore branché → refus, sans lire", async () => {
    const answers: unknown[] = [];
    const client = { answerDeviceRequest: async (_id: string, b: unknown) => void answers.push(b) };
    let reads = 0;
    const plugin = {
      calendarList: async () => (reads++, { items: [{ title: "Dentiste", start: "s", end: "e", all_day: false, calendar: "Perso" }] }),
      contactsSearch: async () => (reads++, { items: [] }),
      remindersList: async () => (reads++, { items: [] }),
    } as unknown as PimPlugin;
    expect(await answerRequest(client, plugin, "dev_1", req("calendar.list"))).toEqual({ op: "calendar.list", count: 0, error: "denied" });
    setPimEnabled({ calendar: true, contacts: true });
    expect(await answerRequest(client, plugin, "dev_1", req("calendar.list", { from: "a", to: "b" }))).toEqual({ op: "calendar.list", count: 1 });
    expect(await answerRequest(client, plugin, "dev_1", req("contacts.search", { q: "Ca" }))).toMatchObject({ error: "denied" });
    expect(reads).toBe(1);
    expect(answers[1]).toEqual({ device_id: "dev_1", items: [{ title: "Dentiste", start: "s", end: "e", all_day: false, calendar: "Perso" }] });
  });
});
