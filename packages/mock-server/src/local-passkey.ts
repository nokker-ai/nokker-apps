/**
 * « Ta carte » on the Lokkal machine (PAY-AGENT §11, own_card): decision of a `payments:to_pay` card with the LOCAL
 * passkey — stub of the core routes until the payment lot brings its own mock (contract of p2/pay-owncard):
 *
 *   POST /v1/local/approvals/{id}/challenge  → {challenge, nonce, exp, rp_id: "localhost", allow_credentials}
 *        404 not_found · 409 not_local | not_pending · 412 no_passkey
 *   POST /v1/local/approvals/{id}/decision   WebAuthnApprovalDecision → the Approval
 *        400 invalid · 403 proof_invalid · 404 not_found · 409 not_local | not_pending
 *   GET  /v1/local/passkeys                  → {passkeys: [{device_id, credential_id, name, created_at}]}
 *        (served by `owncard.ts` when `MOCK_PAY_AGENT=own_card`, here otherwise: the same list either way)
 *
 * Mock only (never in the core), for the e2e and the demo:
 *   POST /v1/dev/local-passkey {credential_id, public_key_spki}   registers a passkey (the e2e's virtual authenticator)
 *   POST /v1/dev/owncard-card {own_card?: boolean}               a pending « to pay » card in a local session;
 *        own_card false → the same card WITHOUT `local_passkey` (it keeps the forwarded path)
 */
import { createHash } from "node:crypto";
import { canonicalJson, type Approval, type LocalPasskey } from "@nokker-apps/sdk";
import { localPasskeys } from "./owncard.js";
import { settleApprovalBubbles } from "./demo.js";
import { ownCardMandate, ownCardStarted, payChallengeBinding, payDecided, payDemo } from "./payments.js";
import { LOCAL_OWNER, randomId, type MockState } from "./state.js";
import { verifyWebAuthnAssertion } from "./webauthn.js";

type Send = (status: number, payload: unknown) => void;

/** The machine's passkeys: ONE list, the one the enrolment of My account fills (`owncard.ts`); the SPKI key rides along
 * as a non-enumerable `public_key_spki` (never sent back). */
type Passkey = LocalPasskey & { public_key_spki?: string };
const spkiOf = (k: Passkey): string => k.public_key_spki ?? "";
interface LP {
  /** nonce → {approval id, expiry ms, used} */
  nonces: Map<string, { id: string; exp: number; used: boolean }>;
}
const lps = new WeakMap<MockState, LP>();
const lp = (state: MockState): LP => {
  let v = lps.get(state);
  if (!v) {
    localPasskeys.length = 0; // a fresh mock: no passkey yet
    lps.set(state, (v = { nonces: new Map() }));
  }
  return v;
};

const fail = (send: Send, status: number, code: string, message: string): true => (send(status, { error: { code, message } }), true);

