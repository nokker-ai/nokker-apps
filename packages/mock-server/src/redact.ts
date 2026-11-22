/**
 * Masquage sur l'appareil (LOKKAL-PHONE §4.3.2, lot P9b) — faux noyau :
 *  - GET /v1/redact/rules : les motifs publiés (ici la copie du SDK, qui suit ceux du noyau), avec ETag ;
 *  - métadonnées `redaction` du message et des pièces (compteurs par code, jamais de valeur) ;
 *  - garde `masked_value` : un outil à effet externe dont les arguments portent un marqueur ⟦CODE-n⟧ ne s'exécute pas ;
 *  - démo : la réponse recopie les marqueurs reçus (pour l'essai du démasquage à l'affichage) et cite un marqueur qu'un
 *    TIERS aurait écrit (⟦IBAN-9⟧, jamais émis par l'appareil) : il doit rester masqué.
 */
import { createHash } from "node:crypto";
import { MARKER_RE, REDACT_CODE, REDACT_RULES_SNAPSHOT, type RedactionMeta } from "@nokker-apps/sdk";

const ETAG = `"${createHash("sha256").update(JSON.stringify(REDACT_RULES_SNAPSHOT)).digest("hex").slice(0, 16)}"`;
const CODES = new Set(Object.values(REDACT_CODE));

export function handleRedactRules(method: string, path: string, ifNoneMatch: string | undefined, send: (status: number, obj: unknown, headers?: Record<string, string>) => void): boolean {
  if (method !== "GET" || path !== "/v1/redact/rules") return false;
  if (ifNoneMatch === ETAG) return send(304, null, { ETag: ETAG }), true;
  send(200, REDACT_RULES_SNAPSHOT, { ETag: ETAG, "Cache-Control": "private, max-age=86400" });
  return true;
}

/** Métadonnées reçues → forme propre (codes connus, entiers 1..200), ou undefined. */
export function cleanRedaction(raw: unknown): RedactionMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { rules_version?: unknown; counts?: unknown };
  if (typeof r.rules_version !== "string" || !r.counts || typeof r.counts !== "object") return undefined;
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.counts as Record<string, unknown>)) if (CODES.has(k) && Number.isInteger(v) && (v as number) > 0 && (v as number) <= 200) counts[k] = v as number;
  return Object.keys(counts).length ? { rules_version: r.rules_version.slice(0, 40), counts } : undefined;
}

/** Fusion des compteurs du message et de ses pièces. */
export function mergeRedaction(list: Array<RedactionMeta | undefined>): RedactionMeta | undefined {
  const got = list.filter((x): x is RedactionMeta => !!x);
  if (!got.length) return undefined;
  const counts: Record<string, number> = {};
  for (const g of got) for (const [k, v] of Object.entries(g.counts)) counts[k] = (counts[k] ?? 0) + (v ?? 0);
  return { rules_version: got[0]!.rules_version, counts };
}

export const markersIn = (text: string): string[] => [...new Set([...text.matchAll(MARKER_RE)].map((m) => m[0]))];

/** Résultat d'outil refusé par la garde, vu par le modèle — texte EXACT figé à la relecture des textes (06.11). */
export const maskedValueResult = (tool: string, markers: string[]): string =>
  `masked_value : ${tool} reçoit une valeur masquée sur l'appareil de la personne (${markers.join(", ")}) ; rien n'a été fait ; si cette valeur est nécessaire, demande-lui de la donner en clair.`;

/** Persistance hors du fil (noyau : nokker/tools/effects.py::persists_beyond_thread) : tout WRITE sauf `delegate`, plus
 * `session_send` et `agent_draft`. `todo` et `delegate` restent dans le fil : autorisés. */
export const PERSIST_TOOLS = ["memory_write", "write_file", "mail_draft", "calendar_create", "kanban_create_task", "session_send", "agent_draft"] as const;
/** Saisie dans une page ou un service tiers (noyau : third_party_input) : refus d'ENVOI. */
export const THIRD_PARTY_INPUT = ["browser_type", "browser_fill", "browser_fill_form", "browser_select_option", "browser_press_key", "browser_evaluate", "browser_click", "sites_connect"] as const;

/** Résultat d'outil refusé parce qu'il garderait un marqueur au-delà du fil — texte EXACT figé à la relecture des textes (PERSIST_REFUSAL). */
export const maskedPersistResult = (tool: string, markers: string[]): string =>
  `masked_value : ${tool} garderait une valeur masquée sur l'appareil de la personne (${markers.join(", ")}) au-delà de ce fil ; rien n'a été enregistré ; si cette valeur doit être retenue, demande-lui de la donner en clair.`;

/**
 * Démo : quel outil la demande viserait, et quelle garde s'applique, dans l'ORDRE du noyau (guard.py::refusal) :
 * saisie chez un tiers → REFUSAL ; persistance → PERSIST ; envoi → REFUSAL. null : rien à refuser (todo, lecture…).
 */
export function guardFor(text: string, sends: boolean): { tool: string; kind: "refusal" | "persist" } | null {
  const n = text.toLowerCase();
  if (/(remplis|saisis|tape|fill|type)\b.*\b(page|formulaire|form|site)/.test(n)) return { tool: "browser_fill", kind: "refusal" };
  if (/(retiens|souviens|mémorise|memorise|remember)/.test(n)) return { tool: "memory_write", kind: "persist" };
  if (/(brouillon|draft)/.test(n)) return { tool: "mail_draft", kind: "persist" };
  if (/(agenda|rendez-vous|calendar)/.test(n)) return { tool: "calendar_create", kind: "persist" };
  if (/(kanban|carte du tableau)/.test(n)) return { tool: "kanban_create_task", kind: "persist" };
  if (/(fichier|file|notes?)\b/.test(n)) return { tool: "write_file", kind: "persist" };
  if (/(à la session|to the session|session_send)/.test(n)) return { tool: "session_send", kind: "persist" };
  if (sends) return { tool: "send_email_bulk", kind: "refusal" };
  return null;
}
