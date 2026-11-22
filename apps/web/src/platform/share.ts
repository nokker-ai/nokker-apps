/**
 * « Partager vers Nokker » côté interface (LOKKAL-PHONE §4.2.1, lot P5a). L'extension de partage iOS dépose le partage
 * dans la boîte de l'App Group ; le plugin natif `NokkerShare` (App/NokkerSharePlugin.swift) la lit. Chaque partage
 * devient un NOUVEAU fil, avec la pièce dans le composeur : la personne ajoute sa phrase et envoie (rien ne part tout seul
 * vers le modèle). Fonctions pures, plus l'accès au plugin.
 */
import type { PendingImage } from "../composer/images.js";
import { isNativeShell } from "./native.js";

export interface SharedItem {
  kind: "text" | "url" | "image" | "pdf" | (string & {});
  text?: string;
  url?: string;
  name?: string;
  /** Images : `data:image/jpeg;base64,…` (réduite à 2048 px par l'extension). */
  data_url?: string;
}

export interface SharedBatch {
  id: string;
  created_at: string;
  items: SharedItem[];
}

export interface Prefill {
  /** Change à chaque partage : le composeur se remplit une fois par clé. */
  key: string;
  text: string;
  images: PendingImage[];
}

type SharePlugin = { pending(): Promise<{ shares: SharedBatch[]; available?: boolean }>; clear(o: { id: string }): Promise<void> };
const plugin = (w: unknown = globalThis): SharePlugin | undefined =>
  isNativeShell(w) ? (w as { Capacitor?: { Plugins?: { NokkerShare?: SharePlugin } } }).Capacitor?.Plugins?.NokkerShare : undefined;

export async function pendingShares(w: unknown = globalThis): Promise<SharedBatch[]> {
  const p = plugin(w);
  if (!p) return [];
  try {
    return (await p.pending()).shares ?? [];
  } catch {
    return [];
  }
}

/** Événement de la page quand la boîte change (un partage vient d'être repris) : la ligne d'attente se relit. */
export const SHARES_CHANGED = "nokker:shares-changed";

export async function clearShare(id: string, w: unknown = globalThis): Promise<void> {
  await plugin(w)?.clear({ id }).catch(() => undefined);
  (w as { dispatchEvent?: (e: Event) => void }).dispatchEvent?.(new Event(SHARES_CHANGED));
}

const MAX_TITLE = 60;
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

/** Titre du nouveau fil : le nom du PDF, l'hôte de l'adresse, la première ligne du texte, sinon « Partage ». */
export function shareTitle(b: SharedBatch, fallback: string): string {
  const pdf = b.items.find((i) => i.kind === "pdf" && i.name);
  if (pdf?.name) return cut(pdf.name.replace(/\.pdf$/i, ""), MAX_TITLE);
  const url = b.items.find((i) => i.kind === "url" && i.url);
  if (url?.url) return cut(url.name || hostOf(url.url), MAX_TITLE);
  const text = b.items.find((i) => i.kind === "text" && i.text?.trim());
  if (text?.text) return cut(text.text.trim().split(/\n/)[0]!, MAX_TITLE);
  return fallback;
}

/** Ce que le composeur reçoit : texte et adresses à la suite, texte des PDF avec leur nom, images (4 au plus). */
export function sharePrefill(b: SharedBatch, pdfLabel: (name: string) => string): Prefill {
  const parts: string[] = [];
  for (const i of b.items) {
    if (i.kind === "text" && i.text?.trim()) parts.push(i.text.trim());
    else if (i.kind === "url" && i.url) parts.push(i.url);
    else if (i.kind === "pdf") parts.push(`${pdfLabel(i.name || "document.pdf")}\n\n${(i.text ?? "").trim()}`.trim());
  }
  const images: PendingImage[] = b.items
    .filter((i) => i.kind === "image" && i.data_url?.startsWith("data:image/"))
    .slice(0, 4)
    .map((i, n) => ({ id: `${b.id}-${n}`, name: i.name || `image-${n + 1}.jpg`, type: "image/jpeg", size: Math.round(((i.data_url!.length - 23) * 3) / 4), dataUrl: i.data_url! }));
  return { key: b.id, text: parts.join("\n\n"), images };
}

type AppPlugin = { addListener?: (ev: string, cb: (e: { url?: string; isActive?: boolean }) => void) => unknown };
/** Retour au premier plan (`appStateChange` actif) ou ouverture par `nokker://share/<id>` (`appUrlOpen`) : il y a
 * peut-être un partage. Pas de minuterie : la boîte ne se lit que sur ces signaux (et au lancement, par l'appelant). */
export function onShareSignal(cb: () => void, w: unknown = globalThis): () => void {
  const app = isNativeShell(w) ? (w as { Capacitor?: { Plugins?: { App?: AppPlugin } } }).Capacitor?.Plugins?.App : undefined;
  if (!app?.addListener) return () => undefined;
  const handles: unknown[] = [];
  let gone = false;
  const keep = (h: unknown): void => {
    void Promise.resolve(h).then((x) => (gone ? void (x as { remove?: () => void })?.remove?.() : handles.push(x)));
  };
  keep(app.addListener("appUrlOpen", (e) => (e.url ?? "").startsWith("nokker://share") && cb()));
  keep(app.addListener("appStateChange", (e) => e.isActive === true && cb()));
  return () => {
    gone = true;
    for (const h of handles) (h as { remove?: () => void })?.remove?.();
  };
}
