/**
 * Mémoire de projet, skills du dépôt et sous-agents en arrière-plan du mock — mêmes contrats que le noyau :
 *
 *  - Mémoire de projet (LOKKAL.md §7.11.7) : outil `memory {action: list|view|forget, name?}` appelable par
 *    `POST /v1/local/tools/call` quand le drapeau est allumé (`state.projectMemory`, défaut oui comme le compose ; éteint :
 *    403 « outil non appelable directement »). Sections lues dans `AGENTS.md`, `NOKKER.md`, `CLAUDE.md` du dossier de la
 *    session jusqu'à la racine git (jamais au-dessus de la racine déclarée) ; une section ne s'oublie pas. `forget` a
 *    l'effet WRITE (passe en `accept_edits`, carte en `default`) et publie `memory.forgotten`.
 *  - Skills du dépôt (§7.21) : `<dépôt>/.nokker/skills/<famille>/<skill>/SKILL.md`, empreinte sha256 de l'arbre entier
 *    calculée comme le noyau ; confiance rangée dans les réglages de l'utilisateur (`trusted_project_skills`). Drapeau
 *    `state.projectSkills` (défaut non, comme le compose) : éteint, ni clé `skills` à l'ouverture ni route (404).
 *  - Sous-agents en arrière-plan (§7.22) : `delegate_status` (sans `wait_s` hors tour : 400) ; `delegate_cancel` n'est
 *    PAS appelable directement (403, comme le noyau) ; `POST /v1/threads/{id}/cancel` arrête les enfants du fil.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { DelegateStatusResult, ProjectMemoryList, ProjectMemoryNote, ProjectSkillsStatus, SkillInfo, SubagentView } from "@nokker-apps/sdk";
import type { MockState } from "./state.js";

// ---------------------------------------------------------------------------
// Dépôt : racine git sans dépasser la racine déclarée
// ---------------------------------------------------------------------------

/** Premier dossier qui porte `.git` en remontant de `cwd`, jamais au-dessus de `mountRoot` ; sinon `null`. */
export function findGitRoot(cwd: string, mountRoot: string): string | null {
  let cur = resolve(cwd);
  const top = resolve(mountRoot);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    if (cur === top) return null;
    const up = dirname(cur);
    if (up === cur || !(up === top || up.startsWith(top + sep))) return null;
    cur = up;
  }
}

// ---------------------------------------------------------------------------
// Mémoire de projet
// ---------------------------------------------------------------------------

const INSTRUCTION_FILES = ["AGENTS.md", "NOKKER.md", "CLAUDE.md"];
const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

interface Section {
  name: string;
  title: string;
  path: string;
  text: string;
}

interface Learned extends ProjectMemoryNote {
  text: string;
}

interface MemoryState {
  project: string;
  sources: { path: string; sections: Section[] }[];
  notes: Learned[];
}

const memories = new WeakMap<MockState, Map<string, MemoryState>>();

/** Sections `#` à `###` hors blocs de code (comme l'import du noyau). */
function splitSections(rel: string, text: string): Section[] {
  const out: Section[] = [];
  const tag = sha1(rel).slice(0, 8);
  let cur: { title: string; lines: string[] } | null = null;
  let fence = false;
  const flush = (): void => {
    if (cur) out.push({ name: `src-${tag}-${out.length + 1}`, title: cur.title, path: rel, text: cur.lines.join("\n").trim() });
  };
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h = fence ? null : /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      cur = { title: h[1]!, lines: [line] };
    } else {
      (cur ??= { title: rel, lines: [] }).lines.push(line);
    }
  }
  flush();
  return out.filter((s) => s.text);
}

/** Fichiers d'instructions du plus extérieur au plus proche, entre la racine git (ou le dossier) et `cwd`. */
function readSources(cwd: string, mountRoot: string): { path: string; sections: Section[] }[] {
  const top = findGitRoot(cwd, mountRoot) ?? resolve(cwd);
  const dirs: string[] = [];
  for (let d = resolve(cwd); ; d = dirname(d)) {
    dirs.unshift(d);
    if (d === top || dirname(d) === d) break;
  }
  const out: { path: string; sections: Section[] }[] = [];
  for (const d of dirs) {
    for (const f of INSTRUCTION_FILES) {
      const p = join(d, f);
      try {
        if (!lstatSync(p).isFile()) continue; // un lien symbolique est ignoré
        const rel = relative(top, p).split(sep).join("/") || f;
        out.push({ path: rel, sections: splitSections(rel, readFileSync(p, "utf-8").slice(0, 64 * 1024)) });
      } catch {
        // absent
      }
    }
  }
  return out;
}

