/**
 * /present SANS identifiant (mode démo, TV en kiosque) : suit la session navigateur EN COURS du titulaire. Attente tant
 * qu'aucune n'est active ; bascule sur la plus récente quand Nina ouvre le navigateur ; retour à l'attente un peu après la
 * fin. Sources, sans route nouvelle : les `browser.*` de /v1/events (une nouvelle session se révèle à son premier événement)
 * et, à l'ouverture de la page et toutes les 45 s tant qu'on attend, les bulles « navigateur » encore actives des fils
 * récents (état de session déjà publié par le noyau). Une route de liste dédiée remplacerait ce balayage.
 */
import { useEffect, useRef, useState } from "react";
import type { Bubble, BrowserEvent, NokkerClient } from "@nokker-apps/sdk";
import { useStore } from "../context.js";

export interface Seen {
  /** Dernier signe de vie (ms). */
  last: number;
  ended: boolean;
}

/** On garde l'écran de la session finie un moment (« Terminé »), puis retour à l'attente. */
export const HOLD_MS = 6000;
/** Fils récents balayés pour retrouver une session déjà en cours à l'ouverture. */
export const SCAN_THREADS = 12;
export const RESCAN_MS = 45_000;

/** Note un signe de vie ou la fin d'une session ; ne rouvre jamais une session finie sur un événement en retard. */
export function noteSeen(seen: ReadonlyMap<string, Seen>, id: string, ended: boolean, at: number): Map<string, Seen> {
  const next = new Map(seen);
  const cur = next.get(id);
  if (ended) next.set(id, { last: Math.max(at, cur?.last ?? 0), ended: true });
  else if (!cur?.ended) next.set(id, { last: Math.max(at, cur?.last ?? 0), ended: false });
  return next;
}

/** La session à montrer : la plus récente qui n'est pas finie ; null = attente. */
export function pickActive(seen: ReadonlyMap<string, Seen>): string | null {
  let best: string | null = null;
  let t = -1;
  for (const [id, s] of seen) if (!s.ended && s.last >= t) ((best = id), (t = s.last));
  return best;
}

/** Sessions navigateur encore actives d'après les bulles des fils récents (au plus `SCAN_THREADS`). */
export async function scanActive(client: NokkerClient): Promise<{ id: string; at: number }[]> {
  const out: { id: string; at: number }[] = [];
  try {
    const threads = (await client.listThreads()).slice(0, SCAN_THREADS);
    for (const t of threads) {
      const bubbles: Bubble[] = await client.listBubbles(t.id).catch(() => []);
      for (const b of bubbles) {
        if (b.kind !== "browser" || b.closed_at) continue;
        const st = b.state as { session_id?: unknown; state?: unknown };
        if (typeof st.session_id !== "string" || st.state === "ended") continue;
        out.push({ id: st.session_id, at: Date.parse(b.updated_at) || Date.now() });
      }
    }
  } catch {
    /* pas de liste : on attend les événements */
  }
  return out;
}

/** L'identifiant de la session à afficher (null = écran d'attente), avec la tenue de la fin. */
export function useFollow(): string | null {
  const store = useStore();
  const [seen, setSeen] = useState<ReadonlyMap<string, Seen>>(new Map());
  const [shown, setShown] = useState<string | null>(null);
  const timer = useRef(0);
  const picked = pickActive(seen);

  useEffect(() => {
    let dead = false;
    const scan = (): void => {
      void scanActive(store.client).then((found) => {
        if (dead || !found.length) return;
        setSeen((m) => found.reduce((acc, f) => noteSeen(acc, f.id, false, f.at), m));
      });
    };
    scan();
    const off = store.onCodeEvent((e) => {
      if (!e.type.startsWith("browser.")) return;
      const id = (e as BrowserEvent & { session_id?: string }).session_id;
      if (typeof id === "string") setSeen((m) => noteSeen(m, id, e.type === "browser.ended", Date.now()));
    });
    const iv = window.setInterval(scan, RESCAN_MS);
    return () => {
      dead = true;
      off();
      window.clearInterval(iv);
    };
  }, [store]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (picked) {
      setShown(picked);
      return;
    }
    timer.current = window.setTimeout(() => setShown(null), HOLD_MS);
    return () => window.clearTimeout(timer.current);
  }, [picked]);

  return shown;
}
