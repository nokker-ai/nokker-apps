/**
 * `nokker import <claude-code|cursor|hermes|openclaw> [--project <dossier>] [--apply] [--yes]` : reprise de
 * l'installation d'un autre agent par le noyau, lancée depuis l'hôte. Les dossiers de l'autre agent ne sont JAMAIS montés
 * dans le noyau en service : un conteneur jetable (`docker compose run --rm --no-deps <core_service>`) reçoit, en lecture
 * seule, les seuls chemins que le noyau a listés et que la CLI a acceptés, et écrit son rapport dans le dossier d'état
 * du noyau (`<état>/imports/<source>-<horodatage>/`), où `GET /v1/local/import/report` le relit.
 *
 * 1. `python3 -m nokker import <source> --list-paths` (noyau 5ab4743) : UNE ligne JSON
 *    `{"source", "paths": [{path, kind}], "project_paths": [{path, kind}]}`, chemins relatifs au home et à la racine du
 *    projet, `kind` file|dir, liste fixe par source ; code 2 = source inconnue.
 * 2. Garde-fous ici, quoi que réponde le noyau : chemin absolu, `..`, `:` (séparateur de `-v`), segment ou chemin
 *    interdit (identifiants, identité, `.env`, bases d'état…) = refusé ; absent = ignoré ; lien symbolique qui sort de
 *    sa racine (ou mène à un chemin interdit) = refusé ; dans un dossier monté, une entrée interdite est masquée (fichier
 *    vide / dossier vide montés par-dessus). Les fichiers lus restent dans le conteneur : jamais copiés ni affichés ici.
 *    Le plan est affiché avant tout lancement.
 * 3. Run à blanc (`--home /import [--project /import-project] --state-dir /opt/data`), puis, avec `--apply`,
 *    confirmation (sauf `--yes`) et second run avec `--apply`. Sortie du conteneur telle quelle ; code de sortie = celui
 *    du conteneur (1 s'il y a des erreurs dans le rapport). Le run `--apply` a un terminal (pas de `-T`) quand la CLI en
 *    a un : le noyau y demande la confirmation de chaque serveur MCP ; sans terminal, il n'en ajoute aucun.
 *    Le dépôt (`--project`) reste en lecture seule pour toutes les sources. Écritures dans le dépôt, au run --apply
 *    seulement : claude-code → `<dépôt>/.nokker` monté en écriture (créé s'il manque) ; cursor → `--project-out
 *    /import-out` (dossier temporaire 0700 de l'hôte), puis NOKKER.md recopié dans le dépôt en création exclusive.
 *    Non suivis : un HERMES_HOME personnalisé, un `agents.defaults.workspace` d'OpenClaw hors de ~/.openclaw.
 *
 * L'image lance le noyau par `entrypoint: [python3, -m, nokker, --config, …, serve]` (deploy/lokkal/docker-compose.yml) :
 * l'entrée est remplacée par `--entrypoint python3`. L'état du noyau est monté par le compose lui-même
 * (`${NOKKER_STATE_DIR}:/opt/data`, `NOKKER_HOME=/opt/data`) : `--state-dir /opt/data` y écrit le rapport.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { composeArgs, hostCommand, lokkalProblem, readLokkal, type LokkalConfig } from "./lokkal.js";
import { terminalPrompter, type Prompter } from "./backup.js";
import { t } from "./i18n/index.js";
import { firstLine, run as realRun, type Runner } from "./proc.js";

export const IMPORT_SOURCES = ["claude-code", "cursor", "hermes", "openclaw"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** Où les chemins du home apparaissent dans le conteneur (`--home` du noyau). */
export const CONTAINER_IMPORT_HOME = "/import";
/** Où ceux du projet apparaissent (`--project` du noyau). */
export const CONTAINER_IMPORT_PROJECT = "/import-project";
/** Dossier d'état du noyau dans le conteneur (compose : `${NOKKER_STATE_DIR}:/opt/data`, `NOKKER_HOME=/opt/data`). */
export const CONTAINER_STATE_DIR = "/opt/data";
/** Sources qui lisent un projet (`--project`) ; hermes et openclaw l'ignorent. */
export const PROJECT_SOURCES: readonly ImportSource[] = ["claude-code", "cursor"];
/** Où cursor --apply écrit NOKKER.md (`--project-out`), recopié ensuite par la CLI dans le dépôt. */
export const CONTAINER_IMPORT_OUT = "/import-out";
/** Dossier du dépôt où claude-code --apply écrit (skills du dépôt, bloc hooks de settings.json). */
export const PROJECT_NOKKER_DIR = ".nokker";
export const PROJECT_NOKKER_MD = "NOKKER.md";
/** Noms jamais montés, à n'importe quelle profondeur (comparaison sans casse). */
export const FORBIDDEN_SEGMENTS = [".credentials.json", "credentials", "auth-profiles", "identity", "devices", ".env", "auth.json", "state.db", "workspace.zip"] as const;
/** Chemins jamais montés : égaux, au-dessous, ou en fin de chemin (comparaison sans casse). */
export const FORBIDDEN_PATHS = [".openclaw/agents", "memory/main.sqlite"] as const;
/** Au-delà, un dossier n'est pas parcouru jusqu'au bout : il est refusé plutôt que monté sans contrôle. */
export const MAX_WALK_ENTRIES = 100_000;
const RUN_TIMEOUT_MS = 30 * 60_000;

