/**
 * `target` d'une carte d'approbation, comme le noyau le sert (beta-core 3509c9bb, docs/CLIENT-API.md) : ce que l'outil va toucher,
 * lisible, à montrer À LA PLACE de `arguments`. Commande (`terminal`), chemin (`write_file`, `patch`, `read_file`), adresse (`web_fetch`,
 * `browser_navigate`), « destinataire \u2014 sujet » (envois), « domaine.service \u2014 entit\u00e9 » (`maison_action_forte`). NFC, sans retour
 * \u00e0 la ligne ni caract\u00e8re de contr\u00f4le, 200 caract\u00e8res au plus ; ABSENTE (jamais null) pour un outil sans cible connue. Calcul\u00e9e \u00e0 la
 * cr\u00e9ation de la carte puis fig\u00e9e c\u00f4t\u00e9 noyau ; ici, \u00e0 chaque lecture (m\u00eames arguments, m\u00eame r\u00e9sultat).
 */
import type { Approval } from "@nokker-apps/sdk";

const MAX = 200;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function approvalTargetOf(tool: string, args: Record<string, unknown>): string {
  let t = "";
  if (/^(?:terminal|shell|bash|exec|run_command)$/.test(tool)) t = str(args.command);
  else if (/^(?:write_file|patch|edit|read_file|delete_file|rm)$/.test(tool)) t = str(args.path) || str(args.file_path);
  else if (/^(?:web_fetch|fetch|browser_navigate|page_publish|browser_submit)$/.test(tool)) t = str(args.url);
  else if (/^(?:send_email_bulk|mail_send|send_email)$/.test(tool)) t = [str(args.to), str(args.subject)].filter(Boolean).join(" \u2014 ");
  else if (tool === "maison_action_forte") t = [[str(args.domain), str(args.service)].filter(Boolean).join("."), str(args.entity)].filter(Boolean).join(" \u2014 ");
  // NFC, un retour \u00e0 la ligne ou un caract\u00e8re de contr\u00f4le devient une espace, 200 caract\u00e8res VISIBLES au plus
  t = t.normalize("NFC").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim();
  return [...t].slice(0, MAX).join("");
}

/** La carte telle que le noyau la sert : `target` seulement quand l'outil en a une (cl\u00e9 absente sinon, jamais null). */
export function withTarget<T extends Approval>(a: T): T {
  const target = approvalTargetOf(a.tool_name, a.arguments ?? {});
  if (!target) {
    if (!("target" in a)) return a;
    const { target: _t, ...rest } = a as T & { target?: string };
    void _t;
    return rest as T;
  }
  return { ...a, target };
}
