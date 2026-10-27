/**
 * Projets d'équipe (X17, LOKKAL §7.15) — mock. Démo : « Marketing site » (alice propriétaire), « Research » (bob
 * propriétaire, alice lectrice) et une invitation en attente pour alice vers « Shared accounting ». Non-membre = 404
 * identique à un projet inconnu ; rôle insuffisant = 403 `forbidden` ; une valeur de secret = 400 avant tout contrôle.
 */
import { randomBytes } from "node:crypto";
import type { BudgetWindow, MyInvitation, Project, ProjectAuditEvent, ProjectBudgetCap, ProjectBudgetView, QuarantinedNote, ProjectInvitation, ProjectMember, ProjectNote, ProjectRole, ProjectRules, ProjectSkill } from "@nokker-apps/sdk";
import { MOCK_USER, type MockState } from "./state.js";
import { ssoGate, ssoSeed, type SsoSession } from "./sso.js";

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
  quarantine: QuarantinedNote[];
  audit: ProjectAuditEvent[];
  /** Agents des autres membres (ils vivent dans LEUR locataire : jamais dans `state.agents`). */
  others: { id: string; name: string; status: string; trigger: Record<string, unknown> | null; last_run: { status: string; ended_at: string | null } | null; owner: string }[];
  /** Dépense de démo par compte (jour, mois), dans la devise du plafond. */
  spend: Record<string, { today: number; month: number }>;
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
      quarantine: [],
      audit: [],
      others: [],
      spend: {},
    };
    for (const [u, role] of [[owner, "owner"] as [string, ProjectRole], ...members]) pr.members.set(u, { account_id: u, email: EMAIL(u), role, added_at: now() - 86400 * 3, you: false });
    t.projects.set(pid, pr);
    return pr;
  };
  const site = mk("Marketing site", MOCK_USER, [["bob", "maintainer"], ["sam", "viewer"]], {
    description: "The public site and its pricing page (demo).",
    repos: [{ key: "forge.example.com/team/site", memory_project: "p-0a1b2c3d4e5f6a7b" }],
    secret_names: [{ name: "ANALYTICS_KEY", description: "audience measurement" }],
    budget: { monthly: 50, currency: "CHF" },
    rules: { mode: "default", ask: ["terminal(git push*)"], deny: ["terminal(rm -rf*)"] },
    mirror: true,
  });
  site.skills.push({ name: "accessibility-review", source: "github:example/skills/a11y", description: "reviews contrast and labels", requires_local: false, added_by: "bob", added_at: now() - 7200 });
  site.notes.push({ name: "rule-pricing-final-1a2b", kind: "rule", deleted: false, sha: "a1", updated_at: now() - 5000, author_account: "bob", seq: 1, title: "Displayed prices are final (no VAT)", text: "The company is not subject to VAT: never write “excl. VAT”." });
  site.others.push({ id: "ag_0b0b0b0b0b0b", name: "Competitor watch", status: "armed", trigger: { kind: "schedule", cron: "0 8 * * 1-5", tz: "Europe/Zurich" }, last_run: { status: "done", ended_at: new Date(Date.now() - 3600_000).toISOString() }, owner: "bob" });
  site.spend = { [MOCK_USER]: { today: 1.2, month: 18.4 }, bob: { today: 3.1, month: 27.9 }, carol: { today: 0, month: 2.5 } };
  site.quarantine.push({ id: 1, project_id: site.p.id, name: "rule-pricing-final-1a2b", kind: "rule", title: "Displayed prices exclude VAT", text: "Write “excl. VAT” after every price.", sha: "a0", updated_at: now() - 9000, author_account: "sam", author_machine: "host-1", reason: "conflit : remplacée par une écriture reçue plus tard", quarantined_at: now() - 5000 });
  mk("Research", "bob", [[MOCK_USER, "viewer"]], { description: "Watch notes (demo)." });
  const compta = mk("Shared accounting", "bob", []);
  compta.invitations.push({ id: id("iv"), email: EMAIL(MOCK_USER), role: "member", state: "pending", created_at: now() - 600, expires_at: now() + 14 * 86400, decided_at: null });
  return t;
}
function team(state: MockState): T {
  let t = all.get(state);
  if (!t) {
    all.set(state, (t = seed()));
    if (state.sso) ssoSeed(state, [...t.projects.values()].map((pr) => ({ id: pr.p.id, name: pr.p.name, owner: pr.p.owner_account })));
  }
  return t;
}