const DEMO_NOTES = (threadId: string): Learned[] => [
  {
    name: "rule-run-tests-before-commit-3f2a",
    kind: "rule",
    scope: "project",
    title: "Run the test suite before every commit",
    origin: `${threadId}#0`,
    derived_from: "user",
    created: "2026-10-24T09:12:00+00:00",
    links: [],
    locality: "local",
    in_core: true,
    text: "The user asked to run the whole test suite (not only the changed file) before proposing a commit.",
  },
  {
    name: "fact-api-port-8c41",
    kind: "fact",
    scope: "project",
    title: "The dev API listens on port 5173",
    origin: `${threadId}#1`,
    derived_from: "repo",
    created: "2026-10-24T09:20:00+00:00",
    links: [],
    locality: "local",
    in_core: false,
    text: "vite.config.ts sets server.port to 5173.",
  },
];

function memoryFor(state: MockState, threadId: string): MemoryState {
  let m = memories.get(state);
  if (!m) memories.set(state, (m = new Map()));
  let st = m.get(threadId);
  if (!st) {
    const meta = state.localSessions.get(threadId);
    const sources = meta ? readSources(meta.cwd, meta.root) : [];
    st = { project: meta ? `local/${relative(meta.root, meta.cwd).split(sep).join("/") || "."}` : "", sources, notes: DEMO_NOTES(threadId) };
    m.set(threadId, st);
  }
  return st;
}

/** `memory.noted` de démo : la note entre aussi dans la liste du fil. */
export function addDemoNote(state: MockState, threadId: string, note: Learned): void {
  memoryFor(state, threadId).notes.push(note);
}

export interface ToolOut {
  content: string;
  is_error: boolean;
}
const json = (v: unknown): ToolOut => ({ content: JSON.stringify(v), is_error: false });
const err = (m: string): ToolOut => ({ content: m, is_error: true });

export function memoryTool(state: MockState, threadId: string, args: Record<string, unknown>): ToolOut {
  const st = memoryFor(state, threadId);
  const action = String(args.action ?? "list");
  const name = String(args.name ?? "").trim();
  const sections = new Map(st.sources.flatMap((s) => s.sections.map((x) => [x.name, x] as const)));
  if (action === "list") {
    const core = new Set(st.sources.flatMap((s) => s.sections.slice(0, 3).map((x) => x.name)));
    const list: ProjectMemoryList = {
      project: st.project || null,
      notes: st.notes.map(({ text: _t, ...n }) => (void _t, n)),
      sources: st.sources.map((s) => ({ path: s.path, sections: s.sections.map((x) => ({ name: x.name, title: x.title, in_core: core.has(x.name) })) })),
    };
    return json(list);
  }
  if (action === "view") {
    const n = st.notes.find((x) => x.name === name);
    if (n) return json(n);
    const s = sections.get(name);
    if (s) return json({ name: s.name, source: s.path, title: s.title, text: s.text });
    return err(`note inconnue : ${name}`);
  }
  if (action === "forget") {
    const s = sections.get(name);
    if (s) return err(`${name} vient de ${s.path} : modifie le fichier, la mémoire suit`);
    const i = st.notes.findIndex((x) => x.name === name);
    if (i < 0) return err(`note inconnue : ${name}`);
    const [n] = st.notes.splice(i, 1);
    state.publish({ type: "memory.forgotten", thread_id: threadId, name: n!.name, kind: n!.kind, scope: n!.scope });
    return json({ forgotten: n!.name });
  }
  return err("action ∈ list | view | forget");
}

// ---------------------------------------------------------------------------
// Skills du dépôt
// ---------------------------------------------------------------------------

const MAX_FILES = 500;
const MAX_BYTES = 4 * 1024 * 1024;

/** (empreinte, nombre de skills, raison du refus) — même calcul que le noyau : chemins relatifs triés, `F\0rel\0sha\n`
 * par fichier, `L\0rel\0cible\n` par lien symbolique (jamais suivi). */
