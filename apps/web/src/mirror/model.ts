/** Écran « Miroir » (LOKKAL §7.23) : libellés et petites règles pures, testées à part. */
import type { LocalMirrorPage, LocalMirrorStatus, MirrorChannel, MirrorChannelState } from "@nokker-apps/sdk";

export const CHANNEL_LABEL: Record<MirrorChannel, string> = {
  turns_push: "Tours envoyés",
  turns_pull: "Tours reçus",
  notes: "Notes",
  team_notes: "Notes d'équipe",
  pages: "Pages",
  resync: "Resynchronisation",
};

export const PAGE_STATE_LABEL: Record<LocalMirrorPage["state"], string> = {
  off: "sur la machine seulement",
  pending: "copie en attente",
  sent: "en ligne",
  quota: "plafond atteint",
  refused: "refusée",
};

/** Voyant d'un canal : vert si aucun échec, orange sinon (le prochain essai est automatique). */
export const light = (c: MirrorChannelState): "ok" | "retry" => (c.failures === 0 ? "ok" : "retry");

export function fmtDuration(s: number): string {
  if (s < 60) return `${Math.max(0, Math.round(s))} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 360) / 10} h`.replace(".", ",");
  return `${Math.round(s / 8640) / 10} j`.replace(".", ",");
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Kio`;
  return `${(Math.round((n / 1048576) * 10) / 10).toString().replace(".", ",")} Mio`;
}

const PENDING_WORDS: [keyof NonNullable<LocalMirrorStatus["pending"]>, string, string][] = [
  ["turns", "tour", "tours"],
  ["notes", "note", "notes"],
  ["team_notes", "note d'équipe", "notes d'équipe"],
  ["pages", "page", "pages"],
];

/** « 3 tours, 1 page » — ce qui attend d'être envoyé. */
export function pendingText(p: LocalMirrorStatus["pending"]): string {
  if (!p) return "";
  return PENDING_WORDS.filter(([k]) => (p[k] ?? 0) > 0)
    .map(([k, one, many]) => `${p[k]} ${p[k] === 1 ? one : many}`)
    .join(", ");
}

/** Ligne de tête : à jour, en retard de N (et quoi), ou rien n'est encore parti. */
export function lagText(st: LocalMirrorStatus): string {
  const what = pendingText(st.pending);
  if (st.behind_s === 0 || !what) return "À jour : rien n'attend.";
  if (st.behind_s === null || st.behind_s === undefined) return `Rien n'est encore parti (${what} en attente).`;
  return `En retard de ${fmtDuration(st.behind_s)} : ${what} en attente.`;
}

export function fmtAgo(ts: number | null | undefined, now = Date.now() / 1000): string {
  if (!ts) return "jamais";
  return `il y a ${fmtDuration(now - ts)}`;
}