export interface ListedPath {
  path: string;
  kind: "file" | "dir";
}
export interface Listing {
  paths: ListedPath[];
  projectPaths: ListedPath[];
}

export interface ImportOptions {
  source: ImportSource;
  /** `--project <dossier>` : racine d'un dépôt dont les fichiers listés (`project_paths`) sont repris aussi. */
  project?: string | null;
  apply?: boolean;
  yes?: boolean;
  run?: Runner;
  out?: (text: string) => void;
  err?: (text: string) => void;
  prompt?: Prompter;
  /** Test : dossier personnel de l'hôte (défaut : `os.homedir()`). */
  home?: string;
  /** Test : dossier où créer le fichier et le dossier vides des masques (défaut : `os.tmpdir()`). */
  tmpRoot?: string;
  /** Test : horloge (repérage du rapport écrit par ce run). */
  now?: () => number;
}

function entries(v: unknown): ListedPath[] | null {
  if (!Array.isArray(v)) return null;
  const out: ListedPath[] = [];
  for (const p of v as unknown[]) {
    if (typeof p !== "object" || p === null) return null;
    const { path, kind } = p as { path?: unknown; kind?: unknown };
    if (typeof path !== "string" || !path || (kind !== "file" && kind !== "dir")) return null;
    out.push({ path, kind });
  }
  return out;
}

/** La dernière ligne non vide, JSON `{source, paths, project_paths?}` ; `null` si la sortie ne respecte pas le contrat. */
export function parseListPaths(stdout: string, source: string): Listing | null {
  const line = stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  if (!line) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const o = doc as { source?: unknown; paths?: unknown; project_paths?: unknown };
  if (o.source !== source) return null;
  const paths = entries(o.paths);
  const projectPaths = o.project_paths === undefined ? [] : entries(o.project_paths);
  return paths && projectPaths ? { paths, projectPaths } : null;
}

const segments = (p: string): string[] => p.split(/[\\/]+/).filter((s) => s && s !== ".");

/** Chemin relatif (séparateur `/`) interdit : un segment interdit, ou un chemin interdit égal, au-dessous ou en fin. */
export function isForbidden(rel: string): boolean {
  const segs = segments(rel).map((s) => s.toLowerCase());
  if (segs.some((s) => (FORBIDDEN_SEGMENTS as readonly string[]).includes(s))) return true;
  const low = segs.join("/");
  return FORBIDDEN_PATHS.some((f) => low === f || low.startsWith(`${f}/`) || low.endsWith(`/${f}`) || low.includes(`/${f}/`));
}

