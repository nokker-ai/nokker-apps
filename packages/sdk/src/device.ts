/**
 * Données du téléphone à la demande (nokker docs/LOKKAL-PHONE.md §4.3, lot P8 ; contrat accepté par dev le 06.11) :
 * agenda, contacts, rappels, EN LECTURE. Elles restent sur l'appareil ; le noyau les demande pendant un tour par le flux
 * `/v1/events` de l'app du membre (`device.request`, 20 s), l'app répond par `POST …/result`. Côté modèle, l'appareil
 * est une SOURCE des familles existantes (agendas de 068, contacts_search, tasks_list) ; chaque champ texte est clôturé
 * comme un contenu de tiers. En P7, la file du nœud téléphone remplace ce transport (mêmes op, mêmes formes).
 *
 *   PUT    /v1/me/devices/{device_id}/caps {name, platform, caps}  → 200
 *   GET    /v1/me/devices/{device_id}/caps                         → {name, platform, caps}
 *   DELETE /v1/me/devices/{device_id}/caps                         → 204
 *   événement device.request {request_id, op, args, expires_at}
 *   POST   /v1/me/device-requests/{request_id}/result {device_id, items} | {device_id, error}
 *          → 204 ; 409 already_answered ; 410 expirée ; 403 pas au membre
 */

export type DeviceCap = "calendar.read" | "contacts.read" | "reminders.read";
export type DeviceOp = "calendar.list" | "contacts.search" | "reminders.list";

export const DEVICE_MAX_ITEMS = 50;
export const DEVICE_NOTES_MAX = 300;
export const DEVICE_CALENDAR_MAX_DAYS = 31;
export const DEVICE_CONTACTS_MAX = 10;

export interface DeviceCaps {
  name: string;
  platform: "ios" | "android";
  caps: DeviceCap[];
}

export interface DeviceRequestEvent {
  type: "device.request";
  request_id: string;
  op: DeviceOp;
  args: { from?: string; to?: string; q?: string; limit?: number; include_done?: boolean; due_before?: string };
  expires_at: string;
}

export interface DeviceCalendarItem {
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location?: string;
  calendar: string;
  notes?: string;
}

export interface DeviceContactItem {
  name: string;
  emails: string[];
  phones: string[];
  org?: string;
}

export interface DeviceReminderItem {
  title: string;
  due?: string;
  done: boolean;
  list: string;
  notes?: string;
}

export type DeviceItem = DeviceCalendarItem | DeviceContactItem | DeviceReminderItem;
export type DeviceError = "denied" | "unavailable" | "too_large";

export const CAP_OF: Record<DeviceOp, DeviceCap> = {
  "calendar.list": "calendar.read",
  "contacts.search": "contacts.read",
  "reminders.list": "reminders.read",
};
