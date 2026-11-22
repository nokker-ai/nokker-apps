/**
 * État d'une session navigateur (V3, BROWSER-LIVE v3) côté interface : lu par `GET /v1/browser/sessions/{id}` à
 * l'ouverture (et quand une capture a expiré, 410), puis tenu à jour par les `browser.*` du flux `/v1/events`.
 */
import { useCallback, useEffect, useState } from "react";
import { applyBrowserEvent, browserLiveFromView, emptyBrowserLive, type Approval, type BrowserEvent, type BrowserLive } from "@nokker-apps/sdk";
import { useStore } from "../context.js";

/** Cartes nées de cette session (`context.browser.session_id`) : id → `seq` de la frame où elles s'ancrent. */
export type BrowserCards = { id: string; seq: number; reason: string; pending: boolean; at: string }[];

const cardOf = (a: Approval, sessionId: string): BrowserCards[number] | null =>
  a.context?.browser?.session_id === sessionId ? { id: a.id, seq: a.context.browser.seq, reason: a.reason, pending: a.status === "pending", at: a.created_at } : null;

export function useBrowserLive(sessionId: string): { live: BrowserLive; cards: BrowserCards; reload: () => void; resume: () => Promise<void> } {
  const store = useStore();
  const [live, setLive] = useState<BrowserLive>(() => emptyBrowserLive(sessionId));
  const [cards, setCards] = useState<BrowserCards>([]);
  const addCard = useCallback((c: BrowserCards[number] | null) => {
    if (c) setCards((l) => (l.some((x) => x.id === c.id) ? l : [...l, c]));
  }, []);
  const reload = useCallback(() => {
    void store.client.getBrowserSession(sessionId).then(
      (v) => setLive((prev) => browserLiveFromView(sessionId, v, prev)),
      () => undefined,
    );
  }, [store.client, sessionId]);
  useEffect(() => {
    reload();
    void store.client.listApprovals().then((l) => l.forEach((a) => addCard(cardOf(a, sessionId))), () => undefined);
    return store.onCodeEvent((e) => {
      if (e.type === "approval.requested") return addCard(cardOf(e.approval, sessionId));
      if (e.type === "approval.decided") return setCards((l) => l.map((c) => (c.id === e.approval_id ? { ...c, pending: false } : c)));
      if (!e.type.startsWith("browser.")) return;
      setLive((s) => applyBrowserEvent(s, e as BrowserEvent));
    });
  }, [reload, store, addCard, sessionId]);
  const resume = useCallback(async () => {
    const r = await store.client.resumeBrowserSession(sessionId);
    if (r.state !== "handoff") setLive((s) => (s.status === "handoff" ? { ...s, status: r.state, handoff: null } : s));
  }, [store.client, sessionId]);
  return { live, cards, reload, resume };
}
