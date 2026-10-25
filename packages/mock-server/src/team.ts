/**
 * Projets d'équipe (X17, LOKKAL §7.15) — mock. Démo : « Site vitrine » (alice propriétaire), « Recherche » (bob
 * propriétaire, alice lectrice) et une invitation en attente pour alice vers « Compta partagée ». Non-membre = 404
 * identique à un projet inconnu ; rôle insuffisant = 403 `forbidden` ; une valeur de secret = 400 avant tout contrôle.
 */
import { randomBytes } from "node:crypto";
import type { MyInvitation, Project, ProjectInvitation, ProjectMember, ProjectNote, ProjectRole, ProjectRules, ProjectSkill } from "@nokker-apps/sdk";
import { MOCK_USER, type MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;
const RANK: Record<ProjectRole, number> = { viewer: 0, member: 1, maintainer: 2, owner: 3 };
const EMAIL = (u: string): string => `${u}@example.com`;
const id = (p: string): string => `${p}_${randomBytes(6).toString("hex")}`;
const now = (): number => Math.floor(Date.now() / 1000);

interface P {
  p: Omit<Project, "role">;
  members: Map<string, ProjectMember>;
  invitations: ProjectInvitation[];
  skills: ProjectSkill[];
  notes: ProjectNote[];
}
interface T {
  projects: Map<string, P>;
}
const all = new WeakMap<MockState, T>();

function seed(): T {
  const t: T = { projects: new Map() };
  const mk = (name: string, owner: string, members: [string, ProjectRole][], extra: Partial<Omit<Project, "role">> = {}): P => {
    const pid = id("pj");
    const pr: P = {
      p: { id: pid, name, description: null, owner_account: owner, repos: [], secret_names: [], budget: null, rules: { ask: [], deny: [] }, mirror: false, created_at: now() - 86400 * 4, updated_at: now() - 3600, ...extra },
      members: new Map(),
      invitations: [],
      skills: [],
      notes: [],
    };
    for (const [u, role] of [[owner, "owner"] as [string, ProjectRole], ...members]) pr.members.set(u, { account_id: u, email: EMAIL(u), role, added_at: now() - 86400 * 3, you: false });
    t.projects.set(pid, pr);
    return pr;
  };
  const site = mk("Site vitrine", MOCK_USER, [["bob", "maintainer"], ["sam", "viewer"]], {
    description: "Le site public et sa page tarifs (démo).",
    repos: [{ key: "forge.example.com/equipe/site", memory_project: "p-0a1b2c3d4e5f6a7b" }],
    secret_names: [{ name: "CLE_ANALYTICS", description: "mesure d'audience" }],
    budget: { monthly: 50, currency: "CHF" },
    rules: { mode: "default", ask: ["terminal(git push*)"], deny: ["terminal(rm -rf*)"] },
    mirror: true,
  });
  site.skills.push({ name: "revue-accessibilite", source: "github:exemple/skills/a11y", description: "relit les contrastes et les libellés", requires_local: false, added_by: "bob", added_at: now() - 7200 });
  site.notes.push({ name: "rule-tarifs-ttc-1a2b", kind: "rule", deleted: false, sha: "a1", updated_at: now() - 5000, author_account: "bob", seq: 1, title: "Les prix affichés sont finaux (pas de TVA)", text: "La société n'est pas assujettie : ne jamais écrire « HT »." });
  mk("Recherche", "bob", [[MOCK_USER, "viewer"]], { description: "Notes de veille (démo)." });
  const compta = mk("Compta partagée", "bob", []);
  compta.invitations.push({ id: id("iv"), email: EMAIL(MOCK_USER), role: "member", state: "pending", created_at: now() - 600, expires_at: now() + 14 * 86400, decided_at: null });
  return t;
}
function team(state: MockState): T {
  let t = all.get(state);
  if (!t) all.set(state, (t = seed()));
  return t;
}

const err = (send: Send, status: number, code: string, message: string): true => (send(status, { error: { code, message } }), true);
const view = (pr: P, user: string): Project => ({ ...pr.p, role: pr.members.get(user)!.role });

export async function handleTeam(state: MockState, user: string, method: string, url: URL, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const path = url.pathname;
  if (path !== "/v1/projects" && !path.startsWith("/v1/projects/")) return false;
  const t = team(state);
  const mine = [...t.projects.values()].filter((pr) => pr.members.has(user));
  const invitesFor = () => [...t.projects.values()].flatMap((pr) => pr.invitations.filter((iv) => iv.state === "pending" && iv.email === EMAIL(user)).map((iv) => ({ pr, iv })));

  if (path === "/v1/projects" && method === "GET") return send(200, { projects: mine.map((pr) => view(pr, user)), invitations: invitesFor().length }), true;
  if (path === "/v1/projects" && method === "POST") {
    const b = await readBody();
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) return err(send, 400, "invalid", "nom requis");
    const pid = id("pj");
    const pr: P = { p: { id: pid, name, description: typeof b.description === "string" ? b.description : null, owner_account: user, repos: [], secret_names: [], budget: null, rules: { ask: [], deny: [] }, mirror: false, created_at: now(), updated_at: now() }, members: new Map([[user, { account_id: user, email: EMAIL(user), role: "owner", added_at: now(), you: true }]]), invitations: [], skills: [], notes: [] };
    t.projects.set(pid, pr);
    return send(201, view(pr, user)), true;
  }
  if (path === "/v1/projects/invitations" && method === "GET") {
    const out: MyInvitation[] = invitesFor().map(({ pr, iv }) => ({ id: iv.id, project: { id: pr.p.id, name: pr.p.name }, role: iv.role, created_at: iv.created_at, expires_at: iv.expires_at }));
    return send(200, { invitations: out }), true;
  }
  const ans = /^\/v1\/projects\/invitations\/([^/]+)\/(accept|decline)$/.exec(path);
  if (ans && method === "POST") {
    const hit = invitesFor().find(({ iv }) => iv.id === ans[1]);
    if (!hit) return err(send, 404, "not_found", "invitation inconnue");
    hit.iv.state = ans[2] === "accept" ? "accepted" : "declined";
    hit.iv.decided_at = now();
    if (ans[2] === "decline") return send(200, { declined: true }), true;
    hit.pr.members.set(user, { account_id: user, email: EMAIL(user), role: hit.iv.role, added_at: now(), you: true });
    return send(200, view(hit.pr, user)), true;
  }

  const m = /^\/v1\/projects\/([^/]+)(\/.*)?$/.exec(path)!;
  const pr = t.projects.get(decodeURIComponent(m[1]!));
  const tail = m[2] ?? "";
  // Une valeur de secret est refusée AVANT tout contrôle de droits : elle n'est jamais rangée.
  if (tail.startsWith("/secrets/") && method === "PUT") {
    const b = await readBody();
    if (["value", "secret", "token", "password"].some((k) => k in b)) return err(send, 400, "secret_value_refused", "un secret se déclare par son nom ; sa valeur reste dans le coffre de chaque membre");
  }
  if (!pr || !pr.members.has(user)) return err(send, 404, "not_found", "projet inconnu");
  const role = pr.members.get(user)!.role;
  const need = (r: ProjectRole): boolean => RANK[role] >= RANK[r];
  const forbid = (): true => err(send, 403, "forbidden", "rôle insuffisant");
  const touch = () => (pr.p.updated_at = now());

  if (tail === "" && method === "GET") return send(200, view(pr, user)), true;
  if (tail === "" && method === "PATCH") {
    const b = await readBody();
    if ("mirror" in b) {
      if (!need("owner")) return forbid();
      pr.p.mirror = b.mirror === true;
    }
    if (["name", "description", "repos", "budget"].some((k) => k in b)) {
      if (!need("maintainer")) return forbid();
      if (typeof b.name === "string" && b.name.trim()) pr.p.name = b.name.trim();
      if (typeof b.description === "string") pr.p.description = b.description;
      if (Array.isArray(b.repos)) pr.p.repos = b.repos.map((k) => ({ key: String(k), memory_project: `p-${randomBytes(8).toString("hex")}` }));
      if (b.budget === null || (typeof b.budget === "object" && b.budget)) pr.p.budget = b.budget as Project["budget"];
    }
    touch();
    return send(200, view(pr, user)), true;
  }
  if (tail === "" && method === "DELETE") {
    if (!need("owner")) return forbid();
    t.projects.delete(pr.p.id);
    return send(200, { deleted: true }), true;
  }
  if (tail === "/members" && method === "GET") return send(200, { members: [...pr.members.values()].map((x) => ({ ...x, you: x.account_id === user })) }), true;
  const mem = /^\/members\/([^/]+)$/.exec(tail);
  if (mem) {
    const target = pr.members.get(decodeURIComponent(mem[1]!));
    if (!target) return err(send, 404, "not_found", "membre inconnu");
    if (method === "PATCH") {
      if (!need("owner")) return forbid();
      if (target.role === "owner") return err(send, 409, "owner_fixed", "le propriétaire ne change pas de rôle");
      const b = await readBody();
      if (b.role !== "maintainer" && b.role !== "member" && b.role !== "viewer") return err(send, 400, "invalid", "rôle inconnu");
      target.role = b.role;
      return send(200, target), true;
    }
    if (method === "DELETE") {
      const self = target.account_id === user;
      if (target.role === "owner") return err(send, 409, "owner_fixed", "le propriétaire ne quitte pas son projet");
      if (!self && !need("owner")) return forbid();
      pr.members.delete(target.account_id);
      return send(200, { removed: true }), true;
    }
  }
  if (tail === "/invitations") {
    if (!need("owner")) return forbid();
    if (method === "GET") return send(200, { invitations: pr.invitations }), true;
    if (method === "POST") {
      const b = await readBody();
      const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(send, 400, "invalid", "adresse invalide");
      if ([...pr.members.values()].some((x) => x.email === email)) return err(send, 409, "already_member", "déjà membre");
      if (pr.invitations.some((iv) => iv.email === email && iv.state === "pending")) return err(send, 409, "already_invited", "déjà invitée");
      const iv: ProjectInvitation = { id: id("iv"), email, role: (["maintainer", "member", "viewer"] as ProjectRole[]).includes(b.role as ProjectRole) ? (b.role as ProjectRole) : "member", state: "pending", created_at: now(), expires_at: now() + 14 * 86400, decided_at: null };
      pr.invitations.push(iv);
      return send(201, iv), true;
    }
  }
  const ivm = /^\/invitations\/([^/]+)$/.exec(tail);
  if (ivm && method === "DELETE") {
    if (!need("owner")) return forbid();
    const iv = pr.invitations.find((x) => x.id === ivm[1]);
    if (!iv) return err(send, 404, "not_found", "invitation inconnue");
    iv.state = "revoked";
    return send(200, { revoked: true }), true;
  }
  if (tail === "/skills" && method === "GET") return send(200, { skills: pr.skills }), true;
  const sk = /^\/skills\/([^/]+)$/.exec(tail);
  if (sk) {
    if (!need("maintainer")) return forbid();
    const name = decodeURIComponent(sk[1]!);
    if (method === "PUT") {
      const b = await readBody();
      const source = typeof b.source === "string" ? b.source.trim() : "";
      if (!/^(github:[\w.-]+\/[\w./-]+|https:\/\/[^@\s]+|official\/[\w-]+\/[\w-]+)$/.test(source)) return err(send, 400, "invalid", "source : github:…, https://… ou official/…");
      const s: ProjectSkill = { name, source, description: typeof b.description === "string" ? b.description : null, requires_local: b.requires_local === true, added_by: user, added_at: now() };
      pr.skills = [...pr.skills.filter((x) => x.name !== name), s];
      return send(200, s), true;
    }
    if (method === "DELETE") {
      pr.skills = pr.skills.filter((x) => x.name !== name);
      return send(200, { removed: true }), true;
    }
  }
  if (tail === "/rules") {
    if (method === "GET") return send(200, { rules: pr.p.rules }), true;
    if (method === "PUT") {
      if (!need("maintainer")) return forbid();
      const b = await readBody();
      if ("allow" in b || b.mode === "auto") return err(send, 400, "rules_widen", "les règles d'un projet restreignent seulement (pas d'allow, pas de mode auto)");
      const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
      const rules: ProjectRules = { ...(b.mode === "plan" || b.mode === "default" || b.mode === "accept_edits" ? { mode: b.mode } : {}), ask: list(b.ask), deny: list(b.deny) };
      pr.p.rules = rules;
      touch();
      return send(200, { rules }), true;
    }
  }
  if (tail === "/secrets" && method === "GET") return send(200, { secrets: pr.p.secret_names }), true;
  const sec = /^\/secrets\/([^/]+)$/.exec(tail);
  if (sec) {
    if (!need("maintainer")) return forbid();
    const name = decodeURIComponent(sec[1]!);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) return err(send, 400, "invalid", "nom invalide");
    if (method === "PUT") {
      const b = await readBody();
      const s = { name, description: typeof b.description === "string" ? b.description : null };
      pr.p.secret_names = [...pr.p.secret_names.filter((x) => x.name !== name), s];
      return send(200, s), true;
    }
    if (method === "DELETE") {
      pr.p.secret_names = pr.p.secret_names.filter((x) => x.name !== name);
      return send(200, { removed: true }), true;
    }
  }
  if (tail === "/notes" && method === "GET") {
    if (!pr.p.mirror) return err(send, 409, "mirror_off", "projet pas en miroir");
    return send(200, { notes: pr.notes, cursor: pr.notes.length }), true;
  }
  if (tail === "/agents" && method === "GET") return send(200, { agents: [...state.agents.values()].filter((a) => a.project === pr.p.id) }), true;
  return err(send, 404, "not_found", "projet inconnu");
}