export async function handleLocalPasskey(state: MockState, user: string | null, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const L = lp(state);
  if (method === "POST" && path === "/v1/dev/local-passkey") {
    if (user !== LOCAL_OWNER) return fail(send, 403, "forbidden", "jeton local requis");
    const b = await readBody();
    const key: Passkey = { device_id: randomId("dev"), credential_id: String(b.credential_id ?? ""), name: "This machine", created_at: Date.now() / 1000 };
    Object.defineProperty(key, "public_key_spki", { value: String(b.public_key_spki ?? ""), enumerable: false });
    localPasskeys.push(key);
    send(201, { device_id: key.device_id, credential_id: key.credential_id });
    return true;
  }
  if (method === "POST" && path === "/v1/dev/owncard-card") {
    if (user !== LOCAL_OWNER) return fail(send, 403, "forbidden", "jeton local requis");
    const b = await readBody();
    // A real local session (the list of local sessions reads its thread).
    const rec = state.createThread("Shopping (demo)", { members: [LOCAL_OWNER] });
    rec.thread.owner = LOCAL_OWNER;
    const threadId = rec.thread.id;
    state.localSessions.set(threadId, { cwd: "/home/alice", root: "/home/alice", backend: "mock" });
    state.publishThread(threadId);
    const before = new Set(state.approvals.keys());
    if (payDemo(state, threadId, "achete des cartouches d encre") === null) return fail(send, 409, "payments_off", "MOCK_PAYMENTS=1 requis");
    const card = [...state.approvals.values()].find((a) => !before.has(a.id))!;
    ownCardMandate(state, card.id, LOCAL_OWNER, b.own_card !== false);
    if (b.own_card !== false) {
      card.local_passkey = true;
      card.forwarded = false;
    }
    send(201, { approval_id: card.id, thread_id: threadId });
    return true;
  }
  // With MOCK_PAY_AGENT=own_card, the enrolment mock (`owncard.ts`) serves the list (same array).
  if (method === "GET" && path === "/v1/local/passkeys" && state.payAgent !== "own_card") {
    if (user !== LOCAL_OWNER) return fail(send, 403, "forbidden", "jeton local requis");
    send(200, { passkeys: localPasskeys });
    return true;
  }
  const m = /^\/v1\/local\/approvals\/([^/]+)\/(challenge|decision)$/.exec(path);
  if (!m || method !== "POST") return false;
  if (user !== LOCAL_OWNER) return fail(send, 403, "forbidden", "jeton local requis");
  const a = state.approvals.get(m[1]!);
  if (!a) return fail(send, 404, "not_found", "carte inconnue");
  if (!a.local_passkey) return fail(send, 409, "not_local", "carte à décider sur nokker.ai");
  if (a.status !== "pending") return fail(send, 409, "not_pending", `statut ${a.status}`);
  if (m[2] === "challenge") {
    if (!localPasskeys.length) return fail(send, 412, "no_passkey", "aucune passkey locale");
    const nonce = randomId("nonce");
    const exp = Date.now() + 120_000;
    const mandate = payChallengeBinding(state, a.id);
    const challenge = canonicalJson({ approval_id: a.id, args_sha256: a.args_sha256, aud: "nokker-approval", exp, nonce, ...(mandate ? { mandate_sha256: mandate } : {}) });
    L.nonces.set(nonce, { id: a.id, exp, used: false });
    send(200, { challenge, nonce, exp: Math.floor(exp / 1000), rp_id: "localhost", allow_credentials: localPasskeys.map((k) => k.credential_id) });
    return true;
  }
  const b = await readBody();
  const decision = b.decision === "approve" || b.decision === "reject" ? b.decision : null;
  const w = (b.webauthn ?? {}) as Record<string, unknown>;
  if (!decision || typeof b.challenge !== "string" || typeof w.signature !== "string") return fail(send, 400, "invalid", "corps illisible");
  let parsed: { nonce?: string; approval_id?: string } = {};
  try {
    parsed = JSON.parse(b.challenge);
  } catch {
    return fail(send, 400, "invalid", "défi illisible");
  }
  const rec = parsed.nonce ? L.nonces.get(parsed.nonce) : undefined;
  if (!rec || rec.used || rec.exp < Date.now() || rec.id !== a.id) return fail(send, 403, "proof_invalid", "défi expiré, inconnu ou déjà utilisé");
  const key = (localPasskeys as Passkey[]).find((k) => k.device_id === b.device_id);
  if (!key) return fail(send, 403, "proof_invalid", "appareil inconnu");
  const digest = new Uint8Array(createHash("sha256").update(`${b.challenge}.${decision}`).digest());
  const b64 = (v: unknown): string => String(v ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const ok = await verifyWebAuthnAssertion(spkiOf(key), { clientDataJSONB64: b64(w.client_data_json), authenticatorDataB64: b64(w.authenticator_data), signatureDERB64: b64(w.signature) }, digest);
  if (!ok.ok) return fail(send, 403, "proof_invalid", ok.reason ?? "signature refusée");
  rec.used = true;
  a.status = decision === "approve" ? "approved" : "rejected";
  a.decided_by = LOCAL_OWNER;
  a.decided_via = "webauthn";
  a.decided_at = new Date().toISOString();
  payDecided(state, a, decision, LOCAL_OWNER);
  if (decision === "approve") ownCardStarted(state, a.id);
  // Like the core's executor: the turn that follows the decision, whose user message is the `[Approbation]` block
  // written for the model, marked `origin: "approval"` (never the person's message).
  const status = decision === "approve" ? "executed" : "rejected";
  const block = ["[Approbation]", `Outil : ${a.tool_name}`, `D\u00e9cision : ${status}`, `D\u00e9cideur : ${LOCAL_OWNER}`, "Moyen : local-passkey", "R\u00e9sultat : (demo)", "[/Approbation]"].join("\n");
  state.appendTurn(a.thread_id, block, decision === "approve" ? "Your payment agent takes it from here; I do not touch the payment any more (demo)." : "Understood, nothing is paid (demo).", { sender: null, channel: "cli", origin: "approval" });
  state.publishThread(a.thread_id);
  state.publish({ type: "approval.decided", approval_id: a.id, decision: a.status, by: LOCAL_OWNER, via: "webauthn" });
  settleApprovalBubbles(state, a);
  send(200, a as Approval);
  return true;
}
