/**
 * Sessions de code multi-utilisateur (LOKKAL §7.28) — mock. Drapeau `code.enabled` : option `code` ou `MOCK_CODE=1`,
 * éteint par défaut comme le noyau (404 sur /v1/code/*). Le jeton local n'est pas un compte : 403 `account_required`.
 * Un profil mineur du foyer (`MOCK_HOUSEHOLD=minor`) n'ouvre pas de session : 403 `minor_not_allowed`.
 * La config de la démo est l'exemple du contrat (modes default, accept_edits, plan ; 3 sessions par compte ; forges
 * git.example.org et forge.example.net:8443). Le clone ne fait rien (`clone` de `/v1/dev/code-mock` pour l'échec).
 * Points de retour (`tools/call`, liste blanche checkpoint_list|diff|restore) : trois points de démo par session ; une
 * restauration passe par la porte de la session : carte forte (202, défaut), exécutée tout de suite (200, réglage
 * `restore: "direct"`), ou refusée (200 `is_error`, session en mode plan). Elle ajoute le point « avant retour ».
 * Réglages : `POST /v1/dev/code-mock {clone?: "ok"|"clone_failed"|"git_missing", vault?: boolean, idle?: true|[cs_…],
 * active?: [cs_…], limit?: number, turn_running?: [cs_…], restore?: "card"|"direct", skills?, spawn?, finish?}`
 * (skills du dépôt et sous-agents : voir `code-skills.ts`).
 */
import { createHash, randomBytes } from "node:crypto";
import type { Approval, CheckpointInfo, CodeCredential, CodeSession } from "@nokker-apps/sdk";
import { devExtras, extrasFor, extraTool, liveCount, MAX_SUBAGENTS, SkillsErr, stopKids, trustSkills, type SessionExtras } from "./code-skills.js";
import { householdMinor } from "./household.js";
import { LOCAL_OWNER, randomId, type MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;

interface Rec {
  s: CodeSession;
  user: string;
  points: CheckpointInfo[];
  /** Un tour tient le fil (réglage de démo) : `tools/call` → 409 `turn_running`. */
  busy: boolean;
  /** Skills du dépôt et sous-agents (§7.28 points 13 et 14). */
  x: SessionExtras;
}
interface C {
  sessions: Map<string, Rec>;
  creds: Map<string, CodeCredential>;
  clone: "ok" | "clone_failed" | "git_missing";
  vault: boolean;
  limit: number;
  restore: "card" | "direct";
}

const MODES = ["default", "accept_edits", "plan"];
const DEFAULT_MODE = "accept_edits";
const HOSTS = ["git.example.org", "forge.example.net:8443"];
const MOUNT = "/workspace";
// Mêmes motifs que le noyau (forge.py, service.py, secrets/base.py).
const SEGMENT = /^[A-Za-z0-9._~][A-Za-z0-9._~-]*$/;
const HOST = /^[a-z0-9.-]+(:[0-9]{1,5})?$/;
const REF = /^[A-Za-z0-9._/][A-Za-z0-9._/+-]{0,199}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SECRET_KEYS = ["token", "password", "value", "secret", "auth", "username"];
const MAX_VALUE_BYTES = 64 * 1024;
const IDLE_TTL_S = 1800;
const TOOLS_CALL = ["checkpoint_list", "checkpoint_diff", "checkpoint_restore", "skill_list", "skill_view", "delegate_status", "delegate_cancel"];

function point(reason: string, minutesAgo: number, files: number): CheckpointInfo {
  const hash = createHash("sha1").update(randomBytes(8)).digest("hex");
  return { hash, short_hash: hash.slice(0, 8), timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(), reason, files_changed: files, insertions: files * 7, deletions: files * 2 };
}

const all = new WeakMap<MockState, C>();
function code(state: MockState): C {
  let c = all.get(state);
  if (!c) {
    c = { sessions: new Map(), creds: new Map(), clone: "ok", vault: true, limit: 3, restore: "card" };
    all.set(state, c);
  }
  return c;
}

class CodeErr extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** `forge.parse_repo` du noyau : l'URL propre, ou une erreur. */
export function parseRepo(url: string): string {
  const raw = String(url || "").trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    if (raw && !/^https:/i.test(raw)) throw new CodeErr(400, "https_required", "dépôt : https seulement");
    throw new CodeErr(400, "bad_url", "URL de dépôt illisible");
  }
  if (u.protocol !== "https:") throw new CodeErr(400, "https_required", "dépôt : https seulement");
  if (u.username || u.password || /^https:\/\/[^/]*@/i.test(raw))
    throw new CodeErr(400, "credentials_in_url", "identifiants dans l'URL refusés : range-les au coffre (PUT /v1/code/credentials/{nom}) et donne `credential: <nom>`");
  const host = u.host.toLowerCase();
  if (!HOST.test(host)) throw new CodeErr(400, "bad_url", "hôte de dépôt invalide");
  if (!HOSTS.includes(host)) throw new CodeErr(400, "host_not_allowed", `forge non autorisée : ${host} (code.forge.allowed_hosts)`);
  if (u.search || u.hash || raw.endsWith("?") || raw.endsWith("#")) throw new CodeErr(400, "bad_url", "URL de dépôt : ni requête ni fragment");
  // `new URL` résout déjà « .. » : on relit le chemin brut, comme le noyau.
  const rawPath = raw.replace(/^https:\/\/[^/]*/i, "");
  const segs = rawPath.split("/").filter(Boolean);
  if (!segs.length || segs.some((s) => s === "." || s === ".." || !SEGMENT.test(s))) throw new CodeErr(400, "bad_url", "chemin de dépôt invalide");
  return `https://${host}/${segs.join("/")}`;
}