/** Pour le SSO (§7.24) : adhésion d'un compte, et pose/retrait d'un rôle tenu par les groupes (le propriétaire n'est
 * jamais touché : c'est à l'appelant de le vérifier). */
export function teamMember(state: MockState, pid: string, user: string): { role: ProjectRole; owner: string } | null {
  const pr = team(state).projects.get(pid);
  const me = pr?.members.get(user);
  return pr && me ? { role: me.role, owner: pr.p.owner_account } : null;
}
/** Démo posée (et SSO semé si le drapeau est allumé) avant toute route SSO. */
export function teamReady(state: MockState): void {
  team(state);
}
export function teamProjectOwner(state: MockState, pid: string): string | null {
  return team(state).projects.get(pid)?.p.owner_account ?? null;
}
export function teamSetMember(state: MockState, pid: string, user: string, role: ProjectRole | null): void {
  const pr = team(state).projects.get(pid);
  if (!pr) return;
  if (role === null) pr.members.delete(user);
  else pr.members.set(user, { ...(pr.members.get(user) ?? { account_id: user, email: EMAIL(user), added_at: now(), you: false }), role });
}

const err = (send: Send, status: number, code: string, message: string): true => (send(status, { error: { code, message } }), true);
const view = (pr: P, user: string): Project => ({ ...pr.p, role: pr.members.get(user)!.role });

