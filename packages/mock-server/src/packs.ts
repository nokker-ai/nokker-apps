/**
 * Packs d'agents (LOKKAL §7.30, BUBBLES §9.6) — mock. Web derrière le drapeau `packs_web` (option `packsWeb` ou
 * `MOCK_PACKS_WEB=1`, éteint par défaut comme le noyau : 404 sur /v1/packs*) ; Lokkal : `GET /v1/local/packs` et
 * `POST /v1/local/packs/{nom}/remove` (jeton local). Démo : « mail » s'installe entier au web, « ops » en partie (un
 * agent demande le serveur MCP « monitoring » de la machine), « mcp-builder » rien (409 machine_only), « video » est
 * refusé par le scanner (422 scan_refused). Une machine liée de démo, « host-1 », déclare « monitoring ».
 * Installer avec un fil pose des cartes `agent_draft` (rien de créé ni d'armé) ; activer une carte crée l'agent avec
 * son `origin {pack, template}` ; retirer ferme les cartes encore ouvertes et, s'il reste des agents du pack, pose
 * UNE carte `pack_agents` (désarmer / supprimer / garder, décidés en direct).
 */
import type { Agent, PackDetail, PackInstallResult, PackMachine, PackNeed, PackSummary } from "@nokker-apps/sdk";
import { closeBubble, createBubble, registerDirectAction, updateBubble } from "./bubbles.js";
import { proposeHandoff } from "./handoff.js";
import { LOCAL_OWNER, MOCK_USER, type MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;

interface Tpl {
  id: string;
  name: string;
  role: string;
  tools: string[];
  needs: PackNeed[];
}
interface DemoPack {
  name: string;
  title: string;
  description: string;
  connectors: string[];
  mcp: string[];
  skills: { name: string; family: string; description: string; locality: "local" | "both" }[];
  agents: Tpl[];
  refused?: boolean;
}

const PACKS: DemoPack[] = [
  {
    name: "mail",
    title: "Mail and calendar",
    description: "Trie la boîte, prépare les réponses et le résumé du matin (démo).",
    connectors: ["mail", "calendar"],
    mcp: [],
    skills: [
      { name: "mail-triage", family: "mail", description: "Classer et résumer les messages reçus.", locality: "both" },
      { name: "mail-reply", family: "mail", description: "Préparer une réponse en brouillon, jamais l'envoyer seul.", locality: "both" },
    ],
    agents: [{ id: "mail-digest", name: "Résumé du matin", role: "Résume la boîte chaque matin", tools: ["mail_search", "mail_read", "bubble_show"], needs: [] }],
  },
  {
    name: "ops",
    title: "Ops runbooks",
    description: "Runbooks d'exploitation : notes d'incident au web, contrôles sur la machine (démo).",
    connectors: [],
    mcp: ["monitoring"],
    skills: [
      { name: "incident-notes", family: "ops", description: "Tenir la chronologie d'un incident.", locality: "both" },
      { name: "runbook-ssh", family: "ops", description: "Dérouler un runbook sur un hôte (ssh).", locality: "local" },
    ],
    agents: [
      { id: "incident-scribe", name: "Scribe d'incident", role: "Tient la chronologie des incidents", tools: ["web_search", "bubble_show"], needs: [] },
      { id: "ops-watch", name: "Veilleur ops", role: "Surveille les alertes de la supervision", tools: ["monitoring.alerts"], needs: [{ kind: "mcp", name: "monitoring" }] },
    ],
  },
  {
    name: "mcp-builder",
    title: "MCP builder",
    description: "Construire et tester un serveur MCP sur la machine (démo).",
    connectors: [],
    mcp: [],
    skills: [{ name: "mcp-scaffold", family: "mcp", description: "Squelette d'un serveur MCP et ses tests.", locality: "local" }],
    agents: [],
  },
  {
    name: "video",
    title: "Video",
    description: "Montage et sous-titres (démo : refusé par le scanner).",
    connectors: [],
    mcp: [],
    skills: [{ name: "subtitles", family: "video", description: "Sous-titrer une vidéo.", locality: "both" }],
    agents: [],
    refused: true,
  },
];
const LINKED = [{ machine_id: "mc_0a1b2c3d4e5f6a7b", name: "host-1", online: true }];
const DECLARED_MCP = ["monitoring"];

interface Install {
  version: number;
  installed_at: number;
  skills: string[];
  templates: string[];
  proposed: { template: string; bubble_id: string }[];
}
interface M {
  web: Map<string, Install>;
  local: Map<string, { removed: boolean }>;
}
const all = new WeakMap<MockState, M>();
function mp(state: MockState): M {
  let m = all.get(state);
  if (!m) all.set(state, (m = { web: new Map(), local: new Map([["mail", { removed: false }]]) }));
  return m;
}

const err = (send: Send, status: number, code: string, message: string, extra: Record<string, unknown> = {}): true => (send(status, { error: { code, message, ...extra } }), true);

function split(p: DemoPack): { web: { skills: string[]; agents: string[] }; machine: { skills: string[]; agents: { template: string; needs: PackNeed[] }[] } } {
  return {
    web: { skills: p.skills.filter((s) => s.locality === "both").map((s) => s.name), agents: p.agents.filter((a) => !a.needs.length).map((a) => a.id) },
    machine: { skills: p.skills.filter((s) => s.locality === "local").map((s) => s.name), agents: p.agents.filter((a) => a.needs.length).map((a) => ({ template: a.id, needs: a.needs })) },
  };
}

function summary(p: DemoPack, installed: boolean, web: boolean): PackSummary {
  return {
    name: p.name,
    title: p.title,
    description: p.description,
    skills: p.skills.map((s) => s.name),
    agents: p.agents.map((a) => a.id),
    connectors: p.connectors,
    mcp: p.mcp,
    needs: {},
    installed,
    ...(web ? split(p) : {}),
  };
}

const fromPack = (state: MockState, pack: string): Agent[] => [...state.agents.values()].filter((a) => a.origin?.pack === pack && a.created_by === MOCK_USER);

function machineOf(state: MockState, p: DemoPack, threadId: string | null, handoff: boolean): PackMachine {
  const s = split(p);
  const need = p.mcp.find((r) => DECLARED_MCP.includes(r));
  let proposal: PackMachine["handoff"] = null;
  if (handoff && need && threadId) {
    const b = proposeHandoff(state, threadId, { kind: "mcp", name: need, task: `pack_install {name: "${p.name}"}`, machine: LINKED[0]!.name, online: true });
    proposal = { machine_name: LINKED[0]!.name, bubble_id: b.id };
  }
  const next = proposal
    ? `relais proposé vers « ${LINKED[0]!.name} » : accepte-le pour installer le reste là-bas`
    : need
      ? `relais possible vers une machine liée qui déclare le mcp « ${need} » : la route d'installation avec handoff: true`
      : `aucune machine liée ne déclare ce que demande le reste du pack : ouvre Lokkal sur ta machine et lance pack_install ${p.name}`;
  return { skills: s.machine.skills, agents: s.machine.agents, linked: LINKED, handoff: proposal, next };
}

function propose(state: MockState, p: DemoPack, threadId: string, templates: string[]): { template: string; bubble_id: string }[] {
  return templates.map((id) => {
    const t = p.agents.find((a) => a.id === id)!;
    const b = createBubble(state, threadId, {
      kind: "agent_draft",
      title: `Nouvel agent : ${t.name}`,
      status: "idle",
      state: { name: t.name, role: t.role, model: "Apertus 70B (démo)", tools: t.tools, fill: 1, pack: p.name, template: t.id, needs: t.needs } as never,
      actions: [{ id: "activate", label: "Activer l'agent", primary: true }],
    });
    return { template: t.id, bubble_id: b.id };
  });
}

/** Suite d'un retrait (web ou Lokkal) : cartes ouvertes fermées ; agents du pack → UNE carte `pack_agents`. */
function removed(state: MockState, pack: string, proposed: string[], threadId: string | null) {
  const closed: string[] = [];
  for (const id of proposed) {
    const b = state.bubbles.get(id);
    if (b && b.kind === "agent_draft" && !b.closed_at) {
      closeBubble(state, id);
      closed.push(id);
    }
  }
  const agents = fromPack(state, pack).map((a) => ({ id: a.id, name: a.name, status: a.status, armed: a.status === "armed" }));
  let card: string | null = null;
  if (agents.length && threadId) {
    const st = { pack, agents, note: "le pack est retiré ; ces agents en viennent et restent tels quels tant que tu ne choisis pas" };
    const existing = [...state.bubbles.values()].find((b) => b.kind === "pack_agents" && b.thread_id === threadId && !b.closed_at && (b.state as { pack?: string }).pack === pack);
    const b = existing
      ? updateBubble(state, existing.id, { state: st as never })
      : createBubble(state, threadId, {
          kind: "pack_agents",
          title: `Agents du pack « ${pack} »`,
          status: "idle",
          state: st as never,
          actions: [
            { id: "disarm", label: "Désarmer" },
            { id: "delete", label: "Supprimer" },
            { id: "keep", label: "Garder", primary: true },
          ],
        });
    card = b.id;
  }
  return { drafts_closed: closed, agents, card, ...(agents.length ? { note: "les agents créés depuis ce pack sont gardés tels quels : la carte propose de les désarmer ou de les supprimer, l'utilisateur choisit" } : {}) };
}

// Carte `pack_agents` : décision en direct (§9.6), seulement sur les agents qui existent encore ET viennent du pack.
registerDirectAction("pack_agents", (state, b, actionId) => {
  if (!["disarm", "delete", "keep"].includes(actionId)) return null;
  const st = b.state as { pack: string; agents: { id: string }[] };
  const ids = st.agents.map((a) => a.id).filter((id) => state.agents.get(id)?.origin?.pack === st.pack);
  const done: string[] = [];
  for (const id of ids) {
    const a = state.agents.get(id)!;
    if (actionId === "disarm" && a.status === "armed") {
      a.status = "paused";
      a.next_run_at = null;
      state.publish({ type: "agent.updated", agent: a });
      done.push(id);
    } else if (actionId === "delete") {
      state.agents.delete(id);
      state.publish({ type: "agent.deleted", id });
      done.push(id);
    } else if (actionId === "keep") done.push(id);
  }
  closeBubble(state, b.id);
  return { closed: true, [actionId === "disarm" ? "disarmed" : actionId === "delete" ? "deleted" : "kept"]: done };
});

export async function handlePacks(state: MockState, user: string | null, method: string, url: URL, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, "");
  const m = mp(state);
  // Lokkal
  if (path === "/v1/local/packs" || path.startsWith("/v1/local/packs/")) {
    if (user !== LOCAL_OWNER) return send(401, { error: { message: "jeton local requis" } }), true;
    if (path === "/v1/local/packs" && method === "GET") return send(200, { packs: PACKS.map((p) => summary(p, m.local.get(p.name)?.removed === false, false)) }), true;
    const rm = /^\/v1\/local\/packs\/([^/]+)\/remove$/.exec(path);
    if (!rm || method !== "POST") return false;
    const name = decodeURIComponent(rm[1]!);
    if (!PACKS.some((p) => p.name === name)) return err(send, 404, "unknown_pack", `pack inconnu : '${name}'`);
    const b = await readBody();
    const thread = b.thread_id;
    if (thread !== undefined && typeof thread !== "string") return err(send, 400, "bad_body", "thread_id : identifiant de fil (texte)");
    if (thread && !state.threads.has(thread)) return err(send, 404, "unknown_thread", "fil inconnu");
    const rec = m.local.get(name);
    const already = !rec || rec.removed;
    const skills = already ? [] : PACKS.find((p) => p.name === name)!.skills.map((s) => `${s.family}/${s.name}`);
    m.local.set(name, { removed: true });
    return send(200, { removed: name, skills, already_removed: already, ...removed(state, name, [], thread || null) }), true;
  }
  if (path !== "/v1/packs" && !path.startsWith("/v1/packs/")) return false;
  if (!state.packsWeb) return false; // drapeau éteint : 404 comme avant
  if (!user) return send(401, { error: { message: "unauthorized" } }), true;
  const parts = path.slice("/v1/packs".length).split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0 && method === "GET") return send(200, { packs: PACKS.map((p) => summary(p, m.web.has(p.name), true)) }), true;
  const p = PACKS.find((x) => x.name === parts[0]);
  if (!p) return err(send, 404, "unknown_pack", `pack inconnu : '${String(parts[0]).slice(0, 40)}'`);
  const thread = (raw: unknown): string | null | false => (raw ? (state.threads.has(String(raw)) ? String(raw) : false) : null);
  if (parts.length === 1 && method === "GET") {
    const rec = m.web.get(p.name);
    const out: PackDetail = {
      ...summary(p, !!rec, true),
      skills: p.skills,
      agents: p.agents.map((a) => ({ id: a.id, name: a.name, role: a.role, trigger: { kind: "manual" }, auto_approve: [], needs: a.needs.length ? { mcp: a.needs.map((n) => n.name) } : {} })),
      mcp: p.mcp.map((r) => ({ role: r, purpose: "alertes de la supervision (démo)", examples: ["Prometheus Alertmanager"], optional: false, secrets: [], tools: { alerts: { default: "alerts_list", effect: "read" } } })),
      tools: [],
      ...(rec ? { install: { ...rec, bind: {} } } : {}),
      created_agents: fromPack(state, p.name).map((a) => ({ id: a.id, name: a.name, status: a.status, armed: a.status === "armed", template: a.origin?.template ?? null })),
    };
    return send(200, out), true;
  }
  if (parts.length === 1 && method === "DELETE") {
    const th = thread(url.searchParams.get("thread_id"));
    if (th === false) return err(send, 404, "unknown_thread", "fil inconnu");
    const rec = m.web.get(p.name);
    m.web.delete(p.name);
    return send(200, { removed: p.name, skills: rec?.skills ?? [], already_removed: !rec, ...removed(state, p.name, rec?.proposed.map((x) => x.bubble_id) ?? [], th) }), true;
  }
  if (parts.length === 2 && method === "POST" && (parts[1] === "install" || parts[1] === "propose")) {
    const b = await readBody();
    const th = thread(b.thread_id);
    if (th === false) return err(send, 404, "unknown_thread", "fil inconnu");
    const s = split(p);
    if (parts[1] === "propose") {
      const rec = m.web.get(p.name);
      if (!rec) return err(send, 404, "not_installed", `pack non installé sur ce compte : '${p.name}'`);
      if (!th) return err(send, 400, "thread_required", "thread_id requis : les cartes se posent dans un fil");
      const created = new Set(fromPack(state, p.name).map((a) => a.origin?.template));
      const want = Array.isArray(b.templates) ? (b.templates as string[]) : null;
      const proposed = propose(state, p, th, rec.templates.filter((t) => !created.has(t) && (!want || want.includes(t))));
      rec.proposed.push(...proposed);
      return send(200, { pack: p.name, proposed }), true;
    }
    if ("handoff" in b && typeof b.handoff !== "boolean") return err(send, 400, "bad_body", "handoff : booléen");
    if (!s.web.skills.length && !s.web.agents.length) return err(send, 409, "machine_only", `rien du pack « ${p.name} » ne s'installe au web : tout demande une machine`, { machine: machineOf(state, p, th, b.handoff === true) });
    if (p.refused) return err(send, 422, "scan_refused", "installation REFUSÉE par le scanner (rien n'a été installé)", { report: [`subtitles : instruction suspecte « ignore previous instructions » (démo)`] });
    const machine = s.machine.skills.length || s.machine.agents.length ? machineOf(state, p, th, b.handoff === true) : null;
    const rec: Install = { version: 1, installed_at: Date.now() / 1000, skills: s.web.skills, templates: s.web.agents, proposed: [] };
    m.web.set(p.name, rec);
    const proposed = th ? propose(state, p, th, s.web.agents) : [];
    rec.proposed = proposed;
    const out: PackInstallResult = {
      installed: p.name,
      version: 1,
      skills: s.web.skills,
      proposed,
      ...(th ? {} : { to_propose: s.web.agents.map((t) => ({ template: t, needs: [] })) }),
      armed: [],
      partial: machine !== null,
      machine,
      note: "aucun agent n'est créé ni armé : chaque carte s'active par l'utilisateur",
      ...(p.connectors.length ? { setup: [`connecteurs du compte à poser : ${p.connectors.join(", ")}`] } : {}),
    };
    return send(200, out), true;
  }
  return err(send, 404, "not_found", "not found");
}