/** `skills` et `subagents` de la vue `Session`, recalculés à chaque lecture. */
function sync(r: Rec): CodeSession {
  r.s.skills = { ...r.x.skills };
  r.s.subagents = { limit: MAX_SUBAGENTS, live: liveCount(r.x) };
  return r.s;
}

function live(c: C, user: string): Rec[] {
  return [...c.sessions.values()].filter((r) => r.user === user);
}

function create(state: MockState, c: C, user: string, body: Record<string, unknown>): CodeSession {
  if (householdMinor(state, user)) throw new CodeErr(403, "minor_not_allowed", "sessions de code : pas pour un profil mineur");
  const mode = String(body.mode || DEFAULT_MODE);
  if (!MODES.includes(mode)) throw new CodeErr(400, "bad_mode", `mode refusé : '${mode}' (parmi ${MODES.join(", ")})`);
  const repo = body.repo;
  let url: string | null = null;
  let ref: string | null = null;
  let cred: string | null = null;
  if (repo !== undefined && repo !== null) {
    if (typeof repo !== "object" || Array.isArray(repo)) throw new CodeErr(400, "bad_repo", "repo : {url, credential?, ref?, depth?}");
    const r = repo as Record<string, unknown>;
    if (SECRET_KEYS.some((k) => k in r))
      throw new CodeErr(400, "secret_value_refused", "une valeur d'identifiant n'entre jamais dans la requête de session : PUT /v1/code/credentials/{nom}, puis credential: <nom>");
    url = parseRepo(String(r.url ?? ""));
    if (r.ref !== undefined && r.ref !== null) {
      ref = String(r.ref);
      if (!REF.test(ref) || ref.includes("..") || ref.startsWith("-")) throw new CodeErr(400, "bad_ref", "ref : nom de branche ou d'étiquette");
    }
    if (r.depth !== undefined && r.depth !== null) {
      const d = r.depth;
      if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 100_000) throw new CodeErr(400, "bad_depth", "depth : entier de 1 à 100000");
    }
    if (r.credential !== undefined && r.credential !== null) {
      cred = String(r.credential);
      if (!NAME.test(cred)) throw new CodeErr(400, "bad_name", "credential : nom de secret invalide");
      if (!c.vault) throw new CodeErr(503, "vault_unavailable", "pas de coffre pour les identifiants de forge (code.secrets)");
      if (!c.creds.has(cred)) throw new CodeErr(400, "credential_missing", `identifiant ${cred} absent du coffre de ce locataire`);
    }
  }
  if (live(c, user).length >= c.limit) throw new CodeErr(409, "session_limit", `${c.limit} sessions de code ouvertes au plus par utilisateur : fermes-en une`);
  if (url && c.clone === "git_missing") throw new CodeErr(503, "git_missing", "git absent de l'image du noyau");
  if (url && c.clone === "clone_failed") throw new CodeErr(502, "clone_failed", "clone refusé par la forge (dépôt introuvable ou accès refusé)");
  const id = `cs_${randomBytes(8).toString("hex")}`;
  const now = new Date().toISOString();
  const s: CodeSession = { id, thread_id: id, status: "active", mode, workspace: MOUNT, backend: "kubernetes", repo: url ? { url, ref, credential: cred } : null, created_at: now, last_used_at: now };
  const x = extrasFor(!!url);
  c.sessions.set(id, { s, user, points: [point("before patch src/app.py", 2, 1), point("before terminal", 9, 2), point("session start", 15, 0)], busy: false, x });
  sync(c.sessions.get(id)!);
  // Le fil de la session au hub, au nom du compte (§7.28.3).
  const t = state.createThread("code session" + (url ? ` — ${url}` : ""), { id, members: [user] });
  t.thread.owner = user;
  return s;
}

