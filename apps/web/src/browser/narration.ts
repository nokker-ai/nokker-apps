/**
 * Narration vocale de /present (mode démo) : chaque point désigné par Nina est DIT à voix haute avec la voix de la persona
 * (`client.narrationSpeech` → `POST /v1/browser/sessions/{id}/narrations/{seq}/speech/timed`). Le texte voicé est celui que
 * le noyau a émis pour ce point (`why`, repli `label`) : le client n'envoie jamais de texte. Une seule source audio à la
 * fois ; la narration est coupée quand Nina live parle. Route absente ou synthèse éteinte (404/503) : on n'insiste plus,
 * les sous-titres et bulles restent. Autoplay bloqué par le navigateur : un bouton « Activer le son » rejoue.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isTimedSpeech, NokkerApiError, type BrowserPoint, type NokkerClient } from "@nokker-apps/sdk";

export type NarrationPhase = "idle" | "loading" | "speaking";

/** Au plus deux points en attente : si Nina désigne plus vite qu'elle ne parle, on saute les plus anciens. */
export const MAX_QUEUE = 2;

/** Le texte que le noyau a émis pour un point (ce que la voix dit). */
export const narrationText = (p: Pick<BrowserPoint, "why" | "label">): string => (p.why || p.label || "").trim();

/** Les points à dire : pas encore pris, avec un texte, du plus ancien au plus récent, les `max` derniers seulement. */
export function pendingPoints<T extends Pick<BrowserPoint, "seq" | "why" | "label">>(points: readonly T[], taken: ReadonlySet<number>, max = MAX_QUEUE): T[] {
  return points.filter((p) => !taken.has(p.seq) && narrationText(p) !== "").slice(-max);
}

/** MP3 en base64 → Blob (la parole horodatée est rendue en base64). */
export function b64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Blob([out], { type: mime });
}

export interface NarrationView {
  phase: NarrationPhase;
  /** Ce qu'elle dit en ce moment (sous-titre), ou null. */
  text: string | null;
  /** Le navigateur a bloqué la lecture : `unlock()` après un geste. */
  blocked: boolean;
  /** `false` quand la route est absente ou la synthèse éteinte (404/503) : plus de tentatives. `null` : pas encore su. */
  available: boolean | null;
  unlock(): void;
}

export function useNarration(o: { client: NokkerClient; sessionId: string; points: readonly BrowserPoint[]; enabled: boolean; suspended: boolean; lang: string }): NarrationView {
  const [phase, setPhase] = useState<NarrationPhase>("idle");
  const [text, setText] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [tick, setTick] = useState(0);
  const taken = useRef(new Set<number>());
  const busy = useRef(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const cur = useRef(o);
  cur.current = o;

  const stop = useCallback((): void => {
    const a = audio.current;
    audio.current = null;
    if (a) {
      a.onended = null;
      a.onerror = null;
      a.pause();
    }
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    busy.current = false;
    setPhase("idle");
    setText(null);
    setBlocked(false);
  }, []);

  // Nina live parle (ou la narration est coupée) : on se tait tout de suite, sans rejouer plus tard.
  useEffect(() => {
    if (o.suspended) stop();
  }, [o.suspended, stop]);
  useEffect(() => stop, [stop]);

  useEffect(() => {
    if (!o.enabled || o.suspended || busy.current || available === false) return;
    const next = pendingPoints(o.points, taken.current)[0];
    if (!next) return;
    busy.current = true;
    taken.current.add(next.seq); // pris : jamais rejoué, même si la synthèse échoue
    setPhase("loading");
    let gone = false;
    void (async () => {
      try {
        const sp = await cur.current.client.narrationSpeech(cur.current.sessionId, next.seq, { lang: cur.current.lang });
        if (gone || !isTimedSpeech(sp)) throw new Error("parole invalide");
        setAvailable(true);
        const u = URL.createObjectURL(b64ToBlob(sp.audio, sp.mime));
        url.current = u;
        const a = new Audio(u);
        audio.current = a;
        a.onended = () => {
          stop();
          setTick((t) => t + 1); // le suivant
        };
        a.onerror = () => {
          stop();
          setTick((t) => t + 1);
        };
        setText(narrationText(next));
        setPhase("speaking");
        await a.play().catch((e: unknown) => {
          if ((e as { name?: string })?.name === "NotAllowedError") setBlocked(true);
          else throw e;
        });
      } catch (e) {
        if (gone) return;
        if (e instanceof NokkerApiError && (e.status === 404 || e.status === 503)) setAvailable(false);
        stop();
        setTick((t) => t + 1);
      }
    })();
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.points, o.enabled, o.suspended, available, tick]);

  const unlock = useCallback((): void => {
    const a = audio.current;
    if (!a) return;
    void a.play().then(() => setBlocked(false), () => undefined);
  }, []);

  return { phase, text, blocked, available, unlock };
}
