import type { Key } from "../onboarding/i18n.js";

/** Au-delà, la passerelle est donnée pour hors ligne (le relais repasse bien plus souvent qu'une fois par 5 min). */
export const ONLINE_WINDOW_S = 300;

export interface SeenLabel {
  key: Key;
  vars: Record<string, string>;
  online: boolean;
}

/** Libellé du dernier contact du relais : « en ligne », « vue il y a 3 h », « jamais vue ». */
export function seenLabel(lastSeenAt: number | null, nowS: number): SeenLabel {
  if (lastSeenAt === null) return { key: "mcSeenNever", vars: {}, online: false };
  const ago = Math.max(0, nowS - lastSeenAt);
  if (ago < ONLINE_WINDOW_S) return { key: "mcOnline", vars: {}, online: true };
  if (ago < 3600) return { key: "mcSeenMin", vars: { n: String(Math.floor(ago / 60)) }, online: false };
  if (ago < 86400) return { key: "mcSeenHours", vars: { n: String(Math.floor(ago / 3600)) }, online: false };
  return { key: "mcSeenDays", vars: { n: String(Math.floor(ago / 86400)) }, online: false };
}

/** Date de liaison, courte, dans la langue de l'interface. */
export function linkedOn(createdAt: number, lang: "fr" | "en"): string {
  return new Date(createdAt * 1000).toLocaleDateString(lang === "en" ? "en-GB" : "fr-CH", { day: "numeric", month: "long", year: "numeric" });
}

/** Seule une passerelle `https://<nom>.nokker.app` (ou l'hôte factice du mock) devient un lien cliquable. */
export function gatewayHref(host: string): string | null {
  return /^[a-z0-9-]+\.(nokker\.app|gw\.example\.test)$/.test(host) ? `https://${host}` : null;
}