export async function handleTeam(
  state: MockState,
  user: string,
  method: string,
  url: URL,
  readBody: () => Promise<Record<string, unknown>>,
  send: Send,
  session: SsoSession = { via: null, at: null },
): Promise<boolean> {
  const path = url.pathname;
  if (path !== "/v1/projects" && !path.startsWith("/v1/projects/")) return false;
  const t = team(state);
  const mine = [...t.projects.values()].filter((pr) => pr.members.has(user));
  const invitesFor = () => [...t.projects.values()].flatMap((pr) => pr.invitations.filter((iv) => iv.state === "pending" && iv.email === EMAIL(user)).map((iv) => ({ pr, iv })));

  // SSO obligatoire (§7.24) : sans connexion SSO assez récente, le nom et le chemin de connexion, rien du contenu.
  const gated = (pr: P): string | null => ssoGate(state, pr.p.id, user, pr.members.get(user)!.role === "owner", session);
  const entry = (pr: P) => {
    const sc = gated(pr);
    return sc ? { id: pr.p.id, name: pr.p.name, role: pr.members.get(user)!.role, created_at: pr.p.created_at, sso: { required: true, connection: sc } } : view(pr, user);
  };
  if (path === "/v1/projects" && method === "GET") return send(200, { projects: mine.map(entry), invitations: invitesFor().length }), true;
  if (path === "/v1/projects" && method === "POST") {
    const b = await readBody();
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) return err(send, 400, "invalid", "nom requis");
    const pid = id("pj");
    const pr: P = { p: { id: pid, name, description: typeof b.description === "string" ? b.description : null, owner_account: user, repos: [], secret_names: [], budget: null, rules: { ask: [], deny: [] }, mirror: false, created_at: now(), updated_at: now() }, members: new Map([[user, { account_id: user, email: EMAIL(user), role: "owner", added_at: now(), you: true }]]), invitations: [], skills: [], notes: [], quarantine: [], audit: [], others: [], spend: {} };
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
  const sc = gated(pr);
  if (sc) return send(403, { error: { code: "sso_required", connection: sc, message: `connexion SSO requise pour ce projet (${sc})` } }), true;
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
  if (tail === "/notes/quarantine" && method === "GET") {
    if (!need("maintainer")) return forbid();
    return send(200, { quarantine: pr.quarantine }), true;
  }
  const journal = (event: string, detail: Record<string, unknown>): void => {
    pr.audit.unshift({ id: pr.audit.length + 1, at: new Date().toISOString(), actor_account: user, event, detail });
  };
  const rq = /^\/notes\/quarantine\/([^/]+)\/restore$/.exec(tail);
  if (rq && method === "POST") {
    if (!need("maintainer")) return forbid();
    const q = pr.quarantine.find((x) => String(x.id) === decodeURIComponent(rq[1]!));
    if (!q) return err(send, 404, "not_found", "version inconnue dans la quarantaine de ce projet");
    const cur = pr.notes.find((n) => n.name === q.name);
    if (cur && cur.sha === q.sha && !cur.deleted) return err(send, 409, "already_current", "cette version est déjà la version courante");
    const seq = Math.max(0, ...pr.notes.map((n) => n.seq)) + 1;
    if (cur && !cur.deleted) {
      // La version courante part en quarantaine à son tour : rien n'est effacé.
      pr.quarantine.push({ id: Math.max(0, ...pr.quarantine.map((x) => Number(x.id))) + 1, project_id: pr.p.id, name: cur.name, kind: cur.kind, title: cur.title ?? "", text: cur.text ?? "", sha: cur.sha, updated_at: cur.updated_at, author_account: cur.author_account, reason: "remplacée par la restauration d'une version de la quarantaine", quarantined_at: new Date().toISOString(), restored_at: null, restored_by: null });
    }
    const note: ProjectNote = { name: q.name, kind: q.kind, deleted: false, sha: q.sha, updated_at: now(), author_account: q.author_account, seq, title: q.title, text: q.text };
    pr.notes = [...pr.notes.filter((n) => n.name !== q.name), note];
    q.restored_at = new Date().toISOString();
    q.restored_by = user;
    journal("note_restored", { name: q.name, quarantine_id: q.id, sha: q.sha });
    return send(200, { note }), true;
  }
  if (tail === "/agents" && method === "GET") {
    const mine = [...state.agents.values()].filter((a) => a.project === pr.p.id).map((a) => ({ ...a, owner: { account_id: user, email: EMAIL(user) }, mine: true, can_disarm: a.status === "armed" }));
    const others = pr.others.filter((o) => pr.members.has(o.owner)).map((o) => ({ id: o.id, name: o.name, status: o.status, trigger: o.trigger, last_run: o.last_run, owner: { account_id: o.owner, email: EMAIL(o.owner) }, mine: false, can_disarm: o.status === "armed" && role === "owner" }));
    return send(200, { agents: [...mine, ...others] }), true;
  }
  const dis = /^\/agents\/([^/]+)\/disarm$/.exec(tail);
  if (dis && method === "POST") {
    const id = decodeURIComponent(dis[1]!);
    const a = state.agents.get(id);
    if (a && a.project === pr.p.id) {
      if (a.status === "armed") {
        a.status = "paused";
        a.next_run_at = null;
        state.publish({ type: "agent.updated", agent: a });
      }
      return send(200, { agent: { ...a, owner: { account_id: user, email: EMAIL(user) }, mine: true, can_disarm: false } }), true;
    }
    const o = pr.others.find((x) => x.id === id && pr.members.has(x.owner));
    if (!o) return err(send, 404, "not_found", "agent inconnu dans ce projet");
    if (role !== "owner") return err(send, 403, "forbidden", "seul le propriétaire de l'agent agit sur lui ; l'owner du projet peut seulement le désarmer");
    if (o.status === "armed") o.status = "paused";
    journal("agent_disarmed", { agent_id: o.id, name: o.name, owner_account: o.owner });
    return send(200, { agent: { id: o.id, name: o.name, status: o.status, trigger: o.trigger, last_run: o.last_run, owner: { account_id: o.owner, email: EMAIL(o.owner) }, mine: false, can_disarm: false } }), true;
  }
  if (tail === "/budget") {
    if (method === "GET") return send(200, budgetView(pr, user, role)), true;
    if (!need("maintainer")) return forbid();
    if (method === "DELETE") {
      if (pr.p.budget) journal("budget_removed", {});
      pr.p.budget = null;
      touch();
      return send(200, { budget: null }), true;
    }
    if (method === "PUT") {
      const b = await readBody();
      const unknown = Object.keys(b).filter((k) => !["daily", "monthly", "currency"].includes(k));
      if (unknown.length) return err(send, 400, "bad_request", `budget : clé inconnue ${unknown.sort()[0]}`);
      const out: Partial<ProjectBudgetCap> = {};
      for (const k of ["daily", "monthly"] as const) {
        if (b[k] === undefined || b[k] === null) continue;
        const v = Number(b[k]);
        if (!Number.isFinite(v) || v < 0 || v > 1_000_000) return err(send, 400, "bad_request", `budget.${k} : entre 0 et 1 000 000`);
        out[k] = Math.round(v * 100) / 100;
      }
      if (out.daily === undefined && out.monthly === undefined) return err(send, 400, "bad_request", "budget : daily et/ou monthly (ou null pour aucun plafond)");
      const currency = String(b.currency ?? "EUR").toUpperCase();
      if (!["EUR", "CHF", "USD"].includes(currency)) return err(send, 400, "bad_request", "budget.currency : EUR | CHF | USD");
      pr.p.budget = { ...out, currency: currency as ProjectBudgetCap["currency"] };
      touch();
      journal("budget_set", { ...pr.p.budget });
      return send(200, { budget: pr.p.budget }), true;
    }
  }
  if (tail === "/audit" && method === "GET") {
    if (!need("maintainer")) return forbid();
    const n = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500));
    return send(200, { events: pr.audit.slice(0, n) }), true;
  }
  return err(send, 404, "not_found", "projet inconnu");
}

