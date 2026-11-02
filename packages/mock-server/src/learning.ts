/**
 * Apprentissage (noyau docs/LEARNING.md, APPROVALS.md §7), comme le noyau : notes en attente, journal, skills appris
 * (versions, diff unifié, retour, `0` = désactiver) et règles suggérées (`rule_store` : `user_settings` pour le
 * propriétaire de Lokkal, null au nuage → 409 no_rule_store). `MOCK_LEARNING=off` : tout en 404, comme un drapeau éteint.
 */
import type { ApprovalSuggestion, JournalEntry, PendingNote, SkillVersion } from "@nokker-apps/sdk";
import { LOCAL_OWNER, type MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;

interface Learning {
  notes: PendingNote[];
  journal: JournalEntry[];
  skills: Map<string, SkillVersion[]>;
  suggestions: ApprovalSuggestion[];
}

const now = (): string => new Date().toISOString();
const ago = (h: number): string => new Date(Date.now() - h * 3600_000).toISOString();
let seq = 0;
const nid = (p: string): string => `${p}_${(++seq).toString(16).padStart(16, "0")}`;

const SKILL_V1 = "---\nname: deploy-docs\ndescription: Publier la doc du site\n---\n1. Construire le site.\n2. Pousser sur la branche docs.\n";
const SKILL_V2 = "---\nname: deploy-docs\ndescription: Publier la doc du site\n---\n1. Construire le site.\n2. Vérifier les liens.\n3. Pousser sur la branche docs.\n";

function seed(): Learning {
  const note = (title: string, text: string, scope: "project" | "user", h: number): PendingNote => ({
    id: nid("mp"), source: "memory_note", kind: "rule", title, text, scope, derived_from: scope === "user" ? "user" : "agent", project: "",
    links: [], thread_id: "th_demo_general", turn_index: 4, at: ago(h), status: "pending", decided_at: null, decided_by: null, result: null,
  });
  const v = (version: number, op: SkillVersion["op"], content: string, h: number, extra: Partial<SkillVersion> = {}): SkillVersion => ({
    name: "deploy-docs", version, sha256: `${version}`.repeat(64).slice(0, 64), op, active: true, reverted_to: null, thread_id: "th_demo_infra",
    turn_index: 7, actor: "agent", approval_id: `ap_demo${version}`, at: ago(h), content, ...extra,
  });
  const notes = [note("Rapports le lundi", "Le rapport d'activité part le lundi à 9 h, pas le vendredi.", "project", 2), note("Tutoiement", "Tutoie-moi dans les réponses.", "user", 5)];
  const skills = new Map<string, SkillVersion[]>([["deploy-docs", [v(1, "create", SKILL_V1, 72), v(2, "update", SKILL_V2, 30)]]]);
  const journal: JournalEntry[] = [
    { id: nid("lj"), kind: "memory.pending", subject: notes[1]!.id, at: notes[1]!.at, actor: "agent", version: null, thread_id: "th_demo_general", turn_index: 4, detail: { source: "memory_note", kind: "rule", scope: "user", title: "Tutoiement" } },
    { id: nid("lj"), kind: "skill.updated", subject: "deploy-docs", at: ago(30), actor: "agent", version: 2, thread_id: "th_demo_infra", turn_index: 7, detail: { active: true } },
    { id: nid("lj"), kind: "memory.approved", subject: nid("mp"), at: ago(48), actor: "owner", version: null, thread_id: "th_demo_general", turn_index: 2, detail: { source: "memory_note", kind: "fact", scope: "project", title: "Serveur de staging", note: "fact-serveur-de-staging" } },
    { id: nid("lj"), kind: "skill.created", subject: "deploy-docs", at: ago(72), actor: "agent", version: 1, thread_id: "th_demo_infra", turn_index: 7, detail: { active: true } },
  ];
  const suggestions: ApprovalSuggestion[] = [
    { id: nid("sg"), rule: "terminal(npm test*)", tool: "terminal", approved: 7, rejected: 0, approval_ids: [], first_at: ago(200), last_at: ago(3) },
    { id: nid("sg"), rule: "write_file(docs/**)", tool: "write_file", approved: 5, rejected: 0, approval_ids: [], first_at: ago(150), last_at: ago(20) },
  ];
  return { notes, journal, skills, suggestions };
}

function lstate(state: MockState): Learning {
  const s = state as MockState & { learning?: Learning };
  return (s.learning ??= seed());
}

function unifiedDiff(name: string, a: SkillVersion, b: SkillVersion): string {
  if (a.content === b.content) return "";
  const x = (a.content ?? "").split("\n");
  const y = (b.content ?? "").split("\n");
  const out = [`--- ${name}@v${a.version}`, `+++ ${name}@v${b.version}`, `@@ -1,${x.length} +1,${y.length} @@`];
  // Diff simple ligne à ligne (suffisant pour la démo) : communes, retirées, ajoutées.
  const ys = new Set(y);
  const xs = new Set(x);
  for (const l of x) out.push(ys.has(l) ? ` ${l}` : `-${l}`);
  for (const l of y) if (!xs.has(l)) out.push(`+${l}`);
  return out.join("\n");
}

const err = (send: Send, status: number, code: string, message: string): true => (send(status, { error: { code, message } }), true);

export async function handleLearning(state: MockState, user: string | null, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const bare = path.split("?", 1)[0]!;
  const learningRoute = bare.startsWith("/v1/learning/") || bare.startsWith("/v1/memory/pending");
  const suggestionsRoute = bare.startsWith("/v1/approvals/suggestions");
  if (!learningRoute && !suggestionsRoute) return false;
  if (process.env.MOCK_LEARNING === "off") return send(404, { error: { message: "not found" } }), true;
  if (!user) return send(401, { error: { message: "authentification requise" } }), true;
  const L = lstate(state);
  const q = new URLSearchParams(path.split("?", 2)[1] ?? "");

  if (method === "GET" && bare === "/v1/memory/pending") {
    const status = q.get("status") ?? "pending";
    if (!["pending", "approved", "rejected", "all"].includes(status)) return err(send, 400, "bad_query", "status ∈ pending, approved, rejected, all");
    return send(200, { notes: L.notes.filter((n) => status === "all" || n.status === status) }), true;
  }
  const dec = /^\/v1\/memory\/pending\/([^/]+)\/(approve|reject)$/.exec(bare);
  if (method === "POST" && dec) {
    const n = L.notes.find((x) => x.id === dec[1]);
    if (!n) return err(send, 404, "unknown_note", "note inconnue");
    if (n.status !== "pending") return err(send, 409, "already_decided", "déjà décidée");
    const ok = dec[2] === "approve";
    Object.assign(n, { status: ok ? "approved" : "rejected", decided_at: now(), decided_by: user, result: ok ? `${n.kind}-${n.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : null });
    L.journal.unshift({ id: nid("lj"), kind: ok ? "memory.approved" : "memory.rejected", subject: n.id, at: now(), actor: "owner", version: null, thread_id: n.thread_id, turn_index: n.turn_index, detail: { source: n.source, kind: n.kind, scope: n.scope, title: n.title, note: n.result } });
    return send(200, { note: n }), true;
  }
  if (method === "GET" && bare === "/v1/learning/journal") {
    const limit = Number(q.get("limit") ?? 200);
    if (!Number.isInteger(limit)) return err(send, 400, "bad_query", "limit entier");
    return send(200, { entries: L.journal.slice(0, Math.min(1000, Math.max(1, limit))) }), true;
  }
  if (method === "GET" && bare === "/v1/learning/skills") {
    return send(200, { skills: [...L.skills.entries()].map(([name, vs]) => { const c = vs[vs.length - 1]!; return { name, version: c.version, active: c.active, at: c.at }; }) }), true;
  }
  const sk = /^\/v1\/learning\/skills\/([a-z0-9][a-z0-9-]{1,63})(\/revert)?$/.exec(bare);
  if (sk) {
    const vs = L.skills.get(sk[1]!);
    if (!vs) return err(send, 404, "unknown_skill", "skill inconnu");
    const cur = vs[vs.length - 1]!;
    if (method === "GET" && !sk[2]) {
      const strip = (v: SkillVersion): SkillVersion => { const { content: _c, ...rest } = v; return rest as SkillVersion; };
      const out: Record<string, unknown> = { name: sk[1], current: cur.version, active: cur.active, versions: vs.map(strip) };
      const vq = q.get("version");
      const dq = q.get("diff_from");
      if (vq || dq) {
        const want = vq ? vs.find((v) => v.version === Number(vq)) : cur;
        if (!want) return err(send, 404, "unknown_version", "version inconnue");
        out.version = want;
        if (dq) {
          const from = vs.find((v) => v.version === Number(dq));
          if (!from) return err(send, 404, "unknown_version", "version inconnue");
          out.diff = unifiedDiff(sk[1]!, from, want);
        }
      }
      return send(200, out), true;
    }
    if (method === "POST" && sk[2]) {
      const body = await readBody();
      const version = body.version;
      if (typeof version !== "number" || !Number.isInteger(version)) return err(send, 400, "bad_body", "{version: entier}");
      if (version < 0) return err(send, 400, "bad_version", "version ≥ 0");
      const next = cur.version + 1;
      if (version === 0) {
        if (!cur.active) return err(send, 409, "unchanged", "déjà désactivé");
        vs.push({ ...cur, version: next, op: "disable", active: false, reverted_to: null, actor: "owner", approval_id: null, at: now() });
        L.journal.unshift({ id: nid("lj"), kind: "skill.disabled", subject: sk[1]!, at: now(), actor: "owner", version: next, detail: { active: false } });
        return send(200, { skill: sk[1], version: next, op: "disable", active: false, reverted_to: null }), true;
      }
      const target = vs.find((v) => v.version === version && v.op !== "disable");
      if (!target) return err(send, 404, "unknown_version", "version inconnue");
      if (cur.active && target.content === cur.content) return err(send, 409, "unchanged", "déjà le contenu actif");
      vs.push({ ...target, version: next, op: "revert", active: true, reverted_to: version, actor: "owner", approval_id: null, at: now() });
      L.journal.unshift({ id: nid("lj"), kind: "skill.reverted", subject: sk[1]!, at: now(), actor: "owner", version: next, detail: { active: true, reverted_to: version } });
      return send(200, { skill: sk[1], version: next, op: "revert", active: true, reverted_to: version }), true;
    }
    return false;
  }
  if (method === "GET" && bare === "/v1/approvals/suggestions") {
    return send(200, { suggestions: L.suggestions, rule_store: user === LOCAL_OWNER ? "user_settings" : null, threshold: 5, window_days: 30 }), true;
  }
  const sg = /^\/v1\/approvals\/suggestions\/([^/]+)\/(accept|dismiss)$/.exec(bare);
  if (method === "POST" && sg) {
    const s = L.suggestions.find((x) => x.id === sg[1]);
    if (!s) return send(404, { error: { message: "not found" } }), true;
    if (sg[2] === "accept" && user !== LOCAL_OWNER) return err(send, 409, "no_rule_store", "pas de réglages de règles ici : accepte sur la machine");
    L.suggestions = L.suggestions.filter((x) => x !== s);
    return send(200, { id: s.id, state: sg[2] === "accept" ? "accepted" : "dismissed", rule: s.rule }), true;
  }
  return false;
}
