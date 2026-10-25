/**
 * Connexion SSO OIDC d'un membre (LOKKAL §7.24), côté web :
 * 1. `startSso` : paire P-256 NON extractible (comme le code e-mail), `POST /v1/auth/oidc/start`, `state` gardé en
 *    `sessionStorage`, la clé privée et le retour gardés dans IndexedDB (une CryptoKey survit là à la navigation),
 *    puis l'appelant navigue vers `authorize_url`.
 * 2. `completeSso` (sur `redirect_uri`, `/sso/callback`) : le `state` reçu doit être le nôtre, sinon rien ne part ;
 *    signature de `"<state>.oidc"`, `POST /v1/auth/oidc/callback`, appareil rangé là où `restoreLogin` le relit : la
 *    session s'ouvre ensuite par le défi habituel (`session-challenge` puis `POST /v1/sessions`).
 * L'appareil SSO CONNECTE seulement (`approved_via = "sso:<sc>"`) : il ne décide jamais une carte forte.
 */
import { NokkerApiError, generateDeviceKeyPair, signChallenge, type DeviceKeyPair, type NokkerClient, type OidcCallbackResult, type SsoMapping } from "@nokker-apps/sdk";

export const STATE_KEY = "nokker.sso.state";
export const PENDING_KEY = "sso-pending";
const LAST_KEY = "nokker.sso.last";

export interface SsoPending {
  state: string;
  connection: string;
  privateKey: unknown;
  publicKeySpkiB64Url: string;
  back: string;
}

/** Dépendances injectées (tests) ; `defaultDeps` les branche sur le navigateur. */
export interface SsoDeps {
  client: NokkerClient;
  session: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  pending: { put(p: SsoPending): Promise<void>; get(): Promise<SsoPending | undefined>; drop(): Promise<void> };
  storeDevice: (deviceId: string, pair: DeviceKeyPair) => Promise<void>;
  /** Un appareil était déjà rangé pour ce navigateur (il reste actif côté nokker.ai : à retirer dans Mon compte). */
  hadDevice: () => Promise<boolean>;
  secure: () => boolean;
  deviceName: () => string;
  lang: string;
  generate?: () => Promise<DeviceKeyPair>;
}

/** Erreur locale du parcours (avant tout appel, ou retour illisible) ; les refus du noyau restent `NokkerApiError`. */
export class SsoFlowError extends Error {
  constructor(public readonly code: "insecure_context" | "invalid_state" | "missing_code") {
    super(code);
  }
}

/** Un retour sûr : un chemin de cette origine, jamais une URL ni `//hôte`. */
export function safeBack(back: string | null | undefined): string {
  return back && back.startsWith("/") && !back.startsWith("//") && !back.startsWith("/\\") ? back : "/";
}

export async function startSso(deps: SsoDeps, target: { connection?: string; email?: string }, back = "/"): Promise<string> {
  if (!deps.secure()) throw new SsoFlowError("insecure_context");
  const pair = await (deps.generate ?? generateDeviceKeyPair)();
  const r = await deps.client.startOidc({
    ...(target.connection ? { connection: target.connection } : { email: (target.email ?? "").trim().toLowerCase() }),
    public_key_spki: pair.publicKeySpkiB64Url,
    name: deps.deviceName(),
    lang: deps.lang,
  });
  await deps.pending.put({ state: r.state, connection: r.connection, privateKey: pair.privateKey, publicKeySpkiB64Url: pair.publicKeySpkiB64Url, back: safeBack(back) });
  deps.session.setItem(STATE_KEY, r.state);
  return r.authorize_url;
}

/** `search` = la requête de `/sso/callback` (`?code=…&state=…` ou `?error=…&state=…`). Usage unique : l'attente est
 * effacée avant tout appel, même en cas d'échec. */
export async function completeSso(deps: SsoDeps, search: string): Promise<{ back: string; result: OidcCallbackResult; replaced: boolean }> {
  const q = new URLSearchParams(search);
  const state = q.get("state") ?? "";
  const code = q.get("code");
  const error = q.get("error");
  const expected = deps.session.getItem(STATE_KEY);
  const pending = await deps.pending.get();
  deps.session.removeItem(STATE_KEY);
  await deps.pending.drop();
  if (!state || state !== expected || !pending || pending.state !== state) throw new SsoFlowError("invalid_state");
  if (!code && !error) throw new SsoFlowError("missing_code");
  const signature = await signChallenge(pending.privateKey, state, "oidc");
  const result = await deps.client.oidcCallback({ state, ...(error ? { error } : { code: code! }), signature });
  const replaced = await deps.hadDevice().catch(() => false);
  await deps.storeDevice(result.device_id, { privateKey: pending.privateKey, publicKeySpkiB64Url: pending.publicKeySpkiB64Url });
  return { back: pending.back, result, replaced };
}

/** Code d'une erreur du parcours ou du noyau (`{error: {code}}`), sinon `generic` / `network`. */
export function ssoErrorCode(e: unknown): string {
  if (e instanceof SsoFlowError) return e.code;
  if (e instanceof NokkerApiError) {
    const b = e.body as { error?: string | { code?: string } } | undefined;
    const c = typeof b?.error === "string" ? b.error : b?.error?.code;
    if (c) return c;
    return e.status === 429 ? "rate" : "generic";
  }
  return "network";
}

/** 403 `sso_required` : la connexion exigée (`error.connection`) ; `""` si le noyau ne la donne pas. */
export function ssoRequiredConnection(e: unknown): string | null {
  if (!(e instanceof NokkerApiError) || e.status !== 403 || ssoErrorCode(e) !== "sso_required") return null;
  const c = (e.body as { error?: { connection?: unknown } } | undefined)?.error?.connection;
  return typeof c === "string" ? c : "";
}

/** Une redirection automatique par connexion et par minute : un retour SSO qui ne suffit toujours pas (groupe sans
 * rôle, configuration cassée) s'affiche au lieu de boucler entre nokker.ai et le fournisseur. */
export function mayAutoRedirect(session: Pick<Storage, "getItem" | "setItem">, connection: string, now = Date.now()): boolean {
  try {
    const last = JSON.parse(session.getItem(LAST_KEY) ?? "null") as { connection?: string; at?: number } | null;
    if (last?.connection === connection && typeof last.at === "number" && now - last.at < 60_000) return false;
    session.setItem(LAST_KEY, JSON.stringify({ connection, at: now }));
    return true;
  } catch {
    return false;
  }
}

/** Client qui signale chaque 403 `sso_required` (puis relance l'erreur) : monté une fois par l'onglet Équipe. */
export function withSsoGuard(client: NokkerClient, onRequired: (connection: string) => void): NokkerClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        const out = (v as (...a: unknown[]) => unknown).apply(target, args);
        if (!(out instanceof Promise)) return out;
        return out.catch((e: unknown) => {
          const sc = ssoRequiredConnection(e);
          if (sc !== null) onRequired(sc);
          throw e;
        });
      };
    },
  });
}

/** Lignes de l'éditeur groupes → rôles → corps du PUT : groupes vides retirés, doublons fusionnés. */
export function cleanMappings(rows: SsoMapping[]): SsoMapping[] {
  const out: SsoMapping[] = [];
  for (const r of rows) {
    const group = r.group.trim();
    if (group && !out.some((x) => x.group === group && x.role === r.role)) out.push({ group, role: r.role });
  }
  return out;
}
