import { NokkerApiError, type Approval } from "@nokker-apps/sdk";
import type { Lang } from "../onboarding/i18n.js";

/** Taille lisible d'un export (octets → Ko/Mo). */
export function fmtSize(lang: Lang, bytes: number): string {
  const nf = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });
  const unit = lang === "fr" ? { k: "Ko", m: "Mo", b: "o" } : { k: "KB", m: "MB", b: "B" };
  if (bytes >= 1_000_000) return `${nf.format(bytes / 1_000_000)} ${unit.m}`;
  if (bytes >= 1_000) return `${nf.format(bytes / 1_000)} ${unit.k}`;
  return `${bytes} ${unit.b}`;
}

/** Date et heure (Zurich) d'une échéance : le noyau envoie des instants ISO. */
export function fmtWhen(lang: Lang, iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang, { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Zurich" }).format(d);
}

export type ExportIssue = { kind: "limit"; retryAt: string | null } | { kind: "expired" } | { kind: "other" };

/** Échec d'un export : 429 `export_limit` (avec `retry_at`) et 410 `export_expired` ont chacun leur état d'écran. */
export function exportIssue(err: unknown): ExportIssue {
  if (err instanceof NokkerApiError) {
    if (err.status === 429 && err.code === "export_limit") return { kind: "limit", retryAt: err.retryAt ?? null };
    if (err.status === 410 || err.code === "export_expired") return { kind: "expired" };
  }
  return { kind: "other" };
}

/** Nom de l'outil de la carte de suppression posée par `POST /v1/account/delete` (noyau : nokker/account/delete.py). */
export const ACCOUNT_DELETE_TOOL = "account_delete";

/** Carte de suppression accordée par la personne : `executed`, ou `approved` si l'exécution est encore en file après
 * 45 s. Le compte et son locataire sont alors `suspended` : toute requête suivante répond 403. */
export function deletionGranted(a: Pick<Approval, "tool_name" | "status"> | null | undefined): boolean {
  return !!a && a.tool_name === ACCOUNT_DELETE_TOOL && (a.status === "executed" || a.status === "approved");
}

/** Le noyau ne dit pas « suppression en cours » : un compte suspendu répond `403 {error:{message:"forbidden"}}` à
 * tout. Un 403 reçu alors qu'une carte de suppression était en attente vaut donc accord. */
export const suspendedError = (err: unknown): boolean => err instanceof NokkerApiError && err.status === 403;

/** Où en est la carte de suppression : accordée (compte suspendu), toujours en attente, en échec (résiliation impossible, rien de suspendu : on peut réessayer) ou morte (refusée, expirée). */
export function deleteOutcome(status: Approval["status"]): "granted" | "waiting" | "failed" | "dead" {
  if (status === "approved" || status === "executed") return "granted";
  if (status === "pending") return "waiting";
  if (status === "failed") return "failed";
  return "dead";
}

/** Déconnexion de cet appareil : retiré du compte côté serveur (sa clé ne vaut plus rien), puis oublié ici. Hors ligne ou
 * refusé, la clé locale est oubliée quand même : se déconnecter ne doit jamais échouer. */
export async function signOutDevice(
  client: { deleteDevice(id: string): Promise<void> },
  readStored: () => Promise<{ deviceId: string } | undefined>,
  forget: () => Promise<void>,
): Promise<void> {
  const stored = await readStored().catch(() => undefined);
  if (stored?.deviceId) await client.deleteDevice(stored.deviceId).catch(() => undefined);
  await forget().catch(() => undefined);
}
