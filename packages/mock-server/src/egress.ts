/**
 * Pages par la connexion du téléphone (LOKKAL-PHONE §4.5, lot P11) — faux noyau du contrat (packages/sdk/src/egress.ts).
 *  - PUT/GET /v1/me/egress/hosts : liste d'hôtes de la personne (≤ 50, `exemple.ch` ou `*.exemple.ch`).
 *  - `web_fetch` de démo (« ouvre https://… » dans un fil) : un hôte de la liste + un téléphone `egress` allumé → la page
 *    passe par le téléphone (`trigger: allowlist`) ; un hôte qui refuse (`*.blocked.example.test` → 403,
 *    `*.geo.example.test` → 451) → refus rendu, avec une OFFRE si la personne a un téléphone `egress` allumé. Jamais de
 *    repli automatique.
 *  - POST /v1/threads/{id}/phone-fetch {url, call_id} : le GESTE. Le noyau vérifie l'offre (même fil, même url, pas
 *    encore utilisée), crée un droit signé (`phone_fetch_grant`, 10 min, usage unique) et un tour de la personne
 *    (`origin: "phone_fetch"`) ; seul ce droit met un `fetch.get` explicite en file.
 *  - 30 fetch par heure et par nœud.
 */
import { createHmac, randomBytes } from "node:crypto";
import { EGRESS_MAX_HOSTS, FETCH_PER_HOUR, fetchUrlCheck, hostAllowed, normalizeEgressHost, type FetchGetArgs, type FetchGetResult, type PhoneFetched, type PhoneFetchOffer } from "@nokker-apps/sdk";
import { enqueuePhoneTask, liveEgressNode, phoneMock, waitTask } from "./phone.js";
import type { MockState } from "./state.js";

type Send = (status: number, obj: unknown) => void;

interface Grant {
  id: string;
  user: string;
  thread: string;
  url: string;
  turnId: string;
  exp: number;
  used: boolean;
  sig: string;
}
interface Offer extends PhoneFetchOffer {
  thread: string;
  user: string;
  used: boolean;
  /** Offres en mémoire du noyau, 10 min ; échue = no_offer (contrat d'onboarding). */
  exp: number;
}
interface EgressMock {
  hosts: Map<string, string[]>;
  offers: Map<string, Offer>;
  grants: Map<string, Grant>;
  fetched: Map<string, number[]>;
  key: Buffer;
}
const all = new WeakMap<MockState, EgressMock>();
function em(state: MockState): EgressMock {
  let m = all.get(state);
  if (!m) all.set(state, (m = { hosts: new Map(), offers: new Map(), grants: new Map(), fetched: new Map(), key: randomBytes(32) }));
  return m;
}
const err = (send: Send, status: number, code: string, extra: object = {}): true => (send(status, { error: { code, message: code, ...extra } }), true);

/** Signature du droit par le noyau : HMAC sur {id, url, turn_id, exp} (une valeur modifiée ne vérifie plus). */
const sign = (m: EgressMock, g: Omit<Grant, "sig" | "used">): string => createHmac("sha256", m.key).update(`${g.id}\n${g.url}\n${g.turnId}\n${g.exp}`).digest("base64url");

function underRate(m: EgressMock, machine: string): boolean {
  const now = Date.now();
  const list = (m.fetched.get(machine) ?? []).filter((t) => now - t < 3600_000);
  m.fetched.set(machine, list);
  if (list.length >= FETCH_PER_HOUR) return false;
  list.push(now);
  return true;
}

async function runFetch(state: MockState, user: string, args: FetchGetArgs, origin: { kind: "turn"; thread_id: string }): Promise<PhoneFetched> {
  const m = em(state);
  const host = new URL(args.url).hostname;
  const node = liveEgressNode(state, user);
  if (!node) return { host, ok: false, error: "egress_off" };
  if (!underRate(m, node.id)) return { host, ok: false, error: "rate" };
  const t = await waitTask(enqueuePhoneTask(state, node.id, "fetch.get", args as unknown as Record<string, unknown>, origin), 12_000);
  if (t.status === "done") {
    try {
      const r = JSON.parse(t.result ?? "{}") as FetchGetResult;
      return { host, ok: r.status >= 200 && r.status < 400, status: r.status };
    } catch {
      return { host, ok: false, error: "bad_result" };
    }
  }
  if (t.status === "failed") return { host, ok: false, error: t.error?.code ?? "failed" };
  t.status = "cancelled";
  return { host, ok: false, error: "phone_timeout" };
}

const refusal = (host: string): PhoneFetchOffer["reason"] | null =>
  /(^|\.)blocked\.example\.test$/.test(host) ? "http_403" : /(^|\.)geo\.example\.test$/.test(host) ? "http_451" : null;

/**
 * Tour de démo « ouvre <url> » (tour OUVERT PAR LA PERSONNE seulement : l'appelant ne le passe pas pour un agent ni une
 * continuation). Rend la réponse et les champs du message assistant, ou null si le texte n'est pas une demande de page.
 */