function own(c: C, user: string, id: string): Rec {
  const r = c.sessions.get(id);
  if (!r || r.user !== user) throw new CodeErr(404, "not_found", "session inconnue");
  return r;
}

export async function handleCode(state: MockState, user: string | null, method: string, url: URL, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const path = url.pathname;
  if (path === "/v1/dev/code-mock" && method === "POST") {
    const c = code(state);
    const b = await readBody();
    if (b.clone === "ok" || b.clone === "clone_failed" || b.clone === "git_missing") c.clone = b.clone;
    if (typeof b.vault === "boolean") c.vault = b.vault;
    if (b.restore === "card" || b.restore === "direct") c.restore = b.restore;
    if (typeof b.limit === "number" && b.limit >= 1) c.limit = b.limit;
    const pick = (v: unknown): Rec[] => (v === true ? [...c.sessions.values()] : Array.isArray(v) ? v.map((x) => c.sessions.get(String(x))).filter((r): r is Rec => !!r) : []);
    for (const r of pick(b.idle)) r.s.status = "idle";
    for (const r of pick(b.active)) (r.s.status = "active"), (r.s.last_used_at = new Date().toISOString());
    for (const r of c.sessions.values()) r.busy = pick(b.turn_running).includes(r) || (b.turn_running === undefined && r.busy);
    // Skills du dépôt et sous-agents : `{skills|spawn|finish: {session, …}}`.
    for (const k of ["skills", "spawn", "finish"] as const) {
      const v = b[k] as { session?: string } | undefined;
      if (!v) continue;
      const r = c.sessions.get(String(v.session ?? ""));
      if (!r) return send(404, { error: { code: "not_found", message: "session inconnue" } }), true;
      const why = devExtras(state, r.s.id, r.x, { [k]: v });
      if (why) return send(409, { error: { code: "refused", message: why } }), true;
    }
    return send(200, { clone: c.clone, vault: c.vault, limit: c.limit, restore: c.restore, sessions: [...c.sessions.values()].map(sync) }), true;
  }
  if (!(path === "/v1/code/sessions" || path === "/v1/code/credentials" || path.startsWith("/v1/code/sessions/") || path.startsWith("/v1/code/credentials/"))) return false;
  if (!state.code) return false; // drapeau éteint : 404 comme avant
  if (!user) return send(401, { error: { code: "unauthorized", message: "unauthorized" } }), true;
  if (user === LOCAL_OWNER) return send(403, { error: { code: "account_required", message: "sessions de code : compte requis" } }), true;
  const c = code(state);
  const b = method === "POST" || method === "PUT" ? await readBody() : {};
  try {
    const out = dispatch(state, c, user, method, path, url, b);
    if (!out) return send(404, { error: { code: "not_found", message: "not found" } }), true;
    return send(out[0], out[1]), true;
  } catch (e) {
    if (e instanceof CodeErr) return send(e.status, { error: { code: e.code, message: e.message } }), true;
    throw e;
  }
}