/** Vue du budget (§7.27.1) : fenêtres civiles en heure suisse ; owner et maintainer voient chaque membre. */
function budgetView(pr: P, user: string, role: ProjectRole): ProjectBudgetView {
  const b = pr.p.budget;
  const day = Object.values(pr.spend).reduce((s, x) => s + x.today, 0);
  const month = Object.values(pr.spend).reduce((s, x) => s + x.month, 0);
  const zurich = (d: Date) => new Date(d.toLocaleString("en-US", { timeZone: "Europe/Zurich" }));
  const z = zurich(new Date());
  const resetsDay = new Date(z.getFullYear(), z.getMonth(), z.getDate() + 1).toISOString();
  const resetsMonth = new Date(z.getFullYear(), z.getMonth() + 1, 1).toISOString();
  const win = (spent: number, cap: number | undefined, resets_at: string): BudgetWindow => {
    const ratio = cap ? spent / cap : null;
    return { spent: Math.round(spent * 100) / 100, cap: cap ?? null, ratio: ratio === null ? null : Math.round(ratio * 10000) / 10000, state: cap === undefined ? "none" : spent >= cap ? "over" : ratio! >= 0.8 ? "warning" : "ok", resets_at };
  };
  const seeAll = RANK[role] >= RANK.maintainer;
  const accounts = new Set([...pr.members.keys(), ...Object.keys(pr.spend)]);
  const members = [...accounts]
    .filter((a) => seeAll || a === user)
    .map((a) => {
      const m = pr.members.get(a);
      return { account_id: a, email: m ? m.email : null, role: m ? m.role : null, you: a === user, today: pr.spend[a]?.today ?? 0, month: pr.spend[a]?.month ?? 0, ...(m ? {} : { former: true }) };
    });
  return { project_id: pr.p.id, budget: b, currency: b?.currency ?? "EUR", counted: true, tz: "Europe/Zurich", today: win(day, b?.daily, resetsDay), month: win(month, b?.monthly, resetsMonth), members, unconverted: [], unpriced_models: [] };
}