/** Refus d'un chemin tel que le noyau l'a écrit (avant tout accès au disque) ; `null` = recevable. */
export function pathRefusal(p: string): string | null {
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p) || isAbsolute(p)) return t("absolute path");
  if (p.split(/[\\/]+/).includes("..")) return t("contains ..");
  if (p.includes(":") || p.includes("\0")) return t("character not allowed in a mount");
  if (isForbidden(p)) return t("credentials or identity file");
  if (!segments(p).length) return t("empty path");
  return null;
}

export interface Mask {
  /** Chemin relatif à la racine du montage parent (home ou projet). */
  rel: string;
  kind: "file" | "dir";
}

export interface Mount {
  /** Chemin relatif tel que le noyau l'a donné (et tel qu'il apparaît sous la cible). */
  rel: string;
  kind: "file" | "dir";
  /** Source réelle sur l'hôte (liens résolus). */
  source: string;
  /** Racine dans le conteneur : `/import` ou `/import-project`. */
  under: string;
  /** Lecture-écriture (`.nokker` du dépôt pour claude-code --apply, `/import-out` pour cursor --apply) ; sinon `:ro`. */
  rw?: boolean;
  /** Entrées interdites trouvées dans un dossier : masquées par un fichier ou un dossier vide. */
  masks: Mask[];
}

export interface MountPlan {
  mounts: Mount[];
  rejected: Array<{ path: string; reason: string; under: string }>;
  absent: Array<{ path: string; under: string }>;
}

/** Entrées interdites sous `dir` (sans suivre les liens) ; `null` si le dossier est trop grand pour être contrôlé ou
 * contient un lien au nom interdit (impossible à masquer proprement). */
function forbiddenInside(dir: string, rel: string): Mask[] | null {
  const found: Mask[] = [];
  const stack: Array<[string, string]> = [[dir, rel]];
  let seen = 0;
  while (stack.length) {
    const [abs, r] = stack.pop()!;
    let list;
    try {
      list = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue; // illisible pour nous : illisible aussi pour le conteneur (même utilisateur)
    }
    for (const e of list) {
      if (++seen > MAX_WALK_ENTRIES) return null;
      const childRel = r ? `${r}/${e.name}` : e.name;
      if (isForbidden(childRel)) {
        if (e.isSymbolicLink()) return null;
        found.push({ rel: childRel, kind: e.isDirectory() ? "dir" : "file" });
      } else if (e.isDirectory()) {
        stack.push([join(abs, e.name), childRel]);
      }
    }
  }
  return found;
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Plan de montage d'une racine (home ou projet) : chaque chemin listé passe les garde-fous ou est refusé / ignoré. */
export function planMounts(listed: ListedPath[], root: string, under: string = CONTAINER_IMPORT_HOME, plan: MountPlan = { mounts: [], rejected: [], absent: [] }): MountPlan {
  const realRoot = realOr(root);
  const seen = new Set<string>();
  for (const { path, kind } of listed) {
    const refusal = pathRefusal(path);
    if (refusal) {
      plan.rejected.push({ path, reason: refusal, under });
      continue;
    }
    const rel = segments(path).join("/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    try {
      lstatSync(join(root, rel));
    } catch {
      plan.absent.push({ path: rel, under });
      continue;
    }
    let real: string;
    try {
      real = realpathSync(join(root, rel));
    } catch {
      plan.absent.push({ path: rel, under }); // lien cassé : rien à lire
      continue;
    }
    const inside = relative(realRoot, real);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
      plan.rejected.push({ path: rel, reason: t("symbolic link leading outside its root folder"), under });
      continue;
    }
    if (isForbidden(inside.split(sep).join("/"))) {
      plan.rejected.push({ path: rel, reason: t("symbolic link to a credentials or identity file"), under });
      continue;
    }
    if (real.includes(":")) {
      plan.rejected.push({ path: rel, reason: t("character not allowed in a mount"), under });
      continue;
    }
    const isDir = statSync(real).isDirectory();
    if (isDir !== (kind === "dir")) {
      plan.rejected.push({ path: rel, reason: isDir ? t("expected a file, found a folder") : t("expected a folder, found a file"), under });
      continue;
    }
    const masks = isDir ? forbiddenInside(real, rel) : [];
    if (masks === null) {
      plan.rejected.push({ path: rel, reason: t("folder too large to check, or holding a link to a credentials file"), under });
      continue;
    }
    plan.mounts.push({ rel, kind, source: real, under, masks });
  }
  return plan;
}

