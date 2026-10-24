/**
 * Abonnement à `/v1/events` (CLIENT-API.md) avec reconnexion automatique (backoff exponentiel +
 * jitter). Pas de `EventSource` : on pilote `fetch` directement pour pouvoir fixer l'en-tête
 * `Authorization` (EventSource ne le permet pas nativement) et pour rester portable Node/RN.
 *
 * Le contrat ne documente ni curseur ni `Last-Event-ID` pour `/v1/events` : une reconnexion
 * ré-ouvre le flux depuis "maintenant" côté serveur. C'est un TROU DE CONTRAT à combler côté
 * serveur réel (rejouer les événements manqués pendant la coupure) — noté aussi dans
 * `docs/ARCHITECTURE.md`. En attendant, un client qui reconnecte peut manquer des événements
 * émis pendant la coupure ; il doit donc re-tirer l'état (ex. `GET /v1/approvals?status=pending`)
 * après une reconnexion, ce que `subscribeEvents` signale via `onReconnected`.
 */
import type { NokkerEvent } from "./types.js";
import { decodeUtf8Stream, parseJsonData, parseSSEFrames } from "./sse.js";

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

/** Sous-ensemble de `RequestInit`/`Response` qu'on utilise réellement — évite de dépendre des
 * types `lib.dom` globaux (absents sous Node sans `--experimental-fetch` ancien, absents sous RN
 * sans polyfill) : n'importe quelle implémentation `fetch`-compatible convient. */
export interface RequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  body?: string;
  /** Bun : `false` désactive le délai d'inactivité de fetch (5 min par défaut) — indispensable pour un flux SSE ou un tour
   * qui attend une approbation. Ignoré par les autres implémentations. */
  timeout?: false;
}

export interface ResponseLike {
  ok: boolean;
  status: number;
  body: AsyncIterableBytes | null;
}

/** Un corps de réponse qu'on peut lire soit comme flux (ReadableStream-like), soit déjà itérable. */
export type AsyncIterableBytes =
  | AsyncIterable<Uint8Array>
  | { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } };

function toAsyncIterable(body: AsyncIterableBytes): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    return body as AsyncIterable<Uint8Array>;
  }
  const streamLike = body as { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } };
  return {
    async *[Symbol.asyncIterator]() {
      const reader = streamLike.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value) yield value;
        }
      } finally {
        // best effort : certaines implémentations n'ont pas `releaseLock`/`cancel`.
      }
    },
  };
}

export interface BackoffPolicy {
  initialMs: number;
  maxMs: number;
  factor: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { initialMs: 500, maxMs: 15_000, factor: 2 };

export interface SubscribeEventsOptions {
  baseUrl: string;
  token: string;
  fetchImpl: FetchLike;
  onEvent: (event: NokkerEvent) => void;
  /** Appelé après une reconnexion réussie (événements potentiellement manqués, voir doc du module). */
  onReconnected?: () => void;
  /** Appelé à CHAQUE connexion établie (la première comprise) — utile pour ne pas lancer un tour avant l'abonnement. */
  onConnected?: () => void;
  onError?: (err: unknown) => void;
  backoff?: BackoffPolicy;
  /** Plafond de tentatives avant abandon (par défaut infini — on ne lâche jamais `/v1/events`). */
  maxAttempts?: number;
}

export interface EventSubscription {
  close(): void;
}

function nextDelay(attempt: number, policy: BackoffPolicy): number {
  const base = Math.min(policy.maxMs, policy.initialMs * Math.pow(policy.factor, attempt));
  const jitter = base * (0.8 + Math.random() * 0.4); // ±20%
  return Math.round(Math.min(policy.maxMs, jitter));
}

/** Le noyau met le type dans la ligne `event:` (pas dans `data`) ; le mock historique le mettait dans
 * `data.type`. On accepte les deux : `data.type` s'il existe, sinon le nom d'événement SSE. */
export function toNokkerEvent(frameEvent: string | undefined, value: unknown): NokkerEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const type = typeof v.type === "string" ? v.type : frameEvent;
  if (!type) return null;
  return { ...v, type } as unknown as NokkerEvent;
}

export function subscribeEvents(opts: SubscribeEventsOptions): EventSubscription {
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  const controller = new AbortController();
  let closed = false;
  let attempt = 0;
  let everConnected = false;
  /** Dernier `id:` reçu — reposé en `Last-Event-ID` à la reconnexion : le noyau rejoue la fenêtre manquée. */
  let lastEventId: string | undefined;

  async function run(): Promise<void> {
    while (!closed) {
      try {
        const res = await opts.fetchImpl(`${opts.baseUrl}/v1/events`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${opts.token}`,
            Accept: "text/event-stream",
            ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
          },
          signal: controller.signal,
          timeout: false,
        });
        if (!res.ok || !res.body) {
          throw new Error(`/v1/events a répondu ${res.status}`);
        }
        if (everConnected) opts.onReconnected?.();
        opts.onConnected?.();
        everConnected = true;
        attempt = 0; // connexion établie : on repart de zéro au prochain incident.

        const text = decodeUtf8Stream(toAsyncIterable(res.body));
        for await (const frame of parseSSEFrames(text)) {
          if (closed) return;
          if (frame.id !== undefined) lastEventId = frame.id;
          const event = toNokkerEvent(frame.event, parseJsonData<unknown>(frame));
          if (event) opts.onEvent(event);
        }
        // Flux terminé proprement côté serveur (rare pour un SSE long-lived) : on reconnecte quand
        // même, c'est une coupure comme une autre du point de vue du client.
        if (closed) return;
        throw new Error("/v1/events s'est terminé sans erreur — reconnexion");
      } catch (err) {
        if (closed) return;
        opts.onError?.(err);
        attempt += 1;
        if (opts.maxAttempts !== undefined && attempt > opts.maxAttempts) {
          closed = true;
          return;
        }
        const delay = nextDelay(attempt - 1, backoff);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  void run();

  return {
    close() {
      if (closed) return;
      closed = true;
      controller.abort();
    },
  };
}
