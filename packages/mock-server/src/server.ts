/**
 * Mock-server — implémente en mémoire le contrat `docs/CLIENT-API.md` +
 * `docs/APPROVALS.md` pour développer `apps/cli` et `apps/web` sans le noyau réel
 * (qui n'existe aujourd'hui que pour `/v1/chat/completions`, cf `nokker/api/server.py`).
 *
 * SIMPLIFICATIONS DE DEV (toutes documentées ici, à retirer/adapter contre le vrai serveur) :
 *  1. Un seul utilisateur (`MOCK_USER = "alice"`), pas de multi-tenant.
 *  2. Un appareil enrôlé est auto-approuvé (`status: "approved"` immédiat) — le vrai flux
 *     (TOTP via `POST /v1/devices/{id}/confirm`, ou `python -m nokker devices approve <code>` sur
 *     l'hôte, APPROVALS.md §3.1) n'est pas simulé pour l'ENRÔLEMENT ; `POST .../confirm` existe
 *     ici pour exercer le contrat côté client, mais ne sert à rien tant qu'un appareil démarre déjà
 *     `approved`.
 *  3. Le TOTP de démo accepte le code fixe `MOCK_TOTP_CODE` (affiché au démarrage), toujours au
 *     niveau `standard` — jamais `strong`, comme l'exige le contrat.
 *  4. Carte d'approbation de démo : un message utilisateur contenant « envoie » (insensible à la
 *     casse) déclenche la création d'une `Approval` `pending` (niveau `standard`, effet
 *     `send_external`) et l'événement `approval.requested` — pour exercer le flux complet sans
 *     noyau. Tout autre message reçoit une réponse simulée, sans outil.
 *  5. Bulles, fils permanents, sessions qui se parlent, aperçus (BUBBLES.md) : en mémoire, avec le
 *     scénario de démo de `demo.ts` (valeurs fictives « démo »). §9 (noyau 25de65c) : `GET /v1/notifications`,
 *     `GET /v1/users`, `GET/POST /v1/agents`, activation `agent_draft` en direct, images d'aperçu signées.
 *  6. `POST /v1/dev/demo-session` : jeton de démo sans appareil (navigateur hors contexte sécurisé).
 *
 * `POST /v1/devices/{id}/session-challenge` est désormais une route RÉELLE du noyau (APPROVALS.md
 * §3.6, plus une extension du mock) : la forme canonique du défi (`approval_id: "login:<id>"`,
 * `aud: "nokker-login"`) et la signature sur `challenge + ".login"` sont reproduites ici tel quel.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, webcrypto } from "node:crypto";
import { LOCAL_TOOL_CALL_PATH, argsSha256, canonicalJson, type Approval, type ApprovalStrength, type ChatMessage, messageText } from "@nokker-apps/sdk";
import { deviceToJson, finalizeDecision, knownUsersJson, KNOWN_USERS, LOCAL_OWNER, MockState, MOCK_USER, randomId, type MockDeviceRecord } from "./state.js";
import { localTitle, rootFor, runLocalTurn, scheduleLocalDecision } from "./local.js";
import { handleLocalToolCall } from "./localtools.js";
import { cancelChildren, openProjectSkills, trustProjectSkills } from "./project.js";
import { localCostTotals, publishTurnCost } from "./cost.js";
import {
  MockHttpError,
  bubblesForThread,
  clone,
  closeBubble,
  createBubble,
  getBubble,
  runAction,
  shareBubble,
  transferBubble,
  updateBubble,
} from "./bubbles.js";
import { PAGE_HEADERS, PUBLIC_PAGE_HEADERS, downloadName, getPage, handlePagePublication, signPageUrl, verifyPageSignature } from "./pages.js";
import { approvalBubble, verifyImageSignature, fakePreview, interpretDemo, previewImage, sessionMessage, settleApprovalBubbles, startDemoTimers } from "./demo.js";
import { BUBBLE_KINDS, BUBBLE_STATUSES, type BubbleKind } from "@nokker-apps/sdk";
import { verifyWebAuthnAssertion } from "./webauthn.js";
import { handleAccount } from "./account.js";
import { handleAgents } from "./agents.js";
import { handleTeam } from "./team.js";
import { handleHousehold } from "./household.js";
import { handleLocalMirror } from "./mirror.js";
import { handleLocalMail } from "./local-mail.js";
import { handlePacks } from "./packs.js";
import { handleSso, handleSsoPublic, type SsoSession } from "./sso.js";
import { handleAlertReceive, handleOps, handleOpsDev } from "./ops.js";
import { handleLocalMachine, handleLocalMachineDev, handlePreview } from "./local-machine.js";
import { handleLink, handleLinkDev } from "./link.js";
import { handleGatewayAuthorize, handleGatewayRelay } from "./gateway.js";
import { handleLocal, LOCAL_TOKEN } from "./local-setup.js";
import { handleAuthedOnboarding, handlePublicOnboarding } from "./onboarding.js";

export const MOCK_TOTP_CODE = "000000";
/** `aud` du défi de connexion — APPROVALS.md §3.6, identique au noyau (`BaseApprovals.login_challenge`). */
const LOGIN_CHALLENGE_AUD = "nokker-login";
const APPROVAL_CHALLENGE_AUD = "nokker-approval";

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj, null, 0), "utf-8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Session-Id",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  };
}

/** Jeton local (LOKKAL.md §7.4.5) : accepté seulement depuis une connexion loopback ET avec un `Host`
 * 127.0.0.1/localhost (anti-CSRF / DNS rebinding). Identité : `local-owner`. */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const host = String(req.headers["host"] ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (host !== "127.0.0.1" && host !== "localhost") return false;
  const remote = req.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function authUser(state: MockState, req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (state.localToken && token === state.localToken) return isLoopbackRequest(req) ? LOCAL_OWNER : null;
  // Jeton local fixe de l'écran /setup (`LOCAL_TOKEN`) : même règle, en boucle locale seulement.
  if (token === LOCAL_TOKEN) return isLoopbackRequest(req) ? LOCAL_OWNER : null;
  return state.userForToken(token);
}

/** Appareil de la session (SSO obligatoire, §7.24) : `approved_via` et heure de confirmation. */
function sessionDevice(state: MockState, req: IncomingMessage): SsoSession {
  const token = (req.headers["authorization"] ?? "").replace(/^Bearer /, "").trim();
  const dev = state.devices.get(state.sessions.get(token)?.deviceId ?? "");
  const at = dev?.approved_at ? Math.floor(Date.parse(dev.approved_at) / 1000) : null;
  return { via: dev?.approved_via ?? null, at };
}

/** Décode base64url (SANS padding) ; le base64 standard passe aussi sans effet (pas de `-`/`_` à
 * remplacer) — même repli que le noyau (APPROVALS.md §3.1). */
function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return new Uint8Array(Buffer.from(b64 + pad, "base64"));
}

