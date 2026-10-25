/**
 * Miroir de la machine (LOKKAL §7.23) — mock, jeton local seulement : `GET /v1/local/mirror`, `POST …/resync|resume`,
 * pages gardées en ligne (`GET|PUT /v1/local/mirror/pages…`), choix des projets mémoire (`GET|PUT …/projects…`).
 * Démo : miroir actif, canal `pages` en échec (réessai dans 40 s), une page au-dessus du plafond, une page `local`
 * (409 `local_page`), le projet mémoire du « Site vitrine » relié à son projet d'équipe.
 * Réglage : `POST /v1/dev/local-mirror-mock {enabled?, paused?, healthy?}`.
 */
import { randomBytes } from "node:crypto";
import type { LocalMirrorPage, LocalMirrorProject, LocalMirrorStatus, MirrorChannel, MirrorChannelState } from "@nokker-apps/sdk";
import { LOCAL_OWNER, type MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;
const now = (): number => Date.now() / 1000;
const QUOTA = 50 * 1024 * 1024;

interface Page extends Omit<LocalMirrorPage, "state" | "error"> {
  local: boolean;
}
interface M {
  enabled: boolean;
  paused: boolean;
  channels: Record<MirrorChannel, { last_ok_at: number | null; failures: number; last_error: MirrorChannelState["last_error"]; retry_at: number }>;
  pending: { turns: number; notes: number; team_notes: number; pages: number };
  resync: { requested: boolean; last_at: number | null };
  pages: Page[];
  projects: LocalMirrorProject[];
  used: number;
}
const all = new WeakMap<MockState, M>();

function seed(): M {
  const t = now();
  const ok = (ago: number) => ({ last_ok_at: t - ago, failures: 0, last_error: null, retry_at: 0 });
  const pid = () => `pg_${randomBytes(8).toString("hex")}`;
  return {
    enabled: true,
    paused: false,
    channels: {
      turns_push: ok(40),
      turns_pull: ok(25),
      notes: ok(300),
      team_notes: ok(300),
      pages: { last_ok_at: t - 900, failures: 2, last_error: { at: t - 10, kind: "ConnectTimeout", message: "ConnectTimeout" }, retry_at: t + 40 },
      resync: { last_ok_at: null, failures: 0, last_error: null, retry_at: 0 },
    },
    pending: { turns: 3, notes: 0, team_notes: 1, pages: 1 },
    resync: { requested: false, last_at: null },
    pages: [
      { page_id: pid(), title: "Rapport hebdo (démo)", version: 3, size: 48_200, mirror: true, local: false },
      { page_id: pid(), title: "Tableau des coûts (démo)", version: 1, size: 61 * 1024 * 1024, mirror: true, local: false },
      { page_id: pid(), title: "Notes de réunion (démo)", version: 2, size: 12_400, mirror: false, local: false },
      { page_id: pid(), title: "Brouillon privé (démo)", version: 1, size: 3_100, mirror: false, local: true },
    ],
    projects: [
      { project: "p-0a1b2c3d4e5f6a7b", label: "site", mirror: true },
      { project: "p-9f8e7d6c5b4a3f2e", label: "scripts-perso", mirror: false },
    ],
    used: 48_200,
  };
}
function mm(state: MockState): M {
  let m = all.get(state);
  if (!m) all.set(state, (m = seed()));
  return m;
}

function pageState(m: M, p: Page): Pick<LocalMirrorPage, "state" | "error"> {
  if (!p.mirror) return { state: "off", error: null };
  if (p.size > QUOTA) return { state: "quota", error: `plafond des pages copiées atteint (${Math.round(QUOTA / 1048576)} Mio)` };
  return { state: m.channels.pages.failures ? "pending" : "sent", error: null };
}

function status(m: M): LocalMirrorStatus {
  if (!m.enabled) return { enabled: false };
  const t = now();
  const channels: LocalMirrorStatus["channels"] = {};
  for (const [k, c] of Object.entries(m.channels) as [MirrorChannel, M["channels"][MirrorChannel]][]) {
    if (c.last_ok_at === null && !c.failures) continue;
    channels[k] = { last_ok_at: c.last_ok_at, failures: c.failures, last_error: c.last_error, retry_in_s: c.retry_at > t ? Math.round(c.retry_at - t) : 0 };
  }
  const waiting = Object.values(m.pending).some(Boolean);
  const sends = (["turns_push", "notes", "pages", "team_notes"] as const).map((k) => m.channels[k].last_ok_at).filter((x): x is number => x !== null);
  const last = sends.length ? Math.max(...sends) : null;
  return {
    enabled: true,
    paused: m.paused,
    push_cursor: 42,
    pull_cursor: 17,
    last_sent_at: last,
    behind_s: !waiting ? 0 : last === null ? null : Math.round(t - last),
    pending: { ...m.pending },
    channels,
    resync: { ...m.resync },
    pages_space: { used: m.used, quota: QUOTA },
    team: { projects: { "pj_demo|p-0a1b2c3d4e5f6a7b": { cursor: 4, notes: 1, name: "Site vitrine" } }, errors: {} },
  };
}

export async function handleLocalMirror(state: MockState, user: string | null, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  if (path === "/v1/dev/local-mirror-mock" && method === "POST") {
    const m = mm(state);
    const b = await readBody();
    if (typeof b.enabled === "boolean") m.enabled = b.enabled;
    if (typeof b.paused === "boolean") m.paused = b.paused;
    if (b.healthy === true) for (const c of Object.values(m.channels)) Object.assign(c, { failures: 0, last_error: null, retry_at: 0 });
    return send(200, status(m)), true;
  }
  if (path !== "/v1/local/mirror" && !path.startsWith("/v1/local/mirror/")) return false;
  if (user !== LOCAL_OWNER) return send(401, { error: { message: "jeton local requis" } }), true;
  const m = mm(state);
  if (path === "/v1/local/mirror/projects" && method === "GET") return send(200, { projects: m.projects }), true;
  const pj = /^\/v1\/local\/mirror\/projects\/([^/]+)$/.exec(path);
  if (pj && method === "PUT") {
    const b = await readBody();
    if (typeof b.mirror !== "boolean") return send(400, { error: { message: "corps {mirror: true|false} requis" } }), true;
    const p = m.projects.find((x) => x.project === decodeURIComponent(pj[1]!));
    if (!p) return send(404, { error: { message: "projet inconnu" } }), true;
    p.mirror = b.mirror;
    return send(200, { project: p.project, mirror: p.mirror }), true;
  }
  if (!m.enabled) return path === "/v1/local/mirror" && method === "GET" ? (send(200, { enabled: false }), true) : (send(404, { error: { message: "miroir non actif sur cette machine" } }), true);
  if (path === "/v1/local/mirror" && method === "GET") return send(200, status(m)), true;
  if (path === "/v1/local/mirror/resume" && method === "POST") {
    m.paused = false;
    return send(200, status(m)), true;
  }
  if (path === "/v1/local/mirror/resync" && method === "POST") {
    if (m.paused) return send(409, { error: { message: "miroir en pause (copies effacées) : reprendre d'abord" } }), true;
    m.resync.requested = true;
    state.later(1500, () => {
      const t = now();
      m.resync = { requested: false, last_at: t };
      for (const c of Object.values(m.channels)) Object.assign(c, { failures: 0, last_error: null, retry_at: 0, last_ok_at: t });
      m.pending = { turns: 0, notes: 0, team_notes: 0, pages: 0 };
    });
    return send(202, status(m)), true;
  }
  if (path === "/v1/local/mirror/pages" && method === "GET") return send(200, { pages: m.pages.map(({ local: _l, ...p }) => ({ ...p, ...pageState(m, { ...p, local: _l }) })), space: { used: m.used, quota: QUOTA } }), true;
  const pg = /^\/v1\/local\/mirror\/pages\/([^/]+)$/.exec(path);
  if (pg && method === "PUT") {
    const b = await readBody();
    if (typeof b.mirror !== "boolean") return send(400, { error: { message: "corps {mirror: true|false} requis" } }), true;
    const p = m.pages.find((x) => x.page_id === decodeURIComponent(pg[1]!));
    if (!p) return send(404, { error: { message: "page inconnue" } }), true;
    if (b.mirror && p.local) return send(409, { error: { code: "local_page", message: "page épinglée « local » : elle ne quitte pas la machine" } }), true;
    const before = p.mirror && p.size <= QUOTA;
    p.mirror = b.mirror;
    const after = p.mirror && p.size <= QUOTA;
    m.used += (after ? p.size : 0) - (before ? p.size : 0);
    return send(200, { page_id: p.page_id, mirror: p.mirror }), true;
  }
  return send(404, { error: { message: "inconnu" } }), true;
}
