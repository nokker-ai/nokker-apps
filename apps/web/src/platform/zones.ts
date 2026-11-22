/**
 * Zones du membre dans l'app native (LOKKAL-PHONE §4.2, lot P6). Les coordonnées restent dans le plugin natif
 * `NokkerZones` (ios/App/App/NokkerZonesPlugin.swift) ; le noyau ne reçoit que noms, id, scénarios choisis et
 * transitions. Les transitions sont mises en file par l'appareil et envoyées ici quand l'interface tourne : au
 * lancement, au retour au premier plan et à chaque `zoneEvent`. L'envoi immédiat app tuée viendra avec le jeton du nœud
 * téléphone (P7).
 */
import { NokkerApiError, type NokkerClient } from "@nokker-apps/sdk";
import { isNativeShell } from "./native.js";

export interface DeviceZone {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radius: number;
}

export interface QueuedZoneEvent {
  event_id: string;
  zone_id: string;
  event: "enter" | "exit";
  at: string;
}

export type LocationStatus = "not_determined" | "restricted" | "denied" | "when_in_use" | "always" | "unknown";

type Listener = { remove?: () => void };
export interface ZonesPlugin {
  status(): Promise<{ status: LocationStatus; precise?: boolean; monitoring?: boolean }>;
  requestWhenInUse(): Promise<{ status: LocationStatus }>;
  requestAlways(): Promise<{ status: LocationStatus }>;
  list(): Promise<{ zones: DeviceZone[] }>;
  setZones(o: { zones: DeviceZone[] }): Promise<{ count: number }>;
  pick(o: { name: string; radius?: number; lat?: number; lon?: number; ok: string; cancel: string; radiusLabel: string }): Promise<{ lat: number; lon: number; radius: number }>;
  events(): Promise<{ events: QueuedZoneEvent[] }>;
  clearEvents(o: { ids: string[] }): Promise<{ left: number }>;
  addListener?(ev: "zoneEvent", cb: (e: QueuedZoneEvent) => void): Promise<Listener> | Listener;
}

export function zonesPlugin(w: unknown = globalThis): ZonesPlugin | undefined {
  return isNativeShell(w) ? (w as { Capacitor?: { Plugins?: { NokkerZones?: ZonesPlugin } } }).Capacitor?.Plugins?.NokkerZones : undefined;
}

/** Id d'une zone : `zn_` + 10 caractères (le noyau accepte `^zn_[a-z0-9]{6,24}$`). */
export function newZoneId(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  return "zn_" + Array.from(rand(10), (x) => a[x % a.length]).join("");
}

export const MIN_RADIUS = 150;
export const MAX_ZONES = 18;

/** Envoie la file de l'appareil, dans l'ordre. Ce que le noyau a pris ou refuse pour de bon (doublon, ordre, zone
 * inconnue, requête invalide) sort de la file ; une coupure ou une erreur du serveur arrête l'envoi et garde le reste. */
export async function flushZoneEvents(client: Pick<NokkerClient, "postZoneEvent">, plugin: Pick<ZonesPlugin, "events" | "clearEvents">): Promise<{ sent: number; dropped: number; kept: number }> {
  const { events } = await plugin.events();
  const done: string[] = [];
  let sent = 0;
  let dropped = 0;
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    try {
      await client.postZoneEvent(e.zone_id, { event_id: e.event_id, event: e.event, at: e.at });
      sent++;
      done.push(e.event_id);
    } catch (err) {
      if (err instanceof NokkerApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) {
        dropped++;
        done.push(e.event_id);
        continue;
      }
      break; // réseau, 5xx, session : on réessaiera au prochain signal
    }
  }
  if (done.length) await plugin.clearEvents({ ids: done });
  return { sent, dropped, kept: events.length - done.length };
}

/** Synchronisation des transitions : au lancement, au retour au premier plan, sur chaque `zoneEvent`. */
export function watchZoneEvents(client: Pick<NokkerClient, "postZoneEvent">, w: unknown = globalThis): () => void {
  const p = zonesPlugin(w);
  if (!p) return () => undefined;
  let busy = false;
  const flush = (): void => {
    if (busy) return;
    busy = true;
    void flushZoneEvents(client, p)
      .catch(() => undefined)
      .finally(() => (busy = false));
  };
  flush();
  const handles: Listener[] = [];
  let gone = false;
  const keep = (h: unknown): void => void Promise.resolve(h).then((x) => (gone ? (x as Listener)?.remove?.() : handles.push(x as Listener)));
  if (p.addListener) keep(p.addListener("zoneEvent", flush));
  const app = (w as { Capacitor?: { Plugins?: { App?: { addListener?: (ev: string, cb: (e: { isActive?: boolean }) => void) => unknown } } } }).Capacitor?.Plugins?.App;
  if (app?.addListener) keep(app.addListener("appStateChange", (e) => e.isActive === true && flush()));
  return () => {
    gone = true;
    for (const h of handles) h?.remove?.();
  };
}
