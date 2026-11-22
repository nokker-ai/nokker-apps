/**
 * Agenda (puis contacts et rappels) du téléphone, à la demande (LOKKAL-PHONE §4.3, lot P8). Le plugin natif
 * `NokkerPim` lit EventKit / Contacts ; l'interface déclare les capacités allumées ET permises par iOS
 * (`PUT /v1/me/devices/{id}/caps`) et répond aux `device.request` du noyau (`POST …/result`). Phase S : seul l'agenda est
 * branché côté noyau (source de 068) ; contacts et rappels restent « bientôt », jamais déclarés, jamais demandés à iOS.
 */
import { CAP_OF, DEVICE_MAX_ITEMS, DEVICE_NOTES_MAX, type DeviceCap, type DeviceItem, type DeviceRequestEvent, type NokkerClient } from "@nokker-apps/sdk";
import { readJson, writeJson } from "../viewState.js";
import { isNativeShell, nativePlatform } from "./native.js";

export type PimKind = "calendar" | "contacts" | "reminders";
export type PimStatus = "not_determined" | "denied" | "restricted" | "granted" | "write_only" | "limited" | "unknown";

/** Ce que le noyau sait déjà utiliser (phase S : l'agenda seulement). */
export const LIVE_KINDS: ReadonlySet<PimKind> = new Set(["calendar"]);
const CAP: Record<PimKind, DeviceCap> = { calendar: "calendar.read", contacts: "contacts.read", reminders: "reminders.read" };
const KIND_OF_CAP: Record<DeviceCap, PimKind> = { "calendar.read": "calendar", "contacts.read": "contacts", "reminders.read": "reminders" };

type Result = { items?: Record<string, unknown>[]; error?: "denied" | "unavailable" | "too_large" };
export interface PimPlugin {
  status(): Promise<Record<PimKind, PimStatus>>;
  request(o: { kind: PimKind }): Promise<Record<PimKind, PimStatus>>;
  calendarList(o: { from?: string; to?: string; q?: string }): Promise<Result>;
  contactsSearch(o: { q?: string; limit?: number }): Promise<Result>;
  remindersList(o: { include_done?: boolean; due_before?: string }): Promise<Result>;
}

export function pimPlugin(w: unknown = globalThis): PimPlugin | undefined {
  return isNativeShell(w) ? (w as { Capacitor?: { Plugins?: { NokkerPim?: PimPlugin } } }).Capacitor?.Plugins?.NokkerPim : undefined;
}

/** Interrupteurs de « Cet appareil » (gardés sur l'appareil). */
export const pimEnabled = (): Partial<Record<PimKind, boolean>> => readJson<Partial<Record<PimKind, boolean>>>("pim", {});
export const setPimEnabled = (v: Partial<Record<PimKind, boolean>>): void => writeJson("pim", v);

/** Capacités à déclarer : allumées, permises par iOS, et déjà utilisées par le noyau. */
export function capsToDeclare(enabled: Partial<Record<PimKind, boolean>>, status: Partial<Record<PimKind, PimStatus>>): DeviceCap[] {
  return (Object.keys(CAP) as PimKind[]).filter((k) => LIVE_KINDS.has(k) && enabled[k] && status[k] === "granted").map((k) => CAP[k]);
}

const cut = (v: unknown): unknown => (typeof v === "string" && v.length > DEVICE_NOTES_MAX ? `${v.slice(0, DEVICE_NOTES_MAX - 1)}…` : v);
/** Formes minimales du contrat : 50 éléments, notes coupées, aucun champ en dehors de la liste. */
export function minimal(op: DeviceRequestEvent["op"], items: Record<string, unknown>[]): DeviceItem[] {
  const keep: Record<DeviceRequestEvent["op"], string[]> = {
    "calendar.list": ["title", "start", "end", "all_day", "location", "calendar", "notes"],
    "contacts.search": ["name", "emails", "phones", "org"],
    "reminders.list": ["title", "due", "done", "list", "notes"],
  };
  return items.slice(0, DEVICE_MAX_ITEMS).map((it) => Object.fromEntries(keep[op].filter((k) => k in it).map((k) => [k, k === "notes" ? cut(it[k]) : it[k]]))) as unknown as DeviceItem[];
}

export interface PimAnswer {
  op: DeviceRequestEvent["op"];
  count: number;
  error?: string;
}

/** Répond à une demande du noyau ; rend ce qui a été lu (pour la ligne « Agenda du téléphone lu : 12 événements »). */
export async function answerRequest(client: Pick<NokkerClient, "answerDeviceRequest">, plugin: PimPlugin, deviceId: string, e: DeviceRequestEvent): Promise<PimAnswer> {
  const kind = KIND_OF_CAP[CAP_OF[e.op]];
  if (!LIVE_KINDS.has(kind) || !pimEnabled()[kind]) {
    await client.answerDeviceRequest(e.request_id, { device_id: deviceId, error: "denied" });
    return { op: e.op, count: 0, error: "denied" };
  }
  const r =
    e.op === "calendar.list" ? await plugin.calendarList({ from: e.args.from, to: e.args.to, q: e.args.q })
    : e.op === "contacts.search" ? await plugin.contactsSearch({ q: e.args.q, limit: e.args.limit })
    : await plugin.remindersList({ include_done: e.args.include_done, due_before: e.args.due_before });
  if (r.error || !r.items) {
    const error = r.error ?? "unavailable";
    await client.answerDeviceRequest(e.request_id, { device_id: deviceId, error });
    return { op: e.op, count: 0, error };
  }
  const items = minimal(e.op, r.items);
  await client.answerDeviceRequest(e.request_id, { device_id: deviceId, items });
  return { op: e.op, count: items.length };
}

/** Déclare les capacités de cet appareil (au lancement, et après chaque interrupteur). */
export async function declareCaps(client: Pick<NokkerClient, "putDeviceCaps" | "deleteDeviceCaps">, plugin: PimPlugin, deviceId: string, name: string): Promise<DeviceCap[]> {
  const caps = capsToDeclare(pimEnabled(), await plugin.status());
  if (caps.length) await client.putDeviceCaps(deviceId, { name, platform: nativePlatform() === "android" ? "android" : "ios", caps });
  else await client.deleteDeviceCaps(deviceId).catch(() => undefined);
  return caps;
}