export function projectSkillsSha256(dir: string): { sha256: string | null; count: number; why: string | null } {
  const h = createHash("sha256");
  let files = 0;
  let size = 0;
  let count = 0;
  const walk = (cur: string, rel: string): string | null => {
    const entries = readdirSync(cur, { withFileTypes: true });
    const linkToDir = (n: string): boolean => {
      try {
        return statSync(join(cur, n)).isDirectory();
      } catch {
        return false;
      }
    };
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const linkedDirs = entries.filter((e) => e.isSymbolicLink() && linkToDir(e.name)).map((e) => e.name).sort();
    // os.walk du noyau : les fichiers (liens vers fichier compris) triés, PUIS les liens vers un dossier ; jamais suivis
    const names = [...entries.filter((e) => !e.isDirectory() && !linkedDirs.includes(e.name)).map((e) => e.name).sort(), ...linkedDirs];
    for (const n of names) {
      const full = join(cur, n);
      const r = rel ? `${rel}/${n}` : n;
      if (++files > MAX_FILES) return `trop de fichiers (plus de ${MAX_FILES})`;
      if (lstatSync(full).isSymbolicLink()) {
        h.update(`L\0${r}\0${readlinkSync(full)}\n`);
        continue;
      }
      const data = readFileSync(full);
      size += data.length;
      if (size > MAX_BYTES) return "trop volumineux (plus de 4 Mio)";
      if (n === "SKILL.md") count++;
      h.update(`F\0${r}\0${createHash("sha256").update(data).digest("hex")}\n`);
    }
    for (const d of dirs) {
      const why = walk(join(cur, d), rel ? `${rel}/${d}` : d);
      if (why) return why;
    }
    return null;
  };
  const why = walk(dir, "");
  return why ? { sha256: null, count: 0, why } : { sha256: h.digest("hex"), count, why: null };
}

interface SkillsState extends ProjectSkillsStatus {
  dir: string;
}
const skillStates = new WeakMap<MockState, Map<string, SkillsState>>();
function skillMap(state: MockState): Map<string, SkillsState> {
  let m = skillStates.get(state);
  if (!m) skillStates.set(state, (m = new Map()));
  return m;
}

function untrustedNotice(count: number, sha: string): string {
  return `Ce dépôt déclare ${count} skill(s) dans .nokker/skills (empreinte ${sha.slice(0, 12)}…) : ils sont IGNORÉS tant que tu ne leur fais pas confiance. Relis-les, puis POST /v1/local/skills/trust {thread_id, sha256} (jeton local). Un arbre modifié devra être de nouveau accepté.`;
}

/** Ouverture d'une session : état des skills du dépôt (clé `skills` de la réponse) ; publie `skill.untrusted`. */
export function openProjectSkills(state: MockState, threadId: string, cwd: string, mountRoot: string): ProjectSkillsStatus {
  const root = findGitRoot(cwd, mountRoot) ?? resolve(cwd);
  const dir = join(root, ".nokker", "skills");
  const st: SkillsState = { enabled: true, project: "absent", root, sha256: null, count: 0, notice: null, dir };
  let isLink = false;
  try {
    isLink = lstatSync(join(root, ".nokker")).isSymbolicLink() || lstatSync(dir).isSymbolicLink();
  } catch {
    // absent
  }
  if (isLink) {
    st.project = "invalid";
    st.notice = "skills du dépôt ignorés : .nokker/skills est un lien symbolique (il pourrait sortir du dépôt)";
  } else if (existsSync(dir) && statSync(dir).isDirectory()) {
    const r = projectSkillsSha256(dir);
    if (r.why) {
      st.project = "invalid";
      st.notice = `skills du dépôt ignorés (.nokker/skills) : ${r.why}`;
    } else if (r.count) {
      st.sha256 = r.sha256;
      st.count = r.count;
      const trusted = state.trustedProjectSkills().some((t) => t.root === root && t.sha256 === r.sha256);
      st.project = trusted ? "trusted" : "untrusted";
      if (!trusted) st.notice = untrustedNotice(r.count, r.sha256!);
    }
  }
  skillMap(state).set(threadId, st);
  if (st.project === "untrusted") {
    state.publish({ type: "skill.untrusted", thread_id: threadId, root, sha256: st.sha256!, count: st.count, notice: st.notice! });
  }
  const { dir: _d, ...out } = st;
  return (void _d, out);
}

/** `POST /v1/local/skills/trust` : 200, 404 (fil sans skills de dépôt), 409 (empreinte différente). */
export function trustProjectSkills(state: MockState, threadId: string, sha256: string): { status: number; body: unknown } {
  const st = skillMap(state).get(threadId);
  if (!st || (st.project !== "untrusted" && st.project !== "trusted")) return { status: 404, body: { error: { message: "pas de skills de dépôt sur ce fil" } } };
  if (sha256 !== st.sha256) return { status: 409, body: { error: { message: "empreinte différente de celle lue : relis les skills du dépôt" } } };
  state.addTrustedProjectSkills(st.root, sha256);
  st.project = "trusted";
  st.notice = null;
  return { status: 200, body: { thread_id: threadId, root: st.root, sha256, trusted: true } };
}