async function importDevicePublicKey(spkiB64Url: string): Promise<webcrypto.CryptoKey> {
  const der = base64UrlToBytes(spkiB64Url);
  return webcrypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

async function verifySignature(publicKey: webcrypto.CryptoKey, signedText: string, signatureB64Url: string): Promise<boolean> {
  try {
    const sig = base64UrlToBytes(signatureB64Url);
    const data = new TextEncoder().encode(signedText);
    return await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sig, data);
  } catch {
    return false;
  }
}

export function createMockHttpServer(state: MockState) {
  return createServer((req, res) => {
    void handle(state, req, res).catch((err) => {
      if (err instanceof MockHttpError && !res.headersSent) {
        sendJson(res, err.status, { error: { message: err.message, ...err.extra } });
        return;
      }
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(err) } });
      else res.end();
    });
  });
}

async function handle(state: MockState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://mock");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);

  if (method === "GET" && path === "/healthz") {
    sendJson(res, 200, { status: "ok", mock: true, totp_demo: MOCK_TOTP_CODE, version: "mock", ...(state.minClientVersion ? { min_client_version: state.minClientVersion } : {}) });
    return;
  }

  // Images d'aperçu re-servies (§5) — sans jeton, voir simplification #6.
  const imgMatch = path.match(/^\/v1\/previews\/img\/([0-9a-f]{64})$/);
  if (method === "GET" && imgMatch) {
    // §9.3 : DEUX preuves acceptées — l'identité normale OU une signature valide (`exp` non expiré + `sig`).
    if (!verifyImageSignature(imgMatch[1]!, url.searchParams.get("exp"), url.searchParams.get("sig")) && !authUser(state, req)) {
      return void sendJson(res, 401, { error: { message: "signature d'image invalide ou expirée" } });
    }
    const svg = previewImage(imgMatch[1]!);
    if (!svg) return void sendJson(res, 404, { error: { message: "image inconnue" } });
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400", ...corsHeaders() });
    res.end(svg);
    return;
  }

  // Publication (§7.26) : publish / unpublish / locality, et la page publiée servie par son id public seulement.
  if (
    await handlePagePublication(state, authUser(state, req), method, path, () => readJsonBody(req), (st, obj) => sendJson(res, st, obj), (body, index) => {
      res.writeHead(200, { ...PUBLIC_PAGE_HEADERS, ...(index ? {} : { "X-Robots-Tag": "noindex, nofollow" }), ...corsHeaders() });
      res.end(method === "HEAD" ? undefined : body);
    })
  )
    return;

  // Pages (BUBBLES.md §10) — l'identité normale ou un lien signé ; sinon 404 (on ne révèle rien). Une page publique
  // n'est JAMAIS servie ici sans preuve : seulement par son id public (§7.26).
  const pageGet = path.match(/^\/v1\/pages\/(pg_[0-9a-f]{16})$/);
  if (method === "GET" && pageGet) {
    const page = state.pages.get(pageGet[1]!);
    const download = url.searchParams.get("dl") === "1";
    const signed = verifyPageSignature(pageGet[1]!, url.searchParams.get("exp"), url.searchParams.get("sig"), download);
    // Téléchargement : seulement par un lien signé `download` (une URL publique ne devient pas pièce jointe).
    const proven = signed || (!download && authUser(state, req) !== null);
    if (!page || !proven) return void sendJson(res, 404, { error: { message: "page inconnue" } });
    const v = url.searchParams.get("v");
    const idx = v === null ? page.versions.length : Number(v);
    const body = page.versions[idx - 1];
    if (!Number.isInteger(idx) || body === undefined) return void sendJson(res, 404, { error: { message: "version inconnue" } });
    const attach = download ? { "Content-Disposition": `attachment; filename="${downloadName(page.title)}"` } : {};
    res.writeHead(200, { ...PAGE_HEADERS, ...attach, ...corsHeaders() });
    res.end(body);
    return;
  }

  // ---- Onboarding du testeur (publiques : pas encore de session) ----------------------------
  let bodyCache: Promise<Record<string, unknown>> | undefined;
  const readBody = (): Promise<Record<string, unknown>> => (bodyCache ??= readJsonBody(req));
  if (await handlePublicOnboarding(state, method, url, readBody, (st, obj) => sendJson(res, st, obj))) return;
  if (await handleGatewayRelay(state, req, res, method, path, readBody)) return;
  if (
    await handleSsoPublic(state, method, url, readBody, (st, obj) => sendJson(res, st, obj), (st, body) => {
      res.writeHead(st, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders() });
      res.end(body);
    })
  )
    return;

  // ---- Appareils / sessions -----------------------------------------------------------------

  if (method === "POST" && path === "/v1/devices") {
    const body = await readJsonBody(req);
    if (state.devicePending && !String(body.user ?? "").trim()) {
      return void sendJson(res, 400, { error: { message: "user requis pour un appareil sans compte lié" } });
    }
    const id = randomId("dev");
    const now = new Date().toISOString();
    const device: MockDeviceRecord = {
      id,
      code: id.slice(4, 10), // 6 car. — APPROVALS.md §3.1 : "identifiant COURT (6 car. hex)"
      name: String(body.name ?? "appareil sans nom"),
      publicKeySpkiB64Url: String(body.public_key_spki ?? ""),
      // simplification #2 (sauf `devicePending` : appareil `pending` tant qu'il n'est pas confirmé par TOTP,
      // `user` déclaré obligatoire — APPROVALS.md §3.1bis).
      status: state.devicePending ? "pending" : "approved",
      created_at: now,
      approved_at: state.devicePending ? null : now,
      approved_via: state.devicePending ? null : "mock-auto",
      user: state.devicePending ? String(body.user ?? "") || MOCK_USER : MOCK_USER,
    };
    state.devices.set(id, device);
    sendJson(res, 201, deviceToJson(device));
    return;
  }

  if (method === "GET" && path === "/v1/devices") {
    if (!authUser(state, req)) return void sendJson(res, 401, { error: { message: "unauthorized" } });
    sendJson(res, 200, [...state.devices.values()].map(deviceToJson));
    return;
  }

  const deviceMatch = path.match(/^\/v1\/devices\/([^/]+)$/);
  if (method === "DELETE" && deviceMatch) {
    if (!authUser(state, req)) return void sendJson(res, 401, { error: { message: "unauthorized" } });
    state.devices.delete(deviceMatch[1]!);
    sendJson(res, 204, {});
    return;
  }

  // APPROVALS.md §3.1 — confirme un appareil `pending` par TOTP (simplification #2 : un appareil
  // enrôlé ici démarre déjà `approved`, cette route reste surtout là pour exercer le contrat côté
  // client/tests).
  const deviceConfirmMatch = path.match(/^\/v1\/devices\/([^/]+)\/confirm$/);
  if (method === "POST" && deviceConfirmMatch) {
    const device = state.devices.get(deviceConfirmMatch[1]!);
    if (!device) return void sendJson(res, 404, { error: { message: "appareil inconnu" } });
    const body = await readJsonBody(req);
    const totp = String(body.totp ?? "");
    const totpUser = String(body.user ?? "").trim();
    if (!totpUser) return void sendJson(res, 400, { error: { message: "user manquant" } });
    if (totp !== MOCK_TOTP_CODE) return void sendJson(res, 401, { error: { message: "TOTP invalide" } });
    if (device.status !== "approved") {
      device.status = "approved";
      device.approved_at = new Date().toISOString();
      device.approved_via = "totp";
    }
    sendJson(res, 200, deviceToJson(device));
    return;
  }

  // Route RÉELLE du noyau depuis le 18.10.2026 (APPROVALS.md §3.6) — aucune identité requise :
  // c'est CE défi, signé, qui en établit une. Forme canonique identique à celle du noyau
  // (`approval_id: "login:<device_id>"`, `aud: "nokker-login"`, `args_sha256: ""`).
  const sessionChallengeMatch = path.match(/^\/v1\/devices\/([^/]+)\/session-challenge$/);
  if (method === "POST" && sessionChallengeMatch) {
    const deviceId = sessionChallengeMatch[1]!;
    const device = state.devices.get(deviceId);
    if (!device) return void sendJson(res, 404, { error: { message: "appareil inconnu" } });
    const scope = `login:${deviceId}`;
    const nonce = randomId("nonce");
    const expMs = Date.now() + 120_000;
    const challenge = canonicalJson({ approval_id: scope, args_sha256: "", aud: LOGIN_CHALLENGE_AUD, exp: expMs, nonce });
    state.challenges.set(nonce, { nonce, exp: expMs, scope, used: false });
    sendJson(res, 200, { challenge, nonce, exp: Math.floor(expMs / 1000) });
    return;
  }

  // Extension mock (simplification #7) : session de démo SANS appareil, pour un navigateur hors contexte
  // sécurisé (http sur IP Tailscale : ni WebCrypto ni WebAuthn). N'existe pas dans le contrat ni dans le noyau.
  if (method === "POST" && path === "/v1/dev/demo-session") {
    const token = randomId("sess");
    const deviceId = "demo-sans-appareil";
    const expiresAt = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    state.sessions.set(token, { token, deviceId, expiresAt });
    res.setHeader("X-Nokker-Mock-Extension", "true");
    sendJson(res, 200, { token, user: MOCK_USER, device_id: deviceId, expires_at: expiresAt });
    return;
  }

  if (method === "POST" && path === "/v1/sessions") {
    const body = await readJsonBody(req);
    const deviceId = String(body.device_id ?? "");
    const challenge = String(body.challenge ?? "");
    const signature = body.signature !== undefined ? String(body.signature) : undefined;
    const device = state.devices.get(deviceId);
    if (!device || device.status !== "approved") {
      return void sendJson(res, 403, { error: { message: "appareil inconnu ou non approuvé" } });
    }
    let parsed: { approval_id?: string; aud?: string; nonce?: string; exp?: number };
    try {
      parsed = JSON.parse(challenge);
    } catch {
      return void sendJson(res, 400, { error: { message: "défi invalide" } });
    }
    const scope = `login:${deviceId}`;
    if (parsed.approval_id !== scope || parsed.aud !== LOGIN_CHALLENGE_AUD) {
      return void sendJson(res, 400, { error: { message: "défi de connexion invalide pour cet appareil" } });
    }
    const record = parsed.nonce ? state.challenges.get(parsed.nonce) : undefined;
    if (!record || record.used || record.exp < Date.now() || record.scope !== scope) {
      return void sendJson(res, 401, { error: { message: "défi expiré, inconnu ou déjà utilisé" } });
    }
    if (body.webauthn && typeof body.webauthn === "object") {
      // Connexion WebAuthn — challenge = SHA-256(challenge) SANS suffixe (APPROVALS.md §3.6, pas de
      // décision à lier ici, contrairement à une décision d'approbation).
      const w = body.webauthn as Record<string, unknown>;
      const expected = new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(challenge)));
      const result = await verifyWebAuthnAssertion(
        device.publicKeySpkiB64Url,
        {
          clientDataJSONB64: String(w.client_data_json ?? ""),
          authenticatorDataB64: String(w.authenticator_data ?? ""),
          signatureDERB64: String(w.signature ?? ""),
        },
        expected,
      );
      if (!result.ok) return void sendJson(res, 401, { error: { message: `WebAuthn invalide : ${result.reason}` } });
    } else if (signature) {
      // Signature brute — signe `challenge + ".login"` (APPROVALS.md §3.6), PAS le challenge nu.
      const publicKey = await importDevicePublicKey(device.publicKeySpkiB64Url);
      const ok = await verifySignature(publicKey, `${challenge}.login`, signature);
      if (!ok) return void sendJson(res, 401, { error: { message: "signature invalide" } });
    } else {
      return void sendJson(res, 400, { error: { message: "aucune preuve de connexion (ni signature, ni webauthn)" } });
    }
    record.used = true;
    const token = randomId("sess");
    const expiresAt = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    state.sessions.set(token, { token, deviceId, expiresAt });
    sendJson(res, 200, { token, user: MOCK_USER, device_id: deviceId, expires_at: expiresAt });
    return;
  }

  // Lokkal (`/v1/local/*` sous jeton local, `/v1/dev/local-mock` libre).
  if (await handleLocal(state, { host: req.headers.host, authorization: req.headers.authorization, localPort: req.socket.localPort }, method, path, readBody, (st, obj) => sendJson(res, st, obj))) return;
  if (await handleLinkDev(state, method, path, readBody, (st, obj) => sendJson(res, st, obj))) return;
  if (await handleLocalMachineDev(state, method, path, readBody, (st, obj) => sendJson(res, st, obj))) return;
  if (await handleLocalMirror(state, authUser(state, req), method, path, readBody, (st, obj) => sendJson(res, st, obj))) return;
  if (await handleOpsDev(state, method, path, readBody, (st, obj) => sendJson(res, st, obj))) return;
  // X18 : réception d'alertes SANS session (signée HMAC ou Bearer selon la source) ; le corps brut sert à la signature.
  if (
    await handleAlertReceive(state, method, path, req.headers, async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf-8");
    }, (st, obj) => sendJson(res, st, obj))
  )
    return;
  if (handlePreview(state, req, res, path)) return;

  // Tout ce qui suit exige une session valide.
  const user = authUser(state, req);
  if (!user && path !== "/v1/chat/completions") {
    return void sendJson(res, 401, { error: { message: "unauthorized" } });
  }

  if (await handleAccount(state, method, path, readBody, (st, obj) => sendJson(res, st, obj))) return;
  if (user && (await handleLink(state, user, method, url, readBody, (st, obj) => sendJson(res, st, obj)))) return;
  if (await handleGatewayAuthorize(state, method, path, readBody, (st, obj) => sendJson(res, st, obj))) return;
  if (await handleLocalMachine(state, user, method, path, readBody, (st, obj) => sendJson(res, st, obj))) return;
  if (await handleLocalMail(state, user, method, path, readBody, (st, obj) => sendJson(res, st, obj))) return;
  if (user && (await handleSso(state, user, method, url, readBody, (st, obj) => sendJson(res, st, obj)))) return;
  if (await handlePacks(state, user, method, url, readBody, (st, obj) => sendJson(res, st, obj))) return;
  if (await handleHousehold(state, user ?? MOCK_USER, method, url, readBody, (st, obj) => sendJson(res, st, obj))) return;
  if (await handleTeam(state, user ?? MOCK_USER, method, url, readBody, (st, obj) => sendJson(res, st, obj), sessionDevice(state, req))) return;
  if (await handleOps(state, user ?? MOCK_USER, method, url, readBody, (st, obj) => sendJson(res, st, obj))) return;
  if (await handleAuthedOnboarding(state, method, path, readBody, (st, obj) => sendJson(res, st, obj))) return;

  // ---- Session de code locale (LOKKAL.md §7.4.1) ------------------------------------------------
  if (method === "POST" && path === "/v1/local/sessions") {
    const body = await readBody();
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd || !cwd.startsWith("/")) return void sendJson(res, 400, { error: { message: "cwd (chemin absolu) requis" } });
    const root = rootFor(cwd, state.localRoots);
    if (root === null) return void sendJson(res, 403, { error: { message: "cwd hors des racines déclarées" } });
    // Fil demandé : `thread_id` ou son alias `resume` (§7.4.1) ; non chaîne ou deux fils différents : 400 ; vide : neuf.
    const wanted: string[] = [];
    for (const key of ["thread_id", "resume"] as const) {
      const v = body[key];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v !== "string") return void sendJson(res, 400, { error: { message: `${key} : chaîne attendue` } });
      wanted.push(v);
    }
    if (new Set(wanted).size > 1) return void sendJson(res, 400, { error: { message: "thread_id et resume désignent deux fils différents : n'en donner qu'un" } });
    let threadId: string;
    if (wanted[0]) {
      // Le noyau rouvre le fil donné (connu ou non) sur ce dossier.
      threadId = wanted[0];
      if (state.threads.has(threadId)) state.requireMember(threadId, user);
      else state.createThread(localTitle(cwd), { id: threadId, members: [user ?? MOCK_USER] }).thread.owner = user ?? MOCK_USER;
    } else {
      const rec = state.createThread(localTitle(cwd), { members: [user ?? MOCK_USER] });
      rec.thread.owner = user ?? MOCK_USER;
      threadId = rec.thread.id;
    }
    state.localSessions.set(threadId, { cwd, root, backend: "mock" });
    state.publishThread(threadId);
    // Drapeau `local.project_skills` (§7.21.3) : état des skills du dépôt ; éteint, pas de clé `skills`.
    const skills = state.projectSkills ? openProjectSkills(state, threadId, cwd, root) : null;
    return void sendJson(res, 201, { ...(skills ? { skills } : {}), thread_id: threadId, cwd });
  }
  if (method === "GET" && path === "/v1/local/sessions") {
    // Lignes du noyau (§7.4.1) : `title` null avant le premier tour, `working` (tour en cours ou en file),
    // `pending_approvals` (fil et sous-agents).
    const out = [...state.localSessions.entries()].map(([id, meta]) => {
      const rec = state.threads.get(id)!;
      const last = rec.turns.at(-1)?.created_at ?? null;
      const pending = [...state.approvals.values()].filter((a) => a.status === "pending" && (a.thread_id === id || a.thread_id.startsWith(`${id}/sa-`))).length;
      return {
        thread_id: id,
        cwd: meta.cwd,
        title: rec.turns.length ? rec.thread.title || null : null,
        last_turn_at: last ? new Date(last).toISOString() : null,
        working: state.activeTurns.has(id) || state.threadBusy(id),
        pending_approvals: pending,
        _u: rec.thread.updated_at,
      };
    });
    out.sort((a, b) => a._u.localeCompare(b._u)); // ordre du noyau : les plus anciennes d'abord
    return void sendJson(res, 200, { sessions: out.map(({ _u, ...r }) => (void _u, r)) });
  }
  // ---- Coût par tour (LOKKAL.md §7.6) : totaux de la session et du jour, lecture seule ------------
  if (method === "GET" && path === "/v1/local/cost") {
    if (user !== LOCAL_OWNER) return void sendJson(res, 401, { error: { message: "jeton local requis" } });
    const totals = localCostTotals(state, url.searchParams.get("thread_id"), url.searchParams.get("day"));
    if (!totals) return void sendJson(res, 400, { error: { message: "day : AAAA-MM-JJ attendu" } });
    return void sendJson(res, 200, totals);
  }
  // ---- Mémoire longue (LOKKAL.md §7.13.6) : contrôle « mémoire » de `nokker doctor` -----------------
  if (method === "GET" && path === "/v1/local/memory") {
    if (user !== LOCAL_OWNER) return void sendJson(res, 401, { error: { message: "jeton local requis" } });
    return void sendJson(res, 200, state.memory);
  }
  if (method === "GET" && path === "/v1/local/approvals") {
    if (user !== LOCAL_OWNER) return void sendJson(res, 403, { error: { message: "jeton local requis" } });
    state.expireStaleApprovals();
    return void sendJson(res, 200, {
      approvals: [...state.approvals.values()].filter((a) => a.status === "pending" && state.localSessions.has(a.thread_id.split("/sa-")[0]!)),
    });
  }
  const localDecideMatch = path.match(/^\/v1\/local\/approvals\/([^/]+)\/decide$/);
  if (method === "POST" && localDecideMatch) {
    if (user !== LOCAL_OWNER) return void sendJson(res, 403, { error: { message: "jeton local requis" } });
    const body = await readBody();
    const approval = state.approvals.get(localDecideMatch[1]!);
    // Publier une page s'approuve à la clé d'appareil seulement ; la refuser reste possible au jeton local (§7.26).
    if (approval?.tool_name === "page_publish" && body.decision === "approve") {
      return void sendJson(res, 403, { error: { code: "device_key_required", message: "publier une page se signe à la clé d'appareil" } });
    }
    if (approval?.tool_name === "page_publish" && body.decision === "reject" && approval.status === "pending") {
      finalizeDecision(state, approval, "reject", "local", LOCAL_OWNER);
      return void sendJson(res, 200, { status: approval.status });
    }
    if (!approval || !state.localSessions.has(approval.thread_id.split("/sa-")[0]!)) {
      return void sendJson(res, 404, { error: { message: "approbation locale inconnue" } });
    }
    if (approval.status !== "pending") return void sendJson(res, 409, { error: { message: `statut ${approval.status}` } });
    const decision = body.decision === "reject" ? "reject" : body.decision === "approve" ? "approve" : null;
    const scope = body.scope === undefined ? "once" : String(body.scope);
    if (!decision) return void sendJson(res, 400, { error: { message: "decision = approve | reject" } });
    if (!["once", "session", "always"].includes(scope)) return void sendJson(res, 400, { error: { message: "scope = once | session | always" } });
    if (approval.strength === "strong" && scope !== "once") {
      return void sendJson(res, 400, { error: { message: "carte forte : scope once seulement" } });
    }
    const options = approval.suggested_rules ?? [];
    let rule: string | null = null;
    if (decision === "approve" && scope === "always") {
      // `rule` doit être l'une des `suggested_rules` de la carte, le noyau refuse toute autre (400).
      rule = typeof body.rule === "string" ? body.rule : null;
      if (!rule || !options.includes(rule)) return void sendJson(res, 400, { error: { message: "règle non proposée par la carte" } });
      state.addAllowRule(rule);
    } else if (decision === "approve" && scope === "session") {
      rule = options[0] ?? null;
      if (rule) state.addSessionRule(approval.thread_id, rule);
    }
    approval.status = decision === "approve" ? "approved" : "rejected";
    approval.decided_by = LOCAL_OWNER;
    approval.decided_via = "local";
    approval.decided_at = new Date().toISOString();
    state.publish({ type: "approval.decided", approval_id: approval.id, decision: approval.status, by: LOCAL_OWNER, via: "local" });
    // Réponse TOUT DE SUITE (LOKKAL.md §7.4.3) : l'outil et le tour de suite tournent en fond ; l'issue arrive par le
    // `tool.result` de l'appel en attente (`approval_id`), la suite par les `turn.*` du fil.
    const body202 = { ...approval, call_id: approval.call_id ?? null, approval_id: approval.id, scope: decision === "approve" ? scope : "once", rule };
    const continuation = scheduleLocalDecision(state, approval);
    return void sendJson(res, continuation === "none" ? 200 : 202, { ...body202, continuation });
  }
  // ---- Skills du dépôt (LOKKAL.md §7.21.4) : confiance donnée sur la machine, jeton local seulement -----------------
  if (method === "POST" && path === "/v1/local/skills/trust") {
    if (user !== LOCAL_OWNER) return void sendJson(res, 401, { error: { message: "jeton local requis" } });
    if (!state.projectSkills) return void sendJson(res, 404, { error: { message: "skills du dépôt désactivés (local.project_skills)" } });
    const body = await readBody();
    const r = trustProjectSkills(state, String(body.thread_id ?? ""), String(body.sha256 ?? ""));
    return void sendJson(res, r.status, r.body);
  }
  if (method === "POST" && path === LOCAL_TOOL_CALL_PATH) {
    if (user !== LOCAL_OWNER) return void sendJson(res, 403, { error: { message: "jeton local requis" } });
    const r = await handleLocalToolCall(state, await readBody());
    return void sendJson(res, r.status, r.body);
  }
  const cancelMatch = path.match(/^\/v1\/threads\/([^/]+)\/cancel$/);
  if (method === "POST" && cancelMatch) {
    state.requireMember(cancelMatch[1]!, user);
    // Sous-agents du fil (fond et premier plan), un `<fil>/sa-<id>` : cet enfant seulement (§7.22.4).
    return void sendJson(res, 202, { ...state.cancelTurn(cancelMatch[1]!), subagents_cancelled: cancelChildren(state, cancelMatch[1]!) });
  }

  // ---- Fils (BUBBLES.md §1) ----------------------------------------------------------------
  if (method === "GET" && path === "/v1/threads") {
    sendJson(res, 200, state.sortedThreads());
    return;
  }
  if (method === "POST" && path === "/v1/threads") {
    const body = await readJsonBody(req);
    const title = String(body.title ?? "").trim();
    if (!title) return void sendJson(res, 400, { error: { message: "title requis" } });
    const rec = state.createThread(title.slice(0, 120));
    state.publishThread(rec.thread.id);
    sendJson(res, 201, rec.thread);
    return;
  }
  const threadMatch = path.match(/^\/v1\/threads\/([^/]+)$/);
  if (threadMatch && (method === "GET" || method === "PATCH")) {
    const rec = state.threads.get(threadMatch[1]!);
    if (!rec) return void sendJson(res, 404, { error: { message: "fil inconnu" } });
    if (method === "PATCH") {
      state.requireMember(rec.thread.id, user);
      const body = await readJsonBody(req);
      if (body.members !== undefined) {
        if (!Array.isArray(body.members)) throw new MockHttpError(400, "members doit être une liste");
        if (user !== rec.thread.owner) throw new MockHttpError(403, "seul le propriétaire change les membres");
        const members = body.members.map(String);
        const unknown = members.filter((m) => !(KNOWN_USERS as readonly string[]).includes(m));
        if (unknown.length) throw new MockHttpError(400, `membre(s) inconnu(s) : ${unknown.join(", ")}`);
        rec.thread.members = [...new Set([rec.thread.owner, ...members])];
      }
      if (typeof body.title === "string" && body.title.trim()) rec.thread.title = body.title.trim().slice(0, 120);
      rec.thread.updated_at = new Date().toISOString();
      state.publishThread(rec.thread.id);
      return void sendJson(res, 200, rec.thread);
    }
    state.requireMember(rec.thread.id, user);
    const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
    const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined;
    const messages = state.messagesOf(rec.thread.id, before, limit);
    rec.thread.bubble_count = state.openBubblesOf(rec.thread.id).length;
    sendJson(res, 200, { thread: rec.thread, messages, bubbles: bubblesForThread(state, rec.thread.id, false) });
    return;
  }
  const threadMsgMatch = path.match(/^\/v1\/threads\/([^/]+)\/messages$/);
  if (method === "POST" && threadMsgMatch) {
    const to = threadMsgMatch[1]!;
    const body = await readJsonBody(req);
    const from = String(body.from_thread ?? "");
    const text = String(body.text ?? "").trim();
    const ask = Boolean(body.ask);
    sessionMessage(state, from, to, text, { ask });
    sendJson(res, ask ? 202 : 200, { delivered: true, ask });
    return;
  }
  const threadBubblesMatch = path.match(/^\/v1\/threads\/([^/]+)\/bubbles$/);
  if (threadBubblesMatch && (method === "GET" || method === "POST")) {
    const threadId = threadBubblesMatch[1]!;
    state.requireMember(threadId, user);
    if (method === "GET") {
      const inc = url.searchParams.get("include_closed");
      return void sendJson(res, 200, bubblesForThread(state, threadId, inc === "1" || inc === "true"));
    }
    const body = await readJsonBody(req);
    const kind = String(body.kind ?? "") as BubbleKind;
    // `pack_agents` (BUBBLES §9.6) : posée par le noyau seulement (400 pour un client).
    if (!(BUBBLE_KINDS as readonly string[]).includes(kind) || kind === "notify" || kind === "pack_agents") {
      return void sendJson(res, 400, { error: { message: `kind non créable par un client : ${kind}` } });
    }
    if (body.state !== undefined && (typeof body.state !== "object" || body.state === null || Array.isArray(body.state))) {
      return void sendJson(res, 400, { error: { message: "state doit être un objet" } });
    }
    const status = (BUBBLE_STATUSES as readonly string[]).includes(String(body.status)) ? (body.status as "idle") : "idle";
    const b = createBubble(state, threadId, {
      kind,
      title: String(body.title ?? kind).slice(0, 120),
      state: (body.state ?? {}) as never,
      status,
      actions: Array.isArray(body.actions) ? (body.actions as never) : [],
      created_by: user ?? MOCK_USER,
    });
    sendJson(res, 201, clone(b));
    return;
  }

  // ---- Bulles (BUBBLES.md §2-§3) ------------------------------------------------------------
  const bubbleMatch = path.match(/^\/v1\/bubbles\/([^/]+)$/);
  if (bubbleMatch && method === "GET") {
    return void sendJson(res, 200, clone(getBubble(state, bubbleMatch[1]!)));
  }
  if (bubbleMatch && method === "PATCH") {
    const body = await readJsonBody(req);
    if (body.status !== undefined && !(BUBBLE_STATUSES as readonly string[]).includes(String(body.status))) {
      return void sendJson(res, 400, { error: { message: "status inconnu" } });
    }
    const b = updateBubble(state, bubbleMatch[1]!, {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(body.state && typeof body.state === "object" ? { state: body.state as Record<string, unknown> } : {}),
      ...(body.status !== undefined ? { status: body.status as "idle" } : {}),
      ...(typeof body.if_version === "number" ? { if_version: body.if_version } : {}),
    });
    return void sendJson(res, 200, clone(b));
  }
  const bubbleOpMatch = path.match(/^\/v1\/bubbles\/([^/]+)\/(close|transfer|share)$/);
  if (bubbleOpMatch && method === "POST") {
    const [, id, op] = bubbleOpMatch as unknown as [string, string, string];
    if (op === "close") return void sendJson(res, 200, clone(closeBubble(state, id)));
    const body = await readJsonBody(req);
    if (op === "transfer") {
      const mode = body.mode === "copy" ? "copy" : body.mode === "move" ? "move" : null;
      if (!mode) return void sendJson(res, 400, { error: { message: "mode = move | copy" } });
      return void sendJson(res, 200, transferBubble(state, id, String(body.to_thread ?? ""), mode));
    }
    const members = Array.isArray(body.members) ? body.members.map(String) : undefined;
    const threads = Array.isArray(body.threads) ? body.threads.map(String) : undefined;
    return void sendJson(res, 200, clone(shareBubble(state, id, { ...(members ? { members } : {}), ...(threads ? { threads } : {}) })));
  }
  const bubbleActionMatch = path.match(/^\/v1\/bubbles\/([^/]+)\/actions\/([^/]+)$/);
  if (bubbleActionMatch && method === "POST") {
    const r = runAction(state, bubbleActionMatch[1]!, decodeURIComponent(bubbleActionMatch[2]!));
    return void sendJson(res, r.status, r.body);
  }

  const pageLink = path.match(/^\/v1\/pages\/(pg_[0-9a-f]{16})\/link$/);
  if (method === "POST" && pageLink) {
    const page = getPage(state, pageLink[1]!);
    const body = await readJsonBody(req);
    const signed = signPageUrl(page.id, body.download === true);
    // Chemins relatifs au serveur : le client les résout (derrière le proxy de dev, l'hôte du mock n'est pas joignable).
    const pub = page.public && page.public_id ? { public_url: `/v1/pages/public/${page.public_id}`, public_version: page.public_version } : {};
    return void sendJson(res, 200, { url: signed.path, expires_at: signed.expires_at, ...pub });
  }

  // ---- Aperçus (§5) — fictifs ---------------------------------------------------------------
  if (method === "GET" && path === "/v1/previews") {
    const target = url.searchParams.get("url") ?? "";
    if (!/^https?:\/\//.test(target)) return void sendJson(res, 400, { error: { message: "url http(s) requise" } });
    return void sendJson(res, 200, fakePreview(target));
  }

  // ---- Agents (extension mock, onglet Crew) --------------------------------------------------
  // ---- Notifications et utilisateurs (§9.1, §9.2) ----------------------------------------------
  if (method === "GET" && path === "/v1/notifications") {
    const open = [...state.bubbles.values()].filter(
      (b) => b.kind === "notify" && b.thread_id === null && !b.closed_at && b.shared_with.members.includes(user ?? MOCK_USER),
    );
    return void sendJson(res, 200, open.map((b) => clone(b)).sort((a, b) => a.created_at.localeCompare(b.created_at)));
  }
  if (method === "GET" && path === "/v1/users") {
    return void sendJson(res, 200, knownUsersJson());
  }
  // LOKKAL §7.6 : octets d'une image d'un fil (membres ; seulement si CE fil la référence).
  const threadImg = path.match(/^\/v1\/threads\/([^/]+)\/images\/([0-9a-f]{64})$/);
  if (method === "GET" && threadImg) {
    const rec = state.threads.get(decodeURIComponent(threadImg[1]!));
    const refs = rec?.turns.some((t) => t.images?.some((im) => im.sha256 === threadImg[2]));
    const img = state.images.get(threadImg[2]!);
    if (!rec || !refs || !img || !rec.thread.members.includes(user ?? MOCK_USER)) return void sendJson(res, 404, { error: { message: "image inconnue" } });
    res.writeHead(200, { "Content-Type": img.media_type, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox", "Cache-Control": "private, max-age=3600", ...corsHeaders() });
    res.end(img.bytes);
    return;
  }

  // §9.4/§9.5 (X14) : agents et moteur du Crew. Un 204 part sans corps.
  if (
    await handleAgents(state, user ?? MOCK_USER, method, url, readBody, (st, obj) => {
      if (st === 204) {
        res.writeHead(204, corsHeaders());
        res.end();
      } else sendJson(res, st, obj);
    })
  )
    return;


  // ---- Événements (SSE) ------------------------------------------------------------------------

  if (method === "GET" && path === "/v1/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    });
    res.write(":ok\n\n");
    const send = (event: { type: string }): void => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    state.sseClients.add(send);
    startDemoTimers(state);
    const keepAlive = setInterval(() => res.write(":ka\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      state.sseClients.delete(send);
    });
    return;
  }

  // ---- Approbations -----------------------------------------------------------------------------

  if (method === "GET" && path === "/v1/approvals") {
    state.expireStaleApprovals();
    const status = url.searchParams.get("status");
    const all = [...state.approvals.values()];
    sendJson(res, 200, status ? all.filter((a) => a.status === status) : all);
    return;
  }

  const approvalMatch = path.match(/^\/v1\/approvals\/([^/]+)$/);
  if (method === "GET" && approvalMatch) {
    state.expireStaleApprovals();
    const approval = state.approvals.get(approvalMatch[1]!);
    if (!approval) return void sendJson(res, 404, { error: { message: "approbation inconnue" } });
    sendJson(res, 200, approval);
    return;
  }

  const approvalChallengeMatch = path.match(/^\/v1\/approvals\/([^/]+)\/challenge$/);
  if (method === "POST" && approvalChallengeMatch) {
    const approval = state.approvals.get(approvalChallengeMatch[1]!);
    if (!approval) return void sendJson(res, 404, { error: { message: "approbation inconnue" } });
    if (approval.status !== "pending") return void sendJson(res, 409, { error: { message: `statut ${approval.status}` } });
    const nonce = randomId("nonce");
    const expMs = Date.now() + 120_000; // TTL 120s, APPROVALS.md §3.2
    const challenge = canonicalJson({
      approval_id: approval.id,
      args_sha256: approval.args_sha256,
      nonce,
      exp: expMs,
      aud: APPROVAL_CHALLENGE_AUD,
    });
    state.challenges.set(nonce, { nonce, exp: expMs, scope: approval.id, used: false });
    sendJson(res, 200, { challenge, nonce, exp: Math.floor(expMs / 1000) });
    return;
  }

  const approvalDecisionMatch = path.match(/^\/v1\/approvals\/([^/]+)\/decision$/);
  if (method === "POST" && approvalDecisionMatch) {
    const body = await readJsonBody(req);
    // Appareil créé par code mail : il se connecte mais ne décide jamais (même corps que le noyau).
    if (state.devices.get(String(body.device_id ?? ""))?.approved_via === "email") {
      return void sendJson(res, 403, { error: { message: "strong_device_required" } });
    }
    const approval = state.approvals.get(approvalDecisionMatch[1]!);
    if (!approval) return void sendJson(res, 404, { error: { message: "approbation inconnue" } });
    if (approval.status !== "pending") return void sendJson(res, 409, { error: { message: `statut ${approval.status}` } });
    const decision = body.decision === "reject" ? "reject" : body.decision === "approve" ? "approve" : null;
    if (!decision) return void sendJson(res, 400, { error: { message: "decision invalide" } });
    if (body.scope !== undefined && !["once", "session", "always"].includes(String(body.scope))) {
      return void sendJson(res, 400, { error: { message: "scope = once | session | always" } });
    }
    // Jamais d'« always » sur une carte strong ; le jeton local ne décide jamais une carte strong.
    if (approval.strength === "strong" && body.scope === "always") {
      return void sendJson(res, 400, { error: { message: "always refusé sur une approbation strong" } });
    }

    // Les cartes des sessions locales se décident par /v1/local/approvals/{id}/decide ; cette route reste aux
    // preuves d'appareil (web).
    if (user === LOCAL_OWNER) {
      return void sendJson(res, 403, { error: { message: "jeton local : utiliser POST /v1/local/approvals/{id}/decide" } });
    }

    // Le défi reste OBLIGATOIRE sur tous les chemins de preuve (anti-rejeu/anti-falsification
    // d'`args_sha256`, APPROVALS.md §2) — y compris TOTP (§3.5), contrairement à l'ancienne
    // implémentation de ce mock qui ne le vérifiait que pour la signature.
    const challenge = String(body.challenge ?? "");
    let parsed: { nonce?: string; approval_id?: string; args_sha256?: string } = {};
    try {
      parsed = challenge ? JSON.parse(challenge) : {};
    } catch {
      return void sendJson(res, 400, { error: { message: "défi invalide" } });
    }
    const record = parsed.nonce ? state.challenges.get(parsed.nonce) : undefined;
    if (!record || record.used || record.exp < Date.now() || record.scope !== approval.id) {
      return void sendJson(res, 401, { error: { message: "défi expiré, inconnu ou déjà utilisé" } });
    }
    if (parsed.args_sha256 !== approval.args_sha256 || argsSha256(approval.arguments) !== approval.args_sha256) {
      return void sendJson(res, 409, { error: { message: "args_sha256 a changé — APPROVALS.md §2" } });
    }

    if (typeof body.totp === "string") {
      if (approval.strength === ("strong" as ApprovalStrength)) {
        return void sendJson(res, 403, { error: { message: "TOTP refusé pour une approbation strong — APPROVALS.md §1" } });
      }
      const totpUser = String(body.totp_user ?? body.user ?? "").trim();
      if (!totpUser) return void sendJson(res, 400, { error: { message: "totp_user manquant" } });
      if (body.totp !== MOCK_TOTP_CODE) {
        return void sendJson(res, 401, { error: { message: "TOTP invalide" } });
      }
      record.used = true;
      finalizeDecision(state, approval, decision, "totp", totpUser);
      settleApprovalBubbles(state, approval);
      sendJson(res, 200, approval);
      return;
    }

    const deviceId = String(body.device_id ?? "");
    const device = state.devices.get(deviceId);
    if (!device || device.status !== "approved") {
      return void sendJson(res, 403, { error: { message: "appareil inconnu ou non approuvé" } });
    }

    // Variante WebAuthn (apps/web) — voir docs/adr/0001-webauthn-vs-ecdsa-contrat.md. `clientData.challenge`
    // doit valoir SHA-256(challenge + "." + decision), pas le nonce brut (c'est ça qui lie la décision
    // à la signature malgré le schéma clientDataJSON figé par la spec WebAuthn).
    if (body.webauthn && typeof body.webauthn === "object") {
      const w = body.webauthn as Record<string, unknown>;
      const expected = new Uint8Array(
        await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(`${challenge}.${decision}`)),
      );
      const result = await verifyWebAuthnAssertion(
        device.publicKeySpkiB64Url,
        {
          clientDataJSONB64: String(w.client_data_json ?? ""),
          authenticatorDataB64: String(w.authenticator_data ?? ""),
          signatureDERB64: String(w.signature ?? ""),
        },
        expected,
      );
      if (!result.ok) return void sendJson(res, 401, { error: { message: `WebAuthn invalide : ${result.reason}` } });
      record.used = true;
      finalizeDecision(state, approval, decision, "webauthn", MOCK_USER);
      settleApprovalBubbles(state, approval);
      sendJson(res, 200, approval);
      return;
    }

    const signature = String(body.signature ?? "");
    const publicKey = await importDevicePublicKey(device.publicKeySpkiB64Url);
    const ok = await verifySignature(publicKey, `${challenge}.${decision}`, signature);
    if (!ok) return void sendJson(res, 401, { error: { message: "signature invalide" } });
    record.used = true;
    finalizeDecision(state, approval, decision, "signature", MOCK_USER);
    settleApprovalBubbles(state, approval);
    sendJson(res, 200, approval);
    return;
  }

  // ---- Chat completions (seule route déjà réelle côté noyau — même forme ici) -------------------

  if (method === "POST" && path === "/v1/chat/completions") {
    const body = await readJsonBody(req);
    const messages = (body.messages as ChatMessage[] | undefined) ?? [];
    const threadId = String(req.headers["x-session-id"] ?? randomId("thread"));
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userText = lastUser ? messageText(lastUser.content) : "";
    // X7 : images jointes (format OpenAI). Le mock ne les lit pas, il les compte pour la réponse de démo.
    const imageParts = Array.isArray(lastUser?.content) ? lastUser.content.flatMap((p) => (p.type === "image_url" ? [p.image_url.url] : [])) : [];
    const imageCount = imageParts.length;
    // LOKKAL §7.6 : octets rangés par sha256, le tour ne garde que {sha256, media_type, size}.
    const turnImages = imageParts.flatMap((url) => {
      const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(url);
      if (!m) return [];
      const bytes = Buffer.from(m[2]!, "base64");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      state.images.set(sha256, { bytes, media_type: m[1]! });
      return [{ sha256, media_type: m[1]!, size: bytes.length }];
    });
    const stream = Boolean(body.stream);
    const model = String(body.model ?? "nokker-mock");
    // Jetons en direct (opt-in, CLIENT-API.md §Streaming du noyau) : deltas puis chunk final `nokker.final`.
    const liveTokens = stream && String(req.headers["x-nokker-stream-tokens"] ?? "") === "1";
    const known = state.threads.has(threadId);
    const rec = state.ensureThread(threadId, userText);
    if (known) state.requireMember(threadId, user);
    // Dev : simuler la réflexion du vrai noyau (plusieurs secondes) pour voir l'animation KITT du web.
    // En stream, le noyau envoie ses en-têtes tout de suite puis un `: ping` toutes les ~10 s : idem ici.
    const thinkMs = Number(process.env.NOKKER_MOCK_THINK_MS ?? 0);
    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(),
      });
    }
    if (thinkMs > 0) {
      const pingMs = Math.min(10_000, Math.max(50, Math.round(thinkMs / 3)));
      const ping = stream ? setInterval(() => res.write(": ping\n\n"), pingMs) : undefined;
      await new Promise((r) => setTimeout(r, thinkMs));
      if (ping) clearInterval(ping);
    }

    // File par fil (LOKKAL.md §7.4.9) : un tour de session locale attend la fin du tour en cours et des suites de
    // décisions déjà en file, puis prend l'index suivant.
    const releaseThread = state.localSessions.has(threadId) ? await state.lockThread(threadId) : null;
    try {
      const turnIndex = rec.turns.length;
      const turnId = `${threadId}:${turnIndex}`;
      // Boîte de contexte vidée au début du tour (§8) : bulles reçues, messages d'autres sessions.
      const context = state.drainContext(threadId);
      state.setWorking(threadId, true);
      state.publish({ type: "turn.started", thread_id: threadId, turn_id: turnId });
      const isLocal = state.localSessions.has(threadId);
      let cancelled = false;
      let localReply = "";
      if (isLocal) {
        // Session locale : le tour se déroule en temps réel (outils, cartes) ; la connexion SSE reste ouverte
        // avec des `: ping` comme le noyau.
        const ctl = new AbortController();
        state.activeTurns.set(threadId, { turnId, abort: ctl });
        const ping = stream ? setInterval(() => !res.writableEnded && res.write(": ping\n\n"), 10_000) : undefined;
        try {
          const r = await runLocalTurn(state, threadId, turnId, userText, ctl.signal);
          localReply = r.reply;
          cancelled = r.cancelled;
        } finally {
          if (ping) clearInterval(ping);
          state.activeTurns.delete(threadId);
        }
      }
      const demo = isLocal
        ? { reply: cancelled ? "" : localReply, triggersApproval: false, after: undefined }
        : interpretDemo(state, threadId, userText, { turnId, context });
      const { triggersApproval, after } = demo;
      const reply = imageCount > 0 && !isLocal ? `(démo) ${imageCount === 1 ? "Image reçue" : `${imageCount} images reçues`}, non analysée${imageCount === 1 ? "" : "s"} par le mock. ${demo.reply}` : demo.reply;

      let approval: Approval | undefined;
      if (triggersApproval && !state.pendingApprovalForThread(threadId)) {
        const args = { to: "destinataire@example.com", subject: "Démo d'approbation", body: userText };
        approval = {
          id: randomId("appr"),
          thread_id: threadId,
          turn_index: turnIndex,
          channel: "web",
          tool_name: "send_email_bulk",
          arguments: args,
          args_sha256: argsSha256(args),
          effect: "send_external",
          rule: "effect:send_external",
          reason: "Le message demande un envoi externe — approbation requise avant toute exécution réelle.",
          advice: "Avis simulé : aucune donnée sensible détectée ; retour arrière trivial (rien n'est envoyé avant approbation).",
          strength: "standard",
          status: "pending",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          decided_by: null,
          decided_via: null,
          decided_at: null,
          result_summary: null,
          error: null,
        };
        state.approvals.set(approval.id, approval);
        state.publish({
          type: "tool.call",
          thread_id: threadId,
          turn_id: turnId,
          call_id: randomId("call"),
          name: approval.tool_name,
          args_preview: JSON.stringify(args).slice(0, 200),
        });
        state.publish({ type: "approval.requested", approval });
        approvalBubble(state, approval);
      }

      state.appendTurn(threadId, userText, cancelled ? "(tour annulé)" : reply, { sender: user, channel: isLocal ? "cli" : "web", silent: true, images: turnImages });
      // Les bulles naissent pendant le tour (comme un producteur du noyau à partir d'un résultat d'outil).
      after?.();
      const endTurn = (): void => {
        // `turn.delta` UNIQUE par tour (réponse complète) juste avant `turn.done` — comme le noyau P1.
        state.publish({ type: "turn.delta", thread_id: threadId, turn_id: turnId, text: reply });
        publishTurnCost(state, threadId, turnId, userText, reply); // X2 : le coût part avant `turn.done`
        state.publish({
          type: "turn.done",
          thread_id: threadId,
          turn_id: turnId,
          usage: { prompt_tokens: userText.length, completion_tokens: reply.length, total_tokens: userText.length + reply.length },
          tier: "mock",
          ...(cancelled ? { cancelled: true } : {}),
        });
        state.setWorking(threadId, false);
        state.publishThread(threadId);
      };
      const completionId = `chatcmpl-mock-${randomId("")}`;
      const created = Math.floor(Date.now() / 1000);
      const usage = { prompt_tokens: userText.length, completion_tokens: reply.length, total_tokens: userText.length + reply.length };

      if (!stream) {
        endTurn();
        sendJson(res, 200, {
          id: completionId,
          object: "chat.completion",
          created,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage,
        });
        return;
      }

      const sseChunk = (
        choiceDelta: Record<string, unknown>,
        finish: string | null,
        withUsage = false,
        nokker?: { reset?: boolean; final?: boolean },
      ): void => {
        res.write(
          `data: ${JSON.stringify({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: choiceDelta, finish_reason: finish }],
            ...(withUsage ? { usage } : {}),
            ...(nokker ? { nokker } : {}),
          })}\n\n`,
        );
      };
      sseChunk({ role: "assistant" }, null);
      // Découpe la réponse en mots pour exercer un vrai rendu incrémental côté clients.
      const words = reply.split(" ");
      for (const w of cancelled ? [] : words) {
        if (res.destroyed) break;
        sseChunk({ content: `${w} ` }, null);
        await new Promise((r) => setTimeout(r, Math.round(18 * state.speed)));
      }
      if (liveTokens) {
        sseChunk({ content: reply }, null, true, { reset: true, final: true });
        sseChunk({}, "stop");
      } else {
        sseChunk({}, "stop", true);
      }
      if (!res.destroyed) res.write("data: [DONE]\n\n");
      endTurn();
      res.end();
      return;
    } finally {
      releaseThread?.();
    }
  }

  sendJson(res, 404, { error: { message: "not found" } });
}