const target = (under: string, rel: string): string => (rel ? `${under}/${rel}` : under);

/** `-v` de chaque montage (`:ro` sauf les sorties en écriture), masques compris. Les montages en écriture viennent en
 * premier ; docker monte de toute façon par profondeur de cible. */
export function volumeArgs(mounts: Mount[], empty: { file: string; dir: string } | null): string[] {
  const args: string[] = [];
  for (const m of [...mounts.filter((x) => x.rw), ...mounts.filter((x) => !x.rw)]) {
    args.push("-v", `${m.source}:${target(m.under, m.rel)}${m.rw ? "" : ":ro"}`);
    for (const k of m.masks) {
      if (!empty) throw new Error("masks without empty sources");
      args.push("-v", `${k.kind === "dir" ? empty.dir : empty.file}:${target(m.under, k.rel)}:ro`);
    }
  }
  return args;
}

/** `docker compose … run --rm --no-deps [-T] --entrypoint python3 [-v …] <core_service> -m nokker import …`. */
export function composeRun(cfg: LokkalConfig, volumes: string[], tail: string[], tty = false): { cmd: string; args: string[] } {
  return hostCommand(cfg, "docker", [
    ...composeArgs(cfg), "run", "--rm", "--no-deps", ...(tty ? [] : ["-T"]), "--entrypoint", "python3", ...volumes, cfg.core_service,
    "-m", "nokker", "import", ...tail,
  ]);
}

/** `NOKKER_STATE_DIR` du .env de l'installation, rendu absolu ; `null` s'il est illisible. */
function hostStateDir(cfg: LokkalConfig): string | null {
  try {
    const m = /^\s*NOKKER_STATE_DIR\s*=\s*["']?([^"'\n]+?)["']?\s*$/m.exec(readFileSync(cfg.env_file, "utf-8"));
    if (!m?.[1]) return null;
    const v = m[1].replace(/^~(?=\/|$)/, homedir());
    return isAbsolute(v) ? v : resolve(cfg.install_dir ?? join(cfg.compose, ".."), v);
  } catch {
    return null;
  }
}

/** `summary.md` du rapport le plus récent de `source` écrit depuis `since` (ms), vu de l'hôte ; `null` sinon. */
export function latestSummary(stateDir: string, source: string, since: number): string | null {
  const dir = join(stateDir, "imports");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(`${source}-`)).sort();
  } catch {
    return null;
  }
  for (const n of names.reverse()) {
    const p = join(dir, n, "summary.md");
    try {
      if (statSync(p).mtimeMs >= since - 2000) return p;
    } catch {
      // pas de summary.md dans ce dossier
    }
  }
  return null;
}

