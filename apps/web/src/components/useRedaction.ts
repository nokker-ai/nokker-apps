/**
 * Masquage dans le composeur (P9b), app native seulement (plugin NokkerVault) :
 *  - pièces texte (OCR, transcription, dictée) : masquées PAR DÉFAUT, la personne peut laisser une valeur en clair ;
 *  - message tapé : masquage seulement PROPOSÉ (décision de dev : masquer d'office bloquerait une action voulue) ;
 *  - les nouvelles paires attendent l'envoi réussi pour entrer dans le Vault du fil (un envoi raté n'émet rien).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { findSensitive, maskText, type NokkerClient, type RedactDict, type RedactionMeta, type RedactSpan, type TextAttachment } from "@nokker-apps/sdk";
import { isNativeShell } from "../platform/native.js";
import { loadRedactRules, redactKinds, redactRules, vaultPlugin } from "../platform/vault.js";

/**
 * `web` : web pur, hors coque (pas de texte produit sur l'appareil) ; `ready` : Vault présent et règles acceptées par le
 * natif ; `pending` : en cours ; `unavailable` : coque SANS Vault, ou règles refusées → FAIL-CLOSED : les pièces OCR/STT
 * et la dictée ne partent pas (jamais en clair).
 */
export type RedactionMode = "web" | "pending" | "ready" | "unavailable";
export function redactionMode(native: boolean, hasVault: boolean, rules: boolean | null): RedactionMode {
  if (!native) return "web";
  if (!hasVault || rules === false) return "unavailable";
  return rules ? "ready" : "pending";
}

export interface Redaction {
  active: boolean;
  mode: RedactionMode;
  dict: RedactDict;
  find(text: string): RedactSpan[];
  /** Pièce masquée, ou `null` si le masquage est indisponible dans la coque (fail-closed : rien n'est joint). */
  maskAttachment(a: TextAttachment, keep: ReadonlySet<string>): Promise<TextAttachment | null>;
  maskTyped(text: string): { text: string; meta: RedactionMeta };
  /** Après un envoi réussi : les paires en attente entrent dans le Vault du fil. */
  commit(): Promise<void>;
}

export function useRedaction(client: Pick<NokkerClient, "getRedactRules"> | undefined, threadId: string | null): Redaction {
  const vault = vaultPlugin();
  const [dict, setDict] = useState<RedactDict>({});
  const native = isNativeShell();
  const [rulesOk, setRulesOk] = useState<boolean | null>(null);
  const ready = useRef<Promise<boolean> | null>(null);
  const pending = useRef<RedactDict>({});
  useEffect(() => {
    if (!native) return;
    if (!vault) return setRulesOk(false);
    if (!client) return;
    ready.current = loadRedactRules(client, vault);
    void ready.current.then(setRulesOk);
  }, [native, vault, client]);
  const mode = redactionMode(native, !!vault, rulesOk);
  useEffect(() => {
    pending.current = {};
    setDict({});
    if (!vault || !threadId) return;
    let alive = true;
    void vault.get({ thread: threadId }).then((r) => alive && setDict(r.pairs ?? {}), () => undefined);
    return () => {
      alive = false;
    };
  }, [vault, threadId]);
  // Le fil peut recevoir des paires du nœud (résultats masqués) : on relit au retour sur l'app.
  useEffect(() => {
    if (!vault || !threadId) return;
    const h = (): void => void (document.visibilityState === "visible" && vault.get({ thread: threadId }).then((r) => setDict(r.pairs ?? {}), () => undefined));
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  }, [vault, threadId]);

  const active = mode === "ready" && !!threadId;
  const find = useCallback((text: string) => (active && text ? findSensitive(text, redactRules().rules, redactKinds()) : []), [active]);
  const work = (): RedactDict => ({ ...dict, ...pending.current });
  const maskAttachment = async (a: TextAttachment, keep: ReadonlySet<string>): Promise<TextAttachment | null> => {
    if (mode === "web") return a;
    // Dans la coque : on attend les règles du natif ; sans elles, on refuse (jamais en clair).
    const ok = mode === "ready" || (mode === "pending" && (await (ready.current ?? Promise.resolve(false))));
    if (!ok || !vault) return null;
    const m = maskText(a.text, redactRules(), work(), { kinds: redactKinds(), keep });
    Object.assign(pending.current, m.added);
    return m.spans.length ? { ...a, text: m.text, redaction: m.meta } : a;
  };
  const maskTyped = (text: string): { text: string; meta: RedactionMeta } => {
    const m = maskText(text, redactRules(), work(), { kinds: redactKinds() });
    Object.assign(pending.current, m.added);
    return { text: m.text, meta: m.meta };
  };
  const commit = async (): Promise<void> => {
    const add = pending.current;
    pending.current = {};
    if (!vault || !threadId || !Object.keys(add).length) return;
    await vault.put({ thread: threadId, pairs: add }).catch(() => undefined);
    setDict((d) => ({ ...add, ...d }));
  };
  return { active, mode, dict, find, maskAttachment, maskTyped, commit };
}
