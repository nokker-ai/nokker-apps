/**
 * Routes locales de démo (jeton local) : processus et aperçu (X6, LOKKAL §7.7), coffre (X4, §7.10), confiance des
 * hooks (X3, §7.9). Réglage : `POST /v1/dev/local-machine-mock {process?, hooks_thread?, memory_thread?}` pose un
 * processus de démo, émet `hook.untrusted` / `memory.noted` sur un fil. Les valeurs de secrets sont gardées en mémoire
 * et ne ressortent jamais.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LocalProcess } from "@nokker-apps/sdk";
import { LOCAL_OWNER, type MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;

interface LM {
  processes: LocalProcess[];
  secrets: Map<string, { value: string; updated_at: number }>;
  hooks: Map<string, string>; // thread → sha256 en attente de confiance
  sealed: boolean;
}
const all = new WeakMap<MockState, LM>();
function lm(state: MockState): LM {
  let m = all.get(state);
  if (!m) all.set(state, (m = { processes: [], secrets: new Map(), hooks: new Map(), sealed: false }));
  return m;
}
const KEY = randomBytes(16);
const sign = (id: string, exp: number): string => createHmac("sha256", KEY).update(`${id}:${exp}`).digest("hex").slice(0, 24);
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

export async function handleLocalMachineDev(state: MockState, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  if (method !== "POST" || path !== "/v1/dev/local-machine-mock") return false;
  const m = lm(state);
  const b = await readBody();
  if (b.process === true) {
    m.processes.push({ thread_id: "th_demo", id: `bg_${randomBytes(4).toString("hex")}`, name: "vite", command: "npx vite --base ./ --port 5173", state: "running", port: 5173, started_at: Date.now() / 1000 });
    m.processes.push({ thread_id: "th_demo", id: `bg_${randomBytes(4).toString("hex")}`, name: "tests", command: "pnpm test --watch=false", state: "exited", returncode: 1, started_at: Date.now() / 1000 - 300, ended_at: Date.now() / 1000 - 280 });
  }
  if (typeof b.hooks_thread === "string") {
    const sha = randomBytes(32).toString("hex");
    m.hooks.set(b.hooks_thread, sha);
    state.publish({ type: "hook.untrusted", thread_id: b.hooks_thread, sha256: sha, count: 2, notice: "Relis .nokker/settings.json du dépôt avant de leur faire confiance." });
  }
  if (typeof b.memory_thread === "string") {
    state.publish({ type: "memory.noted", thread_id: b.memory_thread, turn_index: 0, name: "rule-tests-avant-commit-1a2b", kind: "rule", scope: "project", title: "Lancer les tests avant chaque commit", derived_from: "user" });
  }
  if (typeof b.sealed === "boolean") m.sealed = b.sealed;
  send(200, { ok: true });
  return true;
}

/** Aperçu signé, sans en-tête d'auth (la capacité est dans le chemin) : servi AVANT l'authentification. */
export function handlePreview(state: MockState, req: IncomingMessage, res: ServerResponse, path: string): boolean {
  const pm = /^\/v1\/local\/preview\/([^/]+)\/(\d+)\.([0-9a-f]{24})(\/.*)?$/.exec(path);
  if (!pm || (req.method !== "GET" && req.method !== "HEAD")) return false;
  const [, id, exp, sig] = pm as unknown as [string, string, string, string];
  const p = lm(state).processes.find((x) => x.id === id);
  if (!p || Number(exp) < Date.now() / 1000 || sign(id, Number(exp)) !== sig) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("aperçu inconnu ou expiré");
    return true;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  res.end(`<!doctype html><meta charset="utf-8"><title>${p.name}</title><body style="font:16px system-ui;display:grid;place-items:center;min-height:90vh"><main><h1>Appli de démo</h1><p>Servie par « ${p.name} » sur le port ${p.port} (démo).</p></main>`);
  return true;
}

export async function handleLocalMachine(state: MockState, user: string | null, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const hit = path === "/v1/local/processes" || path.startsWith("/v1/local/processes/") || path === "/v1/local/secrets" || path.startsWith("/v1/local/secrets/") || path === "/v1/local/hooks/trust";
  if (!hit) return false;
  if (user !== LOCAL_OWNER) return send(401, { error: { message: "jeton local requis" } }), true;
  const m = lm(state);
  if (method === "GET" && path === "/v1/local/processes") return send(200, { processes: m.processes }), true;
  const link = /^\/v1\/local\/processes\/([^/]+)\/link$/.exec(path);
  if (method === "POST" && link) {
    const p = m.processes.find((x) => x.id === link[1]);
    if (!p || !p.port || p.state !== "running") return send(404, { error: { message: "processus sans port ou arrêté" } }), true;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return send(200, { url: `/v1/local/preview/${p.id}/${exp}.${sign(p.id, exp)}/`, expires_at: exp, port: p.port }), true;
  }
  if (path === "/v1/local/secrets" && method === "GET") {
    return send(200, { provider: "file", ...(m.sealed ? { sealed: true } : {}), secrets: [...m.secrets.entries()].map(([name, v]) => ({ name, updated_at: v.updated_at })) }), true;
  }
  const sec = /^\/v1\/local\/secrets\/([^/]+)$/.exec(path);
  if (sec) {
    if (m.sealed) return send(503, { error: { code: "sealed", message: "coffre scellé : déscelle-le sur la machine" } }), true;
    const name = decodeURIComponent(sec[1]!);
    if (!NAME.test(name)) return send(400, { error: { message: "nom invalide" } }), true;
    if (method === "PUT") {
      const b = await readBody();
      if (typeof b.value !== "string" || !b.value) return send(400, { error: { message: "valeur vide" } }), true;
      const updated_at = Math.floor(Date.now() / 1000);
      m.secrets.set(name, { value: b.value, updated_at });
      return send(200, { name, updated_at }), true;
    }
    if (method === "DELETE") {
      if (!m.secrets.delete(name)) return send(404, { error: { message: "secret inconnu" } }), true;
      return send(200, { name, deleted: true }), true;
    }
  }
  if (path === "/v1/local/hooks/trust" && method === "POST") {
    const b = await readBody();
    const tid = String(b.thread_id ?? "");
    const want = m.hooks.get(tid);
    if (!want) return send(404, { error: { message: "fil sans hooks de dépôt" } }), true;
    if (b.sha256 !== want) return send(409, { error: { message: "le bloc des hooks a changé depuis l'ouverture" } }), true;
    m.hooks.delete(tid);
    return send(200, { thread_id: tid, root: "/home/alice/projets/site", sha256: want, trusted: true }), true;
  }
  return false;
}