export async function runImport(o: ImportOptions): Promise<number> {
  const out = o.out ?? ((s) => process.stdout.write(s));
  const err = o.err ?? ((s) => process.stderr.write(s));
  const run = o.run ?? realRun;
  const prompt = o.prompt ?? terminalPrompter();
  const home = o.home ?? homedir();
  const now = o.now ?? Date.now;

  if (!(IMPORT_SOURCES as readonly string[]).includes(o.source)) {
    err(`${t("import expects one of: {0}", IMPORT_SOURCES.join(", "))}\n`);
    return 2;
  }
  if (o.apply && !o.yes && !prompt.interactive) {
    err(`${t("import --apply writes to the state of Nokker: confirm with --yes (no terminal to ask).")}\n`);
    return 2;
  }
  let project: string | null = null;
  if (o.project && !PROJECT_SOURCES.includes(o.source)) {
    err(`${t("--project only applies to {0}: {1} reads nothing in a project.", PROJECT_SOURCES.join(", "), o.source)}\n`);
    return 2;
  }
  if (o.project) {
    project = realOr(resolve(o.project));
    if (!existsSync(project) || !statSync(project).isDirectory()) {
      err(`${t("--project: {0} is not a folder.", o.project)}\n`);
      return 2;
    }
    const realHome = realOr(home);
    const up = relative(project, realHome);
    if (project === "/" || !up || (!up.startsWith("..") && !isAbsolute(up))) {
      err(`${t("--project: {0} is (or contains) the home folder: give the root of a repository.", project)}\n`);
      return 2;
    }
    if (project.includes(":")) {
      err(`${t("--project: {0} contains a colon: it cannot be mounted.", project)}\n`);
      return 2;
    }
  }
  const lokkal = readLokkal();
  const problem = lokkalProblem(lokkal);
  if (problem || lokkal.status !== "ok") {
    err(`${t("Cannot import: {0}.", String(problem))}\n`);
    return 1;
  }
  const cfg = lokkal.config;
  if (cfg.wsl_distro) {
    // Les chemins à contrôler (liens, existence) sont dans la distro : invérifiables d'ici.
    err(`${t("nokker import is not available under WSL yet: run it from a shell inside the {0} distribution.", cfg.wsl_distro)}\n`);
    return 1;
  }
  if (home.includes(":")) {
    err(`${t("The home folder {0} contains a colon: it cannot be mounted.", home)}\n`);
    return 1;
  }

  // 1. Chemins lus par l'importeur, d'après le noyau.
  const lc = composeRun(cfg, [], [o.source, "--list-paths"]);
  const listed = await run(lc.cmd, lc.args, { timeoutMs: 300_000 });
  if (listed.error === "ENOENT") {
    err(`${t("{0} not found: cannot run the kernel container.", lc.cmd)}\n`);
    return 1;
  }
  if (listed.error === "timeout") {
    err(`${t("The kernel did not list the paths in time.")}\n`);
    return 1;
  }
  if (listed.code === 2) {
    err(`${t("The kernel does not know --list-paths {0} (exit code 2): it may predate it, try nokker update.", o.source)}\n`);
    return 1;
  }
  if (listed.code !== 0) {
    err(`${t("The kernel could not list the paths to import (exit code {0}): {1}", String(listed.code), firstLine(listed.stderr) || t("no message"))}\n`);
    return 1;
  }
  const listing = parseListPaths(listed.stdout, o.source);
  if (!listing) {
    err(`${t("Invalid answer from the kernel to --list-paths (one JSON line {source, paths:[{path, kind}], project_paths} expected): {0}", firstLine(listed.stdout).slice(0, 200) || t("empty output"))}\n`);
    return 1;
  }

  // 2. Garde-fous, puis le plan, montré avant tout lancement.
  const plan = planMounts(listing.paths, home, CONTAINER_IMPORT_HOME);
  if (project) planMounts(listing.projectPaths, project, CONTAINER_IMPORT_PROJECT, plan);
  const shown = (under: string, p: string): string => (under === CONTAINER_IMPORT_HOME ? `~/${p}` : `${project}/${p}`);
  for (const r of plan.rejected) out(`${t("✗ refused: {0} ({1})", shown(r.under, r.path), r.reason)}\n`);
  if (plan.absent.length) out(`${t("Not on this machine, ignored: {0}", plan.absent.map((a) => shown(a.under, a.path)).join(", "))}\n`);
  if (!plan.mounts.length) {
    out(`${t("Nothing to import from {0} on this machine: no container was started.", o.source)}\n`);
    return 0;
  }
  const projectMounted = plan.mounts.some((m) => m.under === CONTAINER_IMPORT_PROJECT);

  // Ce que le noyau écrit dans le dépôt, par source : claude-code dans `<dépôt>/.nokker` (monté en écriture au run
  // --apply, en lecture au run à blanc pour juger des conflits) ; cursor dans un dossier temporaire (`--project-out`),
  // NOKKER.md recopié ensuite par la CLI en création exclusive. `<dépôt>/NOKKER.md` existant est montré en lecture :
  // le noyau y juge le conflit. Le reste du dépôt reste en lecture seule.
  let nokkerDir: { source: string; exists: boolean; masks: Mask[] } | null = null;
  let repoNokkerMd: Mount | null = null;
  if (project && projectMounted && o.source === "claude-code") {
    const p = join(project, PROJECT_NOKKER_DIR);
    const st = lstatOrNull(p);
    if (st && (st.isSymbolicLink() || !st.isDirectory())) {
      err(`${t("{0} is not a plain folder (link or file): it cannot be mounted for writing.", p)}\n`);
      return 1;
    }
    const masks = st ? forbiddenInside(p, PROJECT_NOKKER_DIR) : [];
    if (masks === null) {
      err(`${t("{0} is too large to check for credentials files (or holds a link to one): it cannot be mounted for writing.", p)}\n`);
      return 1;
    }
    nokkerDir = { source: p, exists: !!st, masks };
  }
  // Depuis le noyau a8dc148, NOKKER.md est dans les project_paths de cursor (donc déjà dans `plan.mounts`) : ce montage
  // ne sert plus qu'à un noyau antérieur, et n'est jamais posé deux fois (docker refuse deux montages sur une même cible).
  const mdListed = plan.mounts.some((m) => m.under === CONTAINER_IMPORT_PROJECT && m.rel === PROJECT_NOKKER_MD);
  if (project && projectMounted && o.source === "cursor" && !mdListed) {
    const p = join(project, PROJECT_NOKKER_MD);
    const st = lstatOrNull(p);
    if (st?.isFile()) repoNokkerMd = { rel: PROJECT_NOKKER_MD, kind: "file", source: p, under: CONTAINER_IMPORT_PROJECT, masks: [] };
  }
  const roMounts = [...plan.mounts, ...(repoNokkerMd ? [repoNokkerMd] : [])];
  const nokkerMount = (rw: boolean): Mount[] =>
    nokkerDir && (rw || nokkerDir.exists)
      ? [{ rel: PROJECT_NOKKER_DIR, kind: "dir", source: nokkerDir.source, under: CONTAINER_IMPORT_PROJECT, rw, masks: nokkerDir.masks }]
      : [];

  out(`${t("Mounted read-only into a one-off kernel container (never copied or shown here):")}\n`);
  for (const m of [...roMounts, ...nokkerMount(false)]) {
    out(`  ${shown(m.under, m.rel)}${m.kind === "dir" ? "/" : ""} → ${target(m.under, m.rel)}\n`);
    for (const k of m.masks) out(`    ${t("hidden (credentials): {0}", shown(m.under, k.rel))}\n`);
  }
  const stateHost = hostStateDir(cfg);
  out(`${t("Report and imported data go to the kernel state: {0} → {1}", stateHost ?? "NOKKER_STATE_DIR", CONTAINER_STATE_DIR)}\n`);

  let tmp: string | null = null;
  let outDir: string | null = null;
  try {
    const allMasks = [...plan.mounts, ...(nokkerDir ? nokkerMount(true) : [])].some((m) => m.masks.length);
    let empty: { file: string; dir: string } | null = null;
    if (allMasks) {
      tmp = mkdtempSync(join(o.tmpRoot ?? tmpdir(), "nokker-import-"));
      empty = { file: join(tmp, "empty"), dir: join(tmp, "empty.d") };
      writeFileSync(empty.file, "", { mode: 0o400 });
      mkdirSync(empty.dir, { mode: 0o500 });
    }
    const tail = [o.source, "--home", CONTAINER_IMPORT_HOME, ...(projectMounted ? ["--project", CONTAINER_IMPORT_PROJECT] : []), "--state-dir", CONTAINER_STATE_DIR];
    const report = (since: number): void => {
      const p = stateHost ? latestSummary(stateHost, o.source, since) : null;
      if (p) out(`${t("Report: {0}", p)}\n`);
    };

    // 3. À blanc, toujours d'abord (lecture seule partout).
    out(`${t("Dry run (nothing is written):")}\n`);
    const t0 = now();
    const dry = await runContainer(run, composeRun(cfg, volumeArgs([...roMounts, ...nokkerMount(false)], empty), tail), err);
    report(t0);
    if (!o.apply || dry !== 0) {
      if (o.apply) err(`${t("The dry run failed: nothing was written.")}\n`);
      return dry;
    }

    // Ce que --apply écrira, avant la question.
    out(`${t("--apply will write:")}\n`);
    out(`  ${t("{0} (kernel state: skills, settings, MCP servers, memory, report)", stateHost ?? "NOKKER_STATE_DIR")}\n`);
    if (nokkerDir) {
      out(`  ${t("{0}/ (repository skills and hooks) → {1}, read-write{2}", nokkerDir.source, `${CONTAINER_IMPORT_PROJECT}/${PROJECT_NOKKER_DIR}`, nokkerDir.exists ? "" : t(" (created)"))}\n`);
      for (const k of nokkerDir.masks) out(`    ${t("hidden (credentials): {0}", shown(CONTAINER_IMPORT_PROJECT, k.rel))}\n`);
    }
    if (project && projectMounted && o.source === "cursor") {
      out(`  ${t("{0} (only if it does not exist: written to a temporary folder, then copied)", join(project, PROJECT_NOKKER_MD))}\n`);
    }
    const tty = prompt.interactive;
    if (!tty) out(`${t("No terminal: MCP servers found by the import will not be added (the kernel asks for each one on a terminal).")}\n`);
    if (!o.yes && !(await prompt.confirm(t("Apply this import to the state of Nokker? [y/N] ")))) {
      err(`${t("Import cancelled: nothing was written.")}\n`);
      return 1;
    }
    const applyTail = [...tail, "--apply"];
    const extra: Mount[] = [];
    if (nokkerDir) {
      if (!nokkerDir.exists) mkdirSync(nokkerDir.source, { mode: 0o755 });
      extra.push(...nokkerMount(true));
    }
    if (project && projectMounted && o.source === "cursor") {
      outDir = mkdtempSync(join(o.tmpRoot ?? tmpdir(), "nokker-import-out-")); // 0700
      extra.push({ rel: "", kind: "dir", source: outDir, under: CONTAINER_IMPORT_OUT, rw: true, masks: [] });
      applyTail.push("--project-out", CONTAINER_IMPORT_OUT);
    }
    out(`${t("Applying the import…")}\n`);
    const t1 = now();
    const code = await runContainer(run, composeRun(cfg, volumeArgs([...extra, ...roMounts], empty), applyTail, tty), err);
    if (outDir && project) copyNokkerMd(outDir, project, out);
    report(t1);
    return code;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  }
}