export async function demoWebFetch(state: MockState, user: string, threadId: string, turnId: string, text: string): Promise<{ reply: string; offers?: PhoneFetchOffer[]; fetched?: PhoneFetched[] } | null> {
  const mm = /^\s*(?:ouvre|lis|open|read|fetch)\s+(https?:\/\/\S+?)\s*$/i.exec(text);
  if (!mm) return null;
  const url = mm[1]!;
  const m = em(state);
  const check = fetchUrlCheck(url);
  const host = "host" in check ? check.host : (() => { try { return new URL(url).hostname; } catch { return url; } })();
  const list = m.hosts.get(user) ?? [];
  // (a) Hôte de la liste et téléphone joignable : la page passe par le téléphone, pas par le cloud.
  if ("host" in check && hostAllowed(host, list) && liveEgressNode(state, user)) {
    const f = await runFetch(state, user, { url, trigger: "allowlist", turn_id: turnId, allow_hosts: list }, { kind: "turn", thread_id: threadId });
    return { reply: f.ok ? `(demo) Summary of the page (status ${f.status}).` : `(demo) The page could not be read: ${f.error ?? f.status}.`, fetched: [f] };
  }
  const reason = refusal(host);
  if (!reason) return { reply: `(demo) Page read from the cloud: ${host}.` };
  const code = reason === "http_451" ? "451" : "403";
  // Refus : JAMAIS de repli automatique. Une offre seulement, si un téléphone `egress` est allumé.
  if ("host" in check && liveEgressNode(state, user)) {
    const offer: Offer = { call_id: `call_${randomBytes(6).toString("hex")}`, url, host, reason, thread: threadId, user, used: false, exp: Date.now() + 10 * 60_000 };
    m.offers.set(offer.call_id, offer);
    return { reply: `(demo) ${host} refused access (${code}). You can open it through your phone.`, offers: [{ call_id: offer.call_id, url, host, reason }] };
  }
  return { reply: `(demo) ${host} refused access (${code}).` };
}

export async function handleEgress(state: MockState, user: string, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const m = em(state);
  if (path === "/v1/me/egress/hosts") {
    if (method === "GET") return send(200, { hosts: m.hosts.get(user) ?? [] }), true;
    if (method !== "PUT") return false;
    const b = await readBody();
    if (Object.keys(b).some((k) => k !== "hosts") || !Array.isArray(b.hosts)) return err(send, 400, "bad_hosts");
    if (b.hosts.length > EGRESS_MAX_HOSTS) return err(send, 400, "too_many_hosts");
    const out: string[] = [];
    for (const [i, raw] of b.hosts.entries()) {
      const h = typeof raw === "string" ? normalizeEgressHost(raw) : null;
      if (!h) return err(send, 400, "bad_host", { index: i });
      if (!out.includes(h)) out.push(h);
    }
    m.hosts.set(user, out);
    return send(200, { hosts: out }), true;
  }
  const gm = /^\/v1\/threads\/([^/]+)\/phone-fetch$/.exec(path);
  if (gm && method === "POST") {
    const threadId = decodeURIComponent(gm[1]!);
    const b = await readBody();
    // Fonction éteinte (pas de nœud téléphone pour ce compte) : 404 not_found, comme le noyau.
    if (!phoneMock(state).flags.phone_nodes) return err(send, 404, "not_found");
    const offer = m.offers.get(String(b.call_id ?? ""));
    if (!offer || offer.user !== user || offer.thread !== threadId || offer.url !== b.url || Date.now() > offer.exp) return err(send, 404, "no_offer");
    if (offer.used) return err(send, 410, "offer_used");
    if (!liveEgressNode(state, user)) return err(send, 409, "no_phone_egress");
    offer.used = true;
    const rec = state.threads.get(threadId);
    const turnId = `${threadId}:${rec?.turns.length ?? 0}`;
    const g0 = { id: `pfg_${randomBytes(8).toString("hex")}`, user, thread: threadId, url: offer.url, turnId, exp: Date.now() + 10 * 60_000 };
    const grant: Grant = { ...g0, used: false, sig: sign(m, g0) };
    m.grants.set(grant.id, grant);
    send(202, { turn_id: turnId });
    // Le tour de la personne : le droit est vérifié (signature, échéance, usage unique, même url) AVANT la mise en file.
    void (async () => {
      const ok = grant.sig === sign(m, grant) && !grant.used && Date.now() < grant.exp;
      grant.used = true;
      const f: PhoneFetched = ok ? await runFetch(state, user, { url: offer.url, trigger: "explicit", turn_id: turnId, grant_id: grant.id }, { kind: "turn", thread_id: threadId }) : { host: offer.host, ok: false, error: "grant_invalid" };
      const reply = f.ok ? `(demo) Summary of the page (status ${f.status}).` : `(demo) The page could not be read: ${f.error ?? f.status}.`;
      state.appendTurn(threadId, `Ouvre cette page par mon téléphone : ${offer.url}`, reply, { sender: user, origin: "phone_fetch", phone_fetched: [f] });
      if (rec) state.publish({ type: "thread.updated", thread: { ...rec.thread } });
    })();
    return true;
  }
  return false;
}