function dispatch(state: MockState, c: C, user: string, method: string, path: string, url: URL, b: Record<string, unknown>): [number, unknown] | null {
  if (path === "/v1/code/sessions") {
    if (method === "GET") return [200, { sessions: live(c, user).map(sync), limit: c.limit, modes: MODES, default_mode: DEFAULT_MODE, idle_ttl_s: IDLE_TTL_S }];
    if (method === "POST") return [201, create(state, c, user, b)];
    return null;
  }
  const ms = /^\/v1\/code\/sessions\/([^/]+)(\/hooks\/trust|\/skills\/trust|\/tools\/call)?$/.exec(path);
  if (ms) {
    const id = decodeURIComponent(ms[1]!);
    if (ms[2] === "/tools/call") return method === "POST" ? toolCall(state, c, own(c, user, id), b) : null;
    if (ms[2] === "/skills/trust") {
      if (method !== "POST") return null;
      try {
        return [200, trustSkills(id, own(c, user, id).x, b.sha256)];
      } catch (e) {
        if (e instanceof SkillsErr) throw new CodeErr(e.status, e.code, e.message);
        throw e;
      }
    }
    if (ms[2]) return method === "POST" ? (own(c, user, id), [404, { error: { code: "not_found", message: "hooks désactivés (code.hooks) ou pas de hooks de dépôt" } }]) : null;
    if (method === "GET") return [200, sync(own(c, user, id))];
    if (method === "DELETE") {
      stopKids(state, id, own(c, user, id).x);
      c.sessions.delete(id);
      const purge = ["1", "true"].includes(url.searchParams.get("purge") ?? "0");
      return [200, { id, closed: true, purged: purge }];
    }
    return null;
  }
  if (path === "/v1/code/credentials") {
    if (method !== "GET") return null;
    if (!c.vault) throw new CodeErr(503, "vault_unavailable", "pas de coffre pour les identifiants de forge (code.secrets)");
    return [200, { credentials: [...c.creds.values()].sort((a, z) => a.name.localeCompare(z.name)) }];
  }
  const mc = /^\/v1\/code\/credentials\/([^/]+)$/.exec(path);
  if (mc) {
    const name = decodeURIComponent(mc[1]!);
    if (method !== "PUT" && method !== "DELETE") return null;
    if (!NAME.test(name)) throw new CodeErr(400, "bad_name", "nom de secret invalide");
    if (!c.vault) throw new CodeErr(503, "vault_unavailable", "pas de coffre pour les identifiants de forge (code.secrets)");
    if (method === "PUT") {
      const v = b.value;
      if (typeof v !== "string" || !v) throw new CodeErr(400, "bad_value", "valeur de secret requise (chaîne non vide)");
      if (Buffer.byteLength(v, "utf8") > MAX_VALUE_BYTES) throw new CodeErr(400, "bad_value", "valeur de secret trop longue (plus de 64 Kio)");
      c.creds.set(name, { name, updated_at: new Date().toISOString() });
      return [200, { name, set: true }];
    }
    if (!c.creds.delete(name)) throw new CodeErr(404, "not_found", `identifiant ${name} absent`);
    return [200, { name, deleted: true }];
  }
  return null;
}