function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/** Recopie `<sortie>/NOKKER.md` dans le dépôt en création exclusive (jamais d'écrasement) ; un NOKKER.md déjà présent :
 * rien n'est écrit (le noyau l'a rapporté en conflit). Un lien ou autre chose qu'un fichier n'est pas suivi. */
export function copyNokkerMd(outDir: string, project: string, out: (s: string) => void): boolean {
  const src = join(outDir, PROJECT_NOKKER_MD);
  const st = lstatOrNull(src);
  if (!st?.isFile()) return false;
  const dest = join(project, PROJECT_NOKKER_MD);
  if (lstatOrNull(dest)) return false;
  try {
    writeFileSync(dest, readFileSync(src), { flag: "wx", mode: 0o644 });
  } catch {
    return false; // apparu entre-temps (EEXIST) ou dépôt non inscriptible : rien n'est écrasé
  }
  out(`${t("NOKKER.md written: {0}", dest)}\n`);
  return true;
}

async function runContainer(run: Runner, c: { cmd: string; args: string[] }, err: (s: string) => void): Promise<number> {
  const r = await run(c.cmd, c.args, { inherit: true, timeoutMs: RUN_TIMEOUT_MS });
  if (r.error === "ENOENT") {
    err(`${t("{0} not found: cannot run the kernel container.", c.cmd)}\n`);
    return 1;
  }
  if (r.error === "timeout") {
    err(`${t("The import did not finish in time.")}\n`);
    return 1;
  }
  return r.code ?? 1;
}
