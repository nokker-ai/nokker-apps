/**
 * Origines de la liste unique (LOKKAL-PHONE §1.2) vues depuis app.nokker.ai ou l'app : le deck (`GET /v1/link/deck`,
 * toutes les 60 s) donne les machines ; pour chaque machine EN LIGNE, un client SDK sur sa passerelle avec un jeton
 * d'accès (`POST /v1/gateway/token {host}`, 900 s, renouvelé à 80 %) lit sa liste de fils (3 s au plus). Le web servi
 * par une machine (Lokkal, passerelle) ne s'en sert pas : il reste la vue de cette machine.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { NokkerApiError, NokkerClient, type DeckMachine, type Thread } from "@nokker-apps/sdk";
import { BRAND } from "@nokker-apps/brand";
import { webSurface } from "../surface.js";
import { CLOUD, machineBase, mergeSearch, originsOf, searchOfflineTitles, withTimeout, type OriginInfo, type OriginSearch, type SearchRow, byNewest } from "./origins.js";

const DECK_MS = 60_000;
const ORIGIN_MS = 3_000;
/** Flux `/v1/events` en direct pour les machines les plus récentes (§1.2 point 6) ; les autres suivent le deck (60 s). */
export const LIVE_MACHINES = 4;

interface Tok {
  client: NokkerClient;
  renewAt: number;
}

export interface Origins {
  machines: DeckMachine[];
  origins: OriginInfo[];
  /** Fils lus sur chaque machine en ligne (absent : pas encore lue, ou pas de réponse). */
  live: Record<string, Thread[] | undefined>;
  search(q: string): Promise<{ rows: SearchRow[]; silent: string[] }>;
  refresh(): void;
  /** Client de la passerelle d'une machine (jeton renouvelé). */
  clientFor(m: DeckMachine): Promise<NokkerClient>;
}

export function useOrigins(cloud: NokkerClient, enabled: boolean): Origins {
  const [machines, setMachines] = useState<DeckMachine[]>([]);
  const [live, setLive] = useState<Record<string, Thread[] | undefined>>({});
  const tokens = useRef(new Map<string, Tok>());
  const [tick, setTick] = useState(0);

  const clientFor = useCallback(
    async (m: DeckMachine): Promise<NokkerClient> => {
      const cur = tokens.current.get(m.machine_id);
      if (cur && Date.now() < cur.renewAt) return cur.client;
      const t = await cloud.gatewayAccessToken(m.host);
      const client = new NokkerClient({ baseUrl: machineBase(m.host), token: t.access_token, userAgent: BRAND.userAgent, surface: webSurface() });
      tokens.current.set(m.machine_id, { client, renewAt: Date.now() + t.expires_in * 800 });
      return client;
    },
    [cloud],
  );

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async (): Promise<void> => {
      let deck;
      try {
        deck = await cloud.getDeck();
      } catch (e) {
        // Pas de deck (fonction absente, compte sans machine) : la liste reste celle du cloud.
        if (alive && e instanceof NokkerApiError) setMachines([]);
        return;
      }
      if (!alive) return;
      const ms = deck.machines.filter((m) => m.host);
      setMachines(ms);
      const got = await Promise.all(
        ms.map(async (m) => {
          if (!m.online) return [m.machine_id, undefined] as const;
          try {
            const c = await clientFor(m);
            return [m.machine_id, await withTimeout(c.listThreads(), ORIGIN_MS)] as const;
          } catch (e) {
            // Machine déliée (jeton refusé) : elle sort de la liste au prochain deck ; sinon on garde son deck.
            if (e instanceof NokkerApiError && (e.status === 401 || e.status === 403)) tokens.current.delete(m.machine_id);
            return [m.machine_id, undefined] as const;
          }
        }),
      );
      if (alive) setLive(Object.fromEntries(got));
    };
    void load();
    const id = setInterval(() => document.visibilityState === "visible" && void load(), DECK_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [cloud, enabled, clientFor, tick]);

  // Les 4 machines en ligne les plus récemment actives : un flux d'événements chacune (états « travaille », titres) ;
  // au-delà, le deck suffit. Seuls `thread.updated` et `thread.deleted` comptent ici.
  const streamed = machines
    .filter((m) => m.online)
    .sort(byNewest((m) => (Array.isArray(m.threads) ? m.threads[0]?.updated_at : undefined)))
    .slice(0, LIVE_MACHINES);
  const streamKey = streamed.map((m) => m.machine_id).join(",");
  useEffect(() => {
    if (!enabled || !streamKey) return;
    let alive = true;
    const subs: Array<{ close(): void }> = [];
    for (const m of streamed) {
      void clientFor(m).then(
        (c) => {
          if (!alive) return;
          subs.push(
            c.subscribeEvents({
              onEvent: (e) => {
                if (e.type === "thread.updated")
                  setLive((cur) => {
                    const list = cur[m.machine_id];
                    if (!list) return cur;
                    const next = list.some((t) => t.id === e.thread.id) ? list.map((t) => (t.id === e.thread.id ? e.thread : t)) : [...list, e.thread];
                    return { ...cur, [m.machine_id]: next };
                  });
                else if (e.type === "thread.deleted") setLive((cur) => (cur[m.machine_id] ? { ...cur, [m.machine_id]: cur[m.machine_id]!.filter((t) => t.id !== e.thread_id) } : cur));
              },
              onError: () => undefined,
            }),
          );
        },
        () => undefined,
      );
    }
    return () => {
      alive = false;
      for (const sub of subs) sub.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, streamKey, clientFor]);

  const search = useCallback(
    async (q: string) => {
      const parts: Array<Promise<OriginSearch>> = [
        withTimeout(cloud.searchThreads(q), ORIGIN_MS).then(
          (r) => ({ origin: CLOUD, name: CLOUD, results: r.results }),
          () => ({ origin: CLOUD, name: CLOUD, failed: true }),
        ),
        ...machines
          .filter((m) => m.online)
          .map((m) =>
            clientFor(m)
              .then((c) => withTimeout(c.searchThreads(q), ORIGIN_MS))
              .then(
                (r) => ({ origin: m.machine_id, name: m.name, results: r.results }),
                () => ({ origin: m.machine_id, name: m.name, failed: true }),
              ),
          ),
      ];
      return mergeSearch([...(await Promise.all(parts)), ...searchOfflineTitles(q, machines)], Object.fromEntries(machines.map((m) => [m.machine_id, m.name])));
    },
    [cloud, machines, clientFor],
  );

  return { machines, origins: originsOf(machines), live, search, refresh: () => setTick((n) => n + 1), clientFor };
}