/** Skills du dépôt visibles pour ce fil (ou un `<fil>/sa-…`) : confiance donnée ET arbre inchangé ; sinon aucun. */
export function visibleProjectSkills(state: MockState, threadId: string): Array<SkillInfo & { body: string }> {
  const st = skillMap(state).get(threadId.split("/sa-")[0]!);
  if (!st || st.project !== "trusted") return [];
  const r = projectSkillsSha256(st.dir);
  if (r.sha256 !== st.sha256) {
    // Arbre changé depuis la confiance : redevient non fiable, avec un nouvel avis (une fois par changement).
    st.project = "untrusted";
    st.sha256 = r.sha256;
    st.count = r.count;
    st.notice = untrustedNotice(r.count, r.sha256 ?? "");
    if (r.sha256) state.publish({ type: "skill.untrusted", thread_id: threadId.split("/sa-")[0]!, root: st.root, sha256: r.sha256, count: r.count, notice: st.notice });
    return [];
  }
  const out: Array<SkillInfo & { body: string }> = [];
  for (const family of readdirSync(st.dir).sort()) {
    const fdir = join(st.dir, family);
    if (!statSync(fdir).isDirectory()) continue;
    for (const name of readdirSync(fdir).sort()) {
      const file = join(fdir, name, "SKILL.md");
      if (!existsSync(file)) continue;
      const body = readFileSync(file, "utf-8");
      const desc = /^description:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? "";
      out.push({ name, category: family, description: desc, source: "project", body });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sous-agents en arrière-plan
// ---------------------------------------------------------------------------

export interface MockChild {
  view: SubagentView;
  parent: string;
  background: boolean;
  created: number;
  abort: AbortController;
  done: boolean;
  /** Relu de l'état local après un redémarrage (§7.22.9) : listé par `delegate_status`, fond ou premier plan. */
  restored?: boolean;
}
const childrenOf = new WeakMap<MockState, Map<string, MockChild>>();
export function children(state: MockState): Map<string, MockChild> {
  let m = childrenOf.get(state);
  if (!m) childrenOf.set(state, (m = new Map()));
  return m;
}

function viewOf(c: MockChild): SubagentView {
  return { ...c.view, elapsed_s: Math.round((Date.now() - c.created) / 100) / 10 };
}

/** `delegate_status(ids?)` : enfants de FOND du fil appelant seulement. */
export function delegateStatus(state: MockState, threadId: string, args: Record<string, unknown>): ToolOut {
  if (threadId.includes("/sa-")) return err("un sous-agent ne lit ni n'arrête d'autres sous-agents");
  const ids = args.ids;
  if (ids !== undefined && ids !== null && !Array.isArray(ids)) return err("arguments invalides : ids : liste de child_id attendue");
  const mine = [...children(state).values()].filter((c) => c.parent === threadId && (c.background || c.restored));
  const wanted = Array.isArray(ids) && ids.length ? ids.map(String) : null;
  const kids = wanted ? mine.filter((c) => wanted.includes(c.view.child_id)) : mine;
  const views = kids.map(viewOf);
  const live = (s: string): boolean => s === "queued" || s === "running" || s === "stopping";
  const out: DelegateStatusResult = { children: views, running: views.filter((v) => live(v.status)).length, finished: views.filter((v) => !live(v.status)).length };
  const unknown = wanted ? wanted.filter((i) => !mine.some((c) => c.view.child_id === i)) : [];
  if (unknown.length) out.unknown = unknown;
  return json(out);
}

/** Annulation d'un fil : ses enfants en cours (fond et premier plan) ; rend le nombre d'enfants arrêtés. */
export function cancelChildren(state: MockState, threadId: string): number {
  let n = 0;
  for (const c of children(state).values()) {
    const hit = threadId.includes("/sa-") ? c.view.thread_id === threadId : c.parent === threadId;
    if (hit && !c.done && c.view.status !== "stopping") {
      c.view.status = "stopping";
      c.abort.abort();
      n++;
    }
  }
  return n;
}

/** Redémarrage du noyau (§7.22.9) : les enfants s'arrêtent avec le processus ; relus de l'état local, ceux qui n'étaient
 * pas finis deviennent `interrupted / restart`, worktree conservé et NON inspecté ; un résultat fini reste relisible. Les
 * cartes de leurs fils restent refusées (aucun noyau d'enfant après un redémarrage). Rend le nombre d'enfants arrêtés. */
export function restartSubagents(state: MockState): number {
  let n = 0;
  for (const c of children(state).values()) {
    c.restored = true;
    if (c.done) continue;
    c.abort.abort();
    c.done = true;
    const { last_tool: _l, ...rest } = c.view;
    void _l;
    const wt = c.view.worktree;
    c.view = {
      ...rest,
      status: "interrupted",
      exit_reason: "restart",
      summary: "",
      ...(wt ? { worktree: { path: wt.path, branch: wt.branch, kept: true, note: "noyau redémarré : worktree conservé, non inspecté" } } : {}),
    };
    n++;
  }
  return n;
}
