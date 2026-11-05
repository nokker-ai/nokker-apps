/**
 * « Ta carte » (own_card, Lokkal) — mock of core docs/PAY-AGENT.md §11 (`MOCK_PAY_AGENT=own_card`, with
 * `MOCK_PAYMENTS=1`): the person's card kept by the local payment agent (here: in memory, never logged), the CVV mode,
 * and the passkeys of THIS machine (rpId localhost). The card number never comes back: brand, last four, expiry only.
 *
 * `localPasskeys` is exported: the local decision's mock (`GET /v1/local/passkeys`, challenge, decision) reads the same
 * array, so a passkey made here is the one that signs there.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { LocalPasskey, OwnCard } from "@nokker-apps/sdk";
import { ownCardPrompt } from "./payments.js";
import type { MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;

/** Passkeys of this machine (shared with the local decision's mock). */
export const localPasskeys: LocalPasskey[] = [];

interface OwnState {
  card: OwnCard | null;
  pendingChallenges: Map<string, number>;
}
const all = new WeakMap<MockState, OwnState>();
const own = (state: MockState): OwnState => {
  let x = all.get(state);
  if (!x) {
    localPasskeys.length = 0; // a fresh mock: no passkey yet
    all.set(state, (x = { card: null, pendingChallenges: new Map() }));
  }
  return x;
};
const nowS = (): number => Date.now() / 1000;
const b64url = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const err = (send: Send, status: number, code: string, message: string): true => (send(status, { error: { code, message } }), true);

export function luhnOk(pan: string): boolean {
  let total = 0;
  for (let i = 0; i < pan.length; i++) {
    let d = Number(pan[pan.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    total += d;
  }
  return total % 10 === 0;
}

export function brandOf(pan: string): string {
  if (pan.startsWith("4")) return "visa";
  if (/^(5[1-5]|2[2-7])/.test(pan)) return "mastercard";
  if (/^3[47]/.test(pan)) return "amex";
  return "card";
}

/** `/v1/payments/method*` (own_card) and `/v1/local/passkeys*`. Returns false when it is not its route. */
export async function handleOwnCard(state: MockState, method: string, url: URL, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  if (state.payAgent !== "own_card") return false;
  const path = url.pathname.replace(/\/$/, "");
  const o = own(state);
  if (path === "/v1/local/passkeys" && method === "GET") return send(200, { passkeys: localPasskeys }), true;
  if (path === "/v1/local/passkeys/options" && method === "POST") {
    const challenge = b64url(randomBytes(32));
    o.pendingChallenges.set(challenge, nowS() + 300);
    return send(200, {
      challenge,
      rp_id: "localhost",
      rp_name: "Nokker (cette machine)",
      user: { id: b64url(Buffer.from("local-owner")), name: "local-owner", display_name: "Propriétaire" },
      pub_key_cred_params: [{ type: "public-key", alg: -7 }],
      exclude_credentials: localPasskeys.map((p) => p.credential_id),
      timeout_ms: 300000,
    }), true;
  }
  if (path === "/v1/local/passkeys" && method === "POST") {
    const b = await readBody();
    const ch = String(b.challenge ?? "");
    const due = o.pendingChallenges.get(ch);
    o.pendingChallenges.delete(ch);
    if (!due || due < nowS()) return err(send, 403, "proof_invalid", "défi d'enregistrement inconnu, expiré ou déjà utilisé");
    let client: { type?: string; challenge?: string } = {};
    try {
      client = JSON.parse(Buffer.from(String(b.client_data_json ?? ""), "base64url").toString());
    } catch {
      return err(send, 400, "invalid", "clientDataJSON illisible");
    }
    if (client.type !== "webauthn.create" || client.challenge !== ch) return err(send, 403, "proof_invalid", "enregistrement refusé (type ou défi)");
    if (b.public_key_alg !== -7) return err(send, 400, "unsupported", "ES256 (P-256) attendu");
    const cred = String(b.credential_id ?? "");
    if (!cred || localPasskeys.some((p) => p.credential_id === cred)) return err(send, 409, "exists", "passkey déjà enregistrée");
    const p: LocalPasskey & { public_key_spki?: string } = { device_id: randomUUID(), credential_id: cred, name: String(b.name ?? "Passkey de cette machine").slice(0, 64), created_at: nowS() };
    Object.defineProperty(p, "public_key_spki", { value: String(b.public_key_spki ?? ""), enumerable: false });
    localPasskeys.push(p);
    return send(201, p), true;
  }
  const del = /^\/v1\/local\/passkeys\/([0-9a-f-]{36})$/.exec(path);
  if (del && method === "DELETE") {
    const i = localPasskeys.findIndex((p) => p.device_id === del[1]);
    if (i >= 0) localPasskeys.splice(i, 1);
    return send(200, { removed: i >= 0 }), true;
  }
  const pm = /^\/v1\/payments\/mandates\/([^/]+)\/(cvv|otp)$/.exec(path);
  if (pm && method === "POST") {
    const b = await readBody();
    const r = ownCardPrompt(state, pm[1]!, pm[2] as "cvv" | "otp", String(b.value ?? ""));
    return r === "ok" ? (send(200, { accepted: true }), true) : r === "invalid" ? err(send, 400, "invalid", "valeur illisible") : err(send, 404, "not_found", "rien n'est demandé pour ce paiement");
  }
  if (path === "/v1/payments/method" && method === "GET") return send(200, { issuer: "own_card", method: o.card, publishable_key: null }), true;
  if (path === "/v1/payments/method" && method === "DELETE") {
    const had = !!o.card;
    o.card = null;
    return send(200, { removed: had }), true;
  }
  if (path === "/v1/payments/method/card" && method === "PUT") {
    const b = await readBody();
    const pan = String(b.number ?? "").replace(/[\s-]/g, "");
    const m = Number(b.exp_month), y0 = Number(b.exp_year);
    const y = y0 < 100 ? 2000 + y0 : y0;
    const t = new Date();
    if (!/^\d{12,19}$/.test(pan) || !luhnOk(pan)) return err(send, 400, "card_number", "numéro de carte illisible");
    if (!(m >= 1 && m <= 12) || y * 100 + m < t.getUTCFullYear() * 100 + t.getUTCMonth() + 1) return err(send, 400, "card_expiry", "date d'expiration passée ou illisible");
    if (!String(b.holder ?? "").trim()) return err(send, 400, "card_holder", "nom du titulaire illisible");
    const keep = b.keep_cvv === true;
    if (keep && !/^\d{3,4}$/.test(String(b.cvv ?? ""))) return err(send, 400, "card_cvv", "code de sécurité illisible");
    o.card = { kind: "own_card", issuer: "own_card", brand: brandOf(pan), last4: pan.slice(-4), exp_month: m, exp_year: y, created_at: nowS(), cvv_kept: keep };
    return send(200, { method: o.card }), true; // the number is dropped here: nothing keeps it
  }
  if (path === "/v1/payments/method/cvv-mode" && method === "POST") {
    const b = await readBody();
    if (!o.card) return err(send, 409, "card_no_card", "aucune carte enregistrée");
    if (b.keep === true && !/^\d{3,4}$/.test(String(b.cvv ?? ""))) return err(send, 400, "card_cvv", "code de sécurité illisible");
    o.card = { ...o.card, cvv_kept: b.keep === true };
    return send(200, { cvv_kept: o.card.cvv_kept }), true;
  }
  return false;
}

export function ownCardOf(state: MockState): OwnCard | null {
  return state.payAgent === "own_card" ? own(state).card : null;
}
