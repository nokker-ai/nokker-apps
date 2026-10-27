/** Écran « Miroir » (LOKKAL §7.23) : libellés et petites règles pures, testées à part. */
import type { LocalMirrorPage, LocalMirrorStatus, MirrorChannel, MirrorChannelState } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";

export function channelLabel(k: MirrorChannel): string {
  switch (k) {
    case "turns_push":
      return tr("Turns sent");
    case "turns_pull":
      return tr("Turns received");
    case "notes":
      return tr("Notes");
    case "team_notes":
      return tr("Team notes");
    case "pages":
      return tr("Pages");
    case "resync":
      return tr("Resynchronisation");
  }
}

export function pageStateLabel(st: LocalMirrorPage["state"]): string {
  switch (st) {
    case "off":
      return tr("on the machine only");
    case "pending":
      return tr("copy pending");
    case "sent":
      return tr("online");
    case "quota":
      return tr("limit reached");
    case "refused":
      return tr("refused");
  }
}

/** Voyant d'un canal : vert si aucun échec, orange sinon (le prochain essai est automatique). */
export const light = (c: MirrorChannelState): "ok" | "retry" => (c.failures === 0 ? "ok" : "retry");

/** Nombre décimal écrit à la manière de la langue de l'interface (virgule en français). */
const decimal = (n: number): string => (shellLang() === "fr" ? String(n).replace(".", ",") : String(n));

export function fmtDuration(s: number): string {
  if (s < 60) return `${Math.max(0, Math.round(s))} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${decimal(Math.round(s / 360) / 10)} h`;
  return tr("{0} d", decimal(Math.round(s / 8640) / 10));
}

export function fmtBytes(n: number): string {
  if (n < 1024) return tr("{0} B", n);
  if (n < 1024 * 1024) return tr("{0} KiB", Math.round(n / 1024));
  return tr("{0} MiB", decimal(Math.round((n / 1048576) * 10) / 10));
}

type PendingKey = keyof NonNullable<LocalMirrorStatus["pending"]>;
const PENDING_KEYS: PendingKey[] = ["turns", "notes", "team_notes", "pages"];

function pendingCount(k: PendingKey, n: number): string {
  const one = n === 1;
  switch (k) {
    case "turns":
      return one ? tr("{0} turn", n) : tr("{0} turns", n);
    case "notes":
      return one ? tr("{0} note", n) : tr("{0} notes", n);
    case "team_notes":
      return one ? tr("{0} team note", n) : tr("{0} team notes", n);
    case "pages":
      return one ? tr("{0} page", n) : tr("{0} pages", n);
  }
}

/** « 3 turns, 1 page » — ce qui attend d'être envoyé. */
export function pendingText(p: LocalMirrorStatus["pending"]): string {
  if (!p) return "";
  return PENDING_KEYS.filter((k) => (p[k] ?? 0) > 0)
    .map((k) => pendingCount(k, p[k] ?? 0))
    .join(", ");
}

/** Ligne de tête : à jour, en retard de N (et quoi), ou rien n'est encore parti. */
export function lagText(st: LocalMirrorStatus): string {
  const what = pendingText(st.pending);
  if (st.behind_s === 0 || !what) return tr("Up to date: nothing is waiting.");
  if (st.behind_s === null || st.behind_s === undefined) return tr("Nothing has left yet ({0} waiting).", what);
  return tr("Behind by {0}: {1} waiting.", fmtDuration(st.behind_s), what);
}

export function fmtAgo(ts: number | null | undefined, now = Date.now() / 1000): string {
  if (!ts) return tr("never");
  return tr("{0} ago", fmtDuration(now - ts));
}