/** `POST /v1/code/sessions/{cs}/tools/call` : le prochain outil rouvre le bac à sable (la session repasse `active`). */
function toolCall(state: MockState, c: C, r: Rec, b: Record<string, unknown>): [number, unknown] {
  const name = String(b.name ?? "");
  const args = b.arguments ?? {};
  if (!TOOLS_CALL.includes(name)) throw new CodeErr(403, "tool_not_allowed", `outil non appelable directement : ${name}`);
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new CodeErr(400, "bad_arguments", "arguments : objet attendu");
  if (name === "delegate_status" && (args as Record<string, unknown>).wait_s) throw new CodeErr(400, "bad_arguments", "delegate_status hors tour : sans wait_s");
  if (r.busy) throw new CodeErr(409, "turn_running", "un tour est en cours sur ce fil");
  r.s.status = "active";
  r.s.last_used_at = new Date().toISOString();
  const a = args as Record<string, unknown>;
  const out = (payload: unknown, is_error = false): [number, unknown] => [200, { content: typeof payload === "string" ? payload : JSON.stringify(payload), is_error }];
  if (name === "checkpoint_list") return out(r.points);
  const extra = extraTool(state, r.s.id, r.x, name, a);
  if (extra) return out(extra.payload, extra.error);
  const find = (h: unknown): CheckpointInfo | undefined => r.points.find((p) => typeof h === "string" && h.length >= 4 && p.hash.startsWith(h));
  if (name === "checkpoint_diff") {
    if (a.hash !== undefined && !find(a.hash)) return out("point de retour inconnu", true);
    const n = a.hash ? r.points.indexOf(find(a.hash)!) : r.points.length - 1;
    if (n <= 0) return out({ stat: "", diff: "", message: "aucun changement" });
    return out({ stat: " src/app.py | 4 +++-\n 1 file changed, 3 insertions(+), 1 deletion(-)", diff: "--- a/src/app.py\n+++ b/src/app.py\n@@ -1,3 +1,5 @@\n-def main():\n+def main() -> int:\n+    run()\n+    return 0\n" });
  }
  // checkpoint_restore : DESTRUCTIVE → carte forte, une fois (§7.28.7).
  if (!a.hash) return out("argument manquant : hash", true);
  const target = find(a.hash);
  if (!target) return out({ success: false, error: "point de retour inconnu" }, true);
  const restoreArgs = { hash: target.hash, ...(typeof a.file === "string" && a.file ? { file: a.file } : {}), safe: a.safe !== false };
  const restore = (): string => {
    r.points.unshift(point(`avant retour à ${target.short_hash.slice(0, 7)}`, 0, target.files_changed));
    return `retour à ${target.short_hash}`;
  };
  if (r.s.mode === "plan") return out("refusé par le noyau (mode plan : aucune écriture)", true);
  if (c.restore === "direct") {
    restore();
    return out({ success: true, restored_to: target.hash.slice(0, 8), reason: target.reason, restored_files: ["src/app.py"], skipped_user_edits: [] });
  }
  const approval: Approval = {
    id: randomId("appr"),
    thread_id: r.s.thread_id,
    turn_index: 0,
    channel: "web",
    tool_name: "checkpoint_restore",
    arguments: restoreArgs,
    args_sha256: createHash("sha256").update(JSON.stringify(restoreArgs)).digest("hex"),
    effect: "destructive",
    rule: "checkpoints:restore",
    reason: `checkpoint_restore: restore to ${target.short_hash}`,
    advice: null,
    strength: "strong",
    status: "pending",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    decided_by: null,
    decided_via: null,
    decided_at: null,
    result_summary: null,
    error: null,
  };
  state.approvals.set(approval.id, approval);
  state.approvalEffects.set(approval.id, restore);
  state.publish({ type: "approval.requested", approval });
  return [202, { approval_id: approval.id }];
}
