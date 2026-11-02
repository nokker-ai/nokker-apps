/** `nokker import <source>` : liste des chemins donnée par le noyau (`--list-paths`), garde-fous côté CLI, argv exact de
 * docker compose, à blanc puis confirmation puis --apply, projet, terminal. Exécuteur factice : aucun docker réel. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner, RunOptions } from "../src/proc.js";
import type { Prompter } from "../src/backup.js";
import { parseArgs } from "../src/cli-args.js";
import { copyNokkerMd, isForbidden, parseListPaths, pathRefusal, planMounts, runImport, type ImportOptions } from "../src/import.js";
import { setLang } from "../src/i18n/index.js";

let dir: string;
let inst: string;
let state: string;
let home: string;
let repo: string;
let outside: string;
let tmpRoot: string;
const keep = process.env.NOKKER_CONFIG_DIR_OVERRIDE;

beforeAll(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "nokker-cli-import-")));
  inst = join(dir, "nokker-home");
  state = join(inst, "state");
  home = join(dir, "home");
  repo = join(dir, "repo");
  outside = join(dir, "outside");
  tmpRoot = join(dir, "tmp");
  for (const d of [state, outside, tmpRoot, join(home, ".claude", "skills", "review", "credentials"), join(home, ".cursor"), join(home, "real-agents"),
    join(home, ".openclaw", "workspace", "memory"), join(repo, ".cursor", "rules"), join(repo, ".claude", "skills"), join(repo, "node_modules", "x")]) {
    await mkdir(d, { recursive: true });
  }
  await writeFile(join(home, ".claude", "settings.json"), "{}");
  await writeFile(join(home, ".claude", ".credentials.json"), "{\"token\":\"secret\"}");
  await writeFile(join(home, ".claude", "skills", "review", "SKILL.md"), "# review");
  await writeFile(join(home, ".claude", "skills", "review", "credentials", "x"), "secret");
  await writeFile(join(home, ".claude", "skills", "review", ".env"), "K=v");
  await writeFile(join(home, ".claude.json"), "{\"mcpServers\":{}}");
  await writeFile(join(home, ".openclaw", "workspace", "memory", "main.sqlite"), "db");
  await writeFile(join(home, ".openclaw", "workspace", "AGENTS.md"), "# a");
  await writeFile(join(outside, "secret.txt"), "nope");
  await writeFile(join(home, "real-agents", "a.md"), "a");
  await symlink(outside, join(home, ".claude", "agents-out")); // sort du home
  await symlink(join(home, "real-agents"), join(home, ".claude", "agents")); // reste dans le home
  await symlink(join(home, ".claude", ".credentials.json"), join(home, ".cursor", "mcp.json")); // mène aux identifiants
  await writeFile(join(repo, "CLAUDE.md"), "# repo");
  await writeFile(join(repo, ".cursorrules"), "rules");
  await writeFile(join(repo, ".env"), "SECRET=1");
  await writeFile(join(repo, "node_modules", "x", ".env"), "ignored by the walk");
  await writeFile(join(inst, "docker-compose.yml"), "services: {}\n");
  await writeFile(join(inst, ".env"), `NOKKER_VERSION=0.5.0\nNOKKER_STATE_DIR=${state}\n`);
  await writeFile(
    join(dir, "lokkal.json"),
    JSON.stringify({
      compose: join(inst, "docker-compose.yml"), project: "nokker", version: "0.5.0", core_service: "core", api_url: "http://127.0.0.1:8742",
      web_url: "http://127.0.0.1:7420", token_path: join(state, "local-token"), env_file: join(inst, ".env"), install_dir: inst,
    }),
  );
  process.env.NOKKER_CONFIG_DIR_OVERRIDE = dir;
});
afterAll(async () => {
  if (keep === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
  else process.env.NOKKER_CONFIG_DIR_OVERRIDE = keep;
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => setLang("en"));

/** Liste de claude-code telle que le noyau 5ab4743 la donne, plus des chemins hostiles qu'un noyau ne devrait pas donner. */
const PATHS = [
  { path: ".claude/CLAUDE.md", kind: "file" },
  { path: ".claude/settings.json", kind: "file" },
  { path: ".claude/skills", kind: "dir" },
  { path: ".claude/agents", kind: "dir" },
  { path: ".claude.json", kind: "file" },
  { path: ".claude/.credentials.json", kind: "file" },
  { path: ".claude/Credentials/x", kind: "file" },
  { path: ".openclaw/auth-profiles/main.json", kind: "file" },
  { path: ".hermes/IDENTITY", kind: "dir" },
  { path: ".hermes/.env", kind: "file" },
  { path: ".openclaw/agents", kind: "dir" },
  { path: ".openclaw/memory/main.sqlite", kind: "file" },
  { path: "/etc/passwd", kind: "file" },
  { path: "../outside/secret.txt", kind: "file" },
  { path: ".claude/agents-out", kind: "dir" },
  { path: ".cursor/mcp.json", kind: "file" },
];
const PROJECT = [
  { path: "CLAUDE.md", kind: "file" },
  { path: ".claude/settings.json", kind: "file" },
  { path: ".claude/skills", kind: "dir" },
  { path: ".mcp.json", kind: "file" },
];
const listJson = (source = "claude-code", paths: unknown = PATHS, project: unknown = PROJECT): string =>
  `${JSON.stringify({ source, paths, project_paths: project })}\n`;

interface Call { cmd: string; args: string[]; opts: RunOptions | undefined }
type Answer = { code: number | null; stdout?: string; stderr?: string; error?: string; then?: () => Promise<void> };
function fake(calls: Call[], answers: Answer[]): Runner {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const a = answers[calls.length - 1] ?? { code: 0 };
    await a.then?.();
    return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "", ...(a.error ? { error: a.error } : {}) };
  };
}
function prompter(confirm = false, interactive = true): Prompter & { asked: string[] } {
  const asked: string[] = [];
  return { asked, interactive, secret: async () => null, confirm: async (q) => (asked.push(q), confirm) };
}
async function go(o: Partial<ImportOptions>, answers: Answer[] = [{ code: 0, stdout: listJson() }, { code: 0 }, { code: 0 }]) {
  const calls: Call[] = [];
  let out = "";
  let err = "";
  const code = await runImport({ source: "claude-code", home, tmpRoot, run: fake(calls, answers), prompt: prompter(), ...o, out: (s) => (out += s), err: (s) => (err += s) });
  return { code, calls, out, err };
}

const COMPOSE = (): string[] => ["compose", "-p", "nokker", "-f", join(inst, "docker-compose.yml")];
const RUN = ["run", "--rm", "--no-deps", "-T", "--entrypoint", "python3"];
/** Les `-v` d'un argv, dans l'ordre. */
const volumes = (args: string[]): string[] => args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : []));

describe("liste des chemins (contrat --list-paths du noyau)", () => {
  it("parse la dernière ligne JSON, project_paths compris (facultatif)", () => {
    expect(parseListPaths(listJson("cursor", [{ path: ".cursor/mcp.json", kind: "file" }], [{ path: ".cursor/rules", kind: "dir" }]), "cursor")).toEqual({
      paths: [{ path: ".cursor/mcp.json", kind: "file" }], projectPaths: [{ path: ".cursor/rules", kind: "dir" }],
    });
    expect(parseListPaths(`noise\n${JSON.stringify({ source: "hermes", paths: [] })}\n`, "hermes")).toEqual({ paths: [], projectPaths: [] });
  });
  it("refuse ce qui sort du contrat", () => {
    expect(parseListPaths("", "cursor")).toBeNull();
    expect(parseListPaths("not json", "cursor")).toBeNull();
    expect(parseListPaths(listJson("hermes", []), "cursor")).toBeNull();
    expect(parseListPaths(JSON.stringify({ source: "cursor" }), "cursor")).toBeNull();
    expect(parseListPaths(listJson("cursor", [{ path: "a", kind: "socket" }]), "cursor")).toBeNull();
    expect(parseListPaths(listJson("cursor", [], [{ path: 3, kind: "file" }]), "cursor")).toBeNull();
    expect(parseListPaths("[]", "cursor")).toBeNull();
  });
  it("premier appel : docker compose run --rm --no-deps -T --entrypoint python3 <core> -m nokker import <source> --list-paths", async () => {
    const { calls } = await go({});
    expect(calls[0]!.cmd).toBe("docker");
    expect(calls[0]!.args).toEqual([...COMPOSE(), ...RUN, "core", "-m", "nokker", "import", "claude-code", "--list-paths"]);
    expect(calls[0]!.opts?.inherit).toBeFalsy();
  });
  it("sortie invalide : erreur claire, code 1, aucun autre lancement", async () => {
    const r = await go({}, [{ code: 0, stdout: "Traceback (most recent call last):\n" }]);
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.err).toContain("Invalid answer from the kernel to --list-paths");
  });
  it("code 2 (source inconnue ou noyau antérieur) : code 1, message ; autre échec : première ligne de stderr ; pas de docker", async () => {
    const two = await go({}, [{ code: 2, stderr: "usage: …" }]);
    expect(two).toMatchObject({ code: 1 });
    expect(two.err).toContain("does not know --list-paths claude-code");
    const other = await go({}, [{ code: 1, stderr: "\nno such service: core\n" }]);
    expect(other.err).toContain("no such service: core");
    const nodocker = await go({}, [{ code: null, error: "ENOENT" }]);
    expect(nodocker.err).toContain("docker not found");
  });
});

describe("garde-fous côté CLI", () => {
  it("pathRefusal / isForbidden : absolu, .., deux-points, segments et chemins interdits sans casse", () => {
    expect(pathRefusal("/etc/passwd")).toBe("absolute path");
    expect(pathRefusal("C:/Users/x")).toBe("absolute path");
    expect(pathRefusal("a/../b")).toBe("contains ..");
    expect(pathRefusal("dir/a:b")).toBe("character not allowed in a mount");
    for (const p of [".claude/.Credentials.JSON", "x/CREDENTIALS", ".openclaw/auth-profiles/a.json", ".hermes/identity", ".openclaw/devices/d.json",
      ".hermes/.env", ".hermes/auth.json", ".hermes/state.db", ".openclaw/.env", ".openclaw/agents", ".openclaw/agents/main/x.json",
      ".openclaw/memory/main.sqlite", ".openclaw/workspace.zip"]) {
      expect([p, pathRefusal(p)]).toEqual([p, "credentials or identity file"]);
    }
    expect(isForbidden(".claude/agents")).toBe(false); // seul .openclaw/agents est interdit
    expect(isForbidden(".openclaw/workspace/memory/main.sqlite")).toBe(true);
    expect(pathRefusal(".claude/settings.json")).toBeNull();
    expect(pathRefusal(".claude.json")).toBeNull();
  });

  it("plan : absents ignorés, lien qui sort refusé, lien interne suivi, lien vers les identifiants refusé, entrées interdites masquées", () => {
    const plan = planMounts(PATHS as never, home);
    expect(plan.mounts.map((m) => m.rel)).toEqual([".claude/settings.json", ".claude/skills", ".claude/agents", ".claude.json"]);
    expect(plan.mounts.find((m) => m.rel === ".claude/agents")!.source).toBe(join(home, "real-agents"));
    expect(plan.mounts.find((m) => m.rel === ".claude/skills")!.masks.sort((a, b) => a.rel.localeCompare(b.rel))).toEqual([
      { rel: ".claude/skills/review/.env", kind: "file" },
      { rel: ".claude/skills/review/credentials", kind: "dir" },
    ]);
    expect(plan.absent.map((a) => a.path)).toEqual([".claude/CLAUDE.md"]);
    const rejected = Object.fromEntries(plan.rejected.map((r) => [r.path, r.reason]));
    expect(rejected).toEqual({
      ".claude/.credentials.json": "credentials or identity file",
      ".claude/Credentials/x": "credentials or identity file",
      ".openclaw/auth-profiles/main.json": "credentials or identity file",
      ".hermes/IDENTITY": "credentials or identity file",
      ".hermes/.env": "credentials or identity file",
      ".openclaw/agents": "credentials or identity file",
      ".openclaw/memory/main.sqlite": "credentials or identity file",
      "/etc/passwd": "absolute path",
      "../outside/secret.txt": "contains ..",
      ".claude/agents-out": "symbolic link leading outside its root folder",
      ".cursor/mcp.json": "symbolic link to a credentials or identity file",
    });
  });

  it("masque memory/main.sqlite dans un dossier monté ; type annoncé différent du disque : refusé", () => {
    const ws = planMounts([{ path: ".openclaw/workspace", kind: "dir" }], home);
    expect(ws.mounts[0]!.masks).toEqual([{ rel: ".openclaw/workspace/memory/main.sqlite", kind: "file" }]);
    const plan = planMounts([{ path: ".claude.json", kind: "dir" }, { path: ".claude/skills", kind: "file" }], home);
    expect(plan.mounts).toEqual([]);
    expect(plan.rejected.map((r) => r.reason)).toEqual(["expected a folder, found a file", "expected a file, found a folder"]);
  });
});

describe("argv exact des runs", () => {
  it("à blanc par défaut : montages :ro, masques, --home /import --state-dir /opt/data, pas de --apply, sortie héritée", async () => {
    const { code, calls, out } = await go({});
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    const a = calls[1]!.args;
    const vols = volumes(a);
    expect(vols[0]).toBe(`${home}/.claude/settings.json:/import/.claude/settings.json:ro`);
    expect(vols).toContain(`${home}/.claude/skills:/import/.claude/skills:ro`);
    expect(vols).toContain(`${home}/real-agents:/import/.claude/agents:ro`);
    expect(vols).toContain(`${home}/.claude.json:/import/.claude.json:ro`);
    expect(vols.find((v) => v.endsWith(":/import/.claude/skills/review/.env:ro"))).toMatch(/nokker-import-[^/]+\/empty:/);
    expect(vols.find((v) => v.endsWith(":/import/.claude/skills/review/credentials:ro"))).toMatch(/nokker-import-[^/]+\/empty\.d:/);
    expect(vols.every((v) => v.endsWith(":ro"))).toBe(true);
    // Aucun chemin interdit ni hors du home comme SOURCE de montage.
    const sources = vols.map((v) => v.split(":")[0]!);
    expect(sources.filter((s) => s.startsWith(home) && isForbidden(s.slice(home.length + 1)))).toEqual([]);
    expect(sources.some((s) => s.startsWith(outside) || s === "/etc/passwd")).toBe(false);
    expect(a).toEqual([...COMPOSE(), ...RUN, ...vols.flatMap((v) => ["-v", v]), "core", "-m", "nokker", "import", "claude-code", "--home", "/import", "--state-dir", "/opt/data"]);
    expect(calls[1]!.opts?.inherit).toBe(true);
    // Plan affiché avant le lancement ; état de l'hôte lu dans le .env ; contenu des fichiers jamais affiché.
    expect(out).toContain("Mounted read-only into a one-off kernel container");
    expect(out).toContain("~/.claude/skills/ → /import/.claude/skills");
    expect(out).toContain("hidden (credentials): ~/.claude/skills/review/.env");
    expect(out).toContain("✗ refused: ~/.claude/agents-out (symbolic link leading outside its root folder)");
    expect(out).toContain("Not on this machine, ignored: ~/.claude/CLAUDE.md");
    expect(out).toContain(`${state} → /opt/data`);
    expect(out).not.toContain("mcpServers");
    expect(out.indexOf("Mounted read-only")).toBeLessThan(out.indexOf("Dry run"));
    expect(await readdir(tmpRoot)).toEqual([]); // masques effacés après coup
  });

  it("chemin de summary.md vu de l'hôte après le run ; code de sortie du conteneur transmis (1 = erreurs au rapport)", async () => {
    const rep = join(state, "imports", "claude-code-20261101-173000");
    const r = await go({}, [{ code: 0, stdout: listJson() }, {
      code: 1,
      then: async () => {
        await mkdir(rep, { recursive: true });
        await writeFile(join(rep, "summary.md"), "# r");
      },
    }]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`Report: ${join(rep, "summary.md")}`);
    // Un ancien rapport n'est pas présenté comme celui de ce run.
    await utimes(join(rep, "summary.md"), new Date(0), new Date(0));
    const old = await go({});
    expect(old.out).not.toContain("Report:");
    await rm(join(state, "imports"), { recursive: true, force: true });
  });

  it("rien de présent : aucun conteneur d'import, code 0", async () => {
    const r = await go({}, [{ code: 0, stdout: listJson("claude-code", [{ path: ".gemini", kind: "dir" }, { path: "/etc", kind: "dir" }], []) }]);
    expect(r).toMatchObject({ code: 0 });
    expect(r.calls).toHaveLength(1);
    expect(r.out).toContain("Nothing to import from claude-code");
  });
});

describe("--project", () => {
  it("claude-code : project_paths montés sous /import-project en :ro, --project /import-project ; .env de la racine jamais monté", async () => {
    const { calls } = await go({ project: repo });
    const vols = volumes(calls[1]!.args);
    expect(vols).toContain(`${repo}/CLAUDE.md:/import-project/CLAUDE.md:ro`);
    expect(vols).toContain(`${repo}/.claude/skills:/import-project/.claude/skills:ro`);
    expect(vols.some((v) => v.startsWith(`${repo}:`) || v.includes(".env:/import-project"))).toBe(false);
    expect(vols.every((v) => v.endsWith(":ro"))).toBe(true);
    expect(calls[1]!.args.slice(-8)).toEqual(["import", "claude-code", "--home", "/import", "--project", "/import-project", "--state-dir", "/opt/data"]);
  });

  const cursorList = (): string =>
    listJson("cursor", [{ path: ".cursor/mcp.json", kind: "file" }], [{ path: ".cursorrules", kind: "file" }, { path: ".cursor/rules", kind: "dir" }, { path: ".cursor/mcp.json", kind: "file" }]);
  /** Le run --apply de cursor : écrit NOKKER.md dans le dossier monté sur /import-out (comme le noyau le ferait). */
  const writesNokkerMd = (calls: Call[], text = "# rules from cursor\n"): Answer => ({
    code: 0,
    then: async () => {
      const v = volumes(calls[calls.length - 1]!.args).find((x) => x.endsWith(":/import-out"))!;
      await writeFile(join(v.slice(0, -":/import-out".length), "NOKKER.md"), text);
    },
  });
  async function goCursor(answers: (calls: Call[]) => Answer[], over: Partial<ImportOptions> = {}) {
    const calls: Call[] = [];
    let out = "";
    const p = prompter(true);
    const code = await runImport({
      source: "cursor", project: repo, apply: true, home, tmpRoot, prompt: { ...p, confirm: async (q) => (p.asked.push(q), out.includes("--apply will write:")) },
      run: fake(calls, answers(calls)), out: (s) => (out += s), err: () => {}, ...over,
    });
    return { code, calls, out };
  }

  it("cursor --apply : dépôt en :ro aux deux runs, /import-out en écriture et --project-out au run --apply seulement, racine jamais en écriture", async () => {
    const { code, calls, out } = await goCursor((c) => [{ code: 0, stdout: cursorList() }, { code: 0 }, writesNokkerMd(c)]);
    expect(code).toBe(0);
    const dry = volumes(calls[1]!.args);
    expect(dry.every((v) => v.endsWith(":ro"))).toBe(true);
    expect(dry).toContain(`${repo}/.cursorrules:/import-project/.cursorrules:ro`);
    expect(calls[1]!.args).not.toContain("--project-out");
    const applied = volumes(calls[2]!.args);
    const rw = applied.filter((v) => !v.endsWith(":ro"));
    expect(rw).toHaveLength(1);
    expect(rw[0]).toMatch(new RegExp(`^${tmpRoot}/nokker-import-out-[^/:]+:/import-out$`));
    expect(applied.some((v) => v.startsWith(`${repo}:`))).toBe(false);
    expect(applied).toContain(`${repo}/.cursor/rules:/import-project/.cursor/rules:ro`);
    expect(calls[2]!.args.slice(-3)).toEqual(["--apply", "--project-out", "/import-out"]);
    // Annonce avant la question : exactement les chemins écrits.
    const announce = out.slice(out.indexOf("--apply will write:"), out.indexOf("Applying the import"));
    expect(announce).toContain(`${state} (kernel state`);
    expect(announce).toContain(`${join(repo, "NOKKER.md")} (only if it does not exist`);
    expect(announce).not.toContain(".nokker");
    // Copie exclusive puis nettoyage.
    expect(await readFile(join(repo, "NOKKER.md"), "utf-8")).toBe("# rules from cursor\n");
    expect(out).toContain(`NOKKER.md written: ${join(repo, "NOKKER.md")}`);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("cursor --apply, NOKKER.md déjà dans le dépôt : monté en :ro pour le conflit, jamais écrasé, dossier temporaire effacé", async () => {
    // NOKKER.md du test précédent toujours là
    const { calls, out } = await goCursor((c) => [{ code: 0, stdout: cursorList() }, { code: 0 }, writesNokkerMd(c, "# overwrite?\n")]);
    expect(volumes(calls[1]!.args)).toContain(`${repo}/NOKKER.md:/import-project/NOKKER.md:ro`);
    expect(await readFile(join(repo, "NOKKER.md"), "utf-8")).toBe("# rules from cursor\n");
    expect(out).not.toContain("NOKKER.md written");
    expect(await readdir(tmpRoot)).toEqual([]);
    await rm(join(repo, "NOKKER.md"));
  });

  it("cursor --apply, noyau ≥ a8dc148 (NOKKER.md dans project_paths) : monté une seule fois, en :ro", async () => {
    await writeFile(join(repo, "NOKKER.md"), "# mine\n");
    const listed = (): string =>
      listJson("cursor", [{ path: ".cursor/mcp.json", kind: "file" }], [{ path: ".cursorrules", kind: "file" }, { path: "NOKKER.md", kind: "file" }]);
    const { calls } = await goCursor((c) => [{ code: 0, stdout: listed() }, { code: 0 }, writesNokkerMd(c, "# overwrite?\n")]);
    for (const call of calls.slice(1)) {
      expect(volumes(call.args).filter((v) => v.includes(":/import-project/NOKKER.md"))).toEqual([`${repo}/NOKKER.md:/import-project/NOKKER.md:ro`]);
    }
    expect(await readFile(join(repo, "NOKKER.md"), "utf-8")).toBe("# mine\n");
    await rm(join(repo, "NOKKER.md"));
  });

  it("copyNokkerMd : création exclusive, lien de sortie non suivi", async () => {
    const o = join(dir, "out1");
    await mkdir(o, { recursive: true });
    await symlink(join(outside, "secret.txt"), join(o, "NOKKER.md"));
    expect(copyNokkerMd(o, repo, () => {})).toBe(false);
    await rm(join(o, "NOKKER.md"));
    await writeFile(join(o, "NOKKER.md"), "x");
    expect(copyNokkerMd(o, repo, () => {})).toBe(true);
    expect(copyNokkerMd(o, repo, () => {})).toBe(false);
    await rm(join(repo, "NOKKER.md"));
  });

  it("cursor sans --apply : aucun montage en écriture, pas de --project-out", async () => {
    const r = await go({ source: "cursor", project: repo }, [{ code: 0, stdout: cursorList() }, { code: 0 }]);
    expect(volumes(r.calls[1]!.args).every((v) => v.endsWith(":ro"))).toBe(true);
    expect(r.calls[1]!.args).not.toContain("--project-out");
  });

  it("claude-code --apply : <dépôt>/.nokker créé et monté en écriture au run --apply seulement, annoncé ; rien d'autre en écriture", async () => {
    const p = prompter(true);
    const { calls, out } = await go({ project: repo, apply: true, prompt: p });
    const dry = volumes(calls[1]!.args);
    expect(dry.every((v) => v.endsWith(":ro"))).toBe(true);
    expect(dry.some((v) => v.includes(".nokker"))).toBe(false); // absent au run à blanc
    const rw = volumes(calls[2]!.args).filter((v) => !v.endsWith(":ro"));
    expect(rw).toEqual([`${repo}/.nokker:/import-project/.nokker`]);
    expect(calls[2]!.args).not.toContain("--project-out");
    expect(statSync(join(repo, ".nokker")).isDirectory()).toBe(true);
    expect(out).toContain(`${repo}/.nokker/ (repository skills and hooks) → /import-project/.nokker, read-write (created)`);
    expect(out.indexOf("read-write (created)")).toBeLessThan(out.indexOf("Applying the import"));
  });

  it("claude-code, .nokker existant : en :ro au run à blanc (conflits), en écriture au run --apply, .env masqué ; lien refusé", async () => {
    await writeFile(join(repo, ".nokker", ".env"), "K=v");
    const { calls } = await go({ project: repo, apply: true, prompt: prompter(true) });
    expect(volumes(calls[1]!.args)).toContain(`${repo}/.nokker:/import-project/.nokker:ro`);
    const applied = volumes(calls[2]!.args);
    expect(applied[0]).toBe(`${repo}/.nokker:/import-project/.nokker`);
    expect(applied.find((v) => v.endsWith(":/import-project/.nokker/.env:ro"))).toMatch(/\/empty:/);
    await rm(join(repo, ".nokker"), { recursive: true });
    await symlink(outside, join(repo, ".nokker"));
    const r = await go({ project: repo, apply: true, prompt: prompter(true) });
    expect(r).toMatchObject({ code: 1 });
    expect(r.calls).toHaveLength(1);
    expect(r.err).toContain("is not a plain folder");
    await rm(join(repo, ".nokker"));
  });

  it("hermes / openclaw : --project refusé, code 2 ; projet = home : refusé", async () => {
    const r = await go({ source: "hermes", project: repo });
    expect(r).toMatchObject({ code: 2, calls: [] });
    expect(r.err).toContain("--project only applies to claude-code, cursor: hermes reads nothing in a project.");
    const h = await go({ project: home });
    expect(h).toMatchObject({ code: 2, calls: [] });
    expect(h.err).toContain("is (or contains) the home folder");
    expect((await go({ project: dir })).code).toBe(2); // contient le home
  });
});

describe("--apply", () => {
  it("à blanc, rapport montré, question, puis le même run avec --apply, sur un terminal (sans -T)", async () => {
    const p = prompter(true);
    const { code, calls, out } = await go({ apply: true, prompt: p });
    expect(code).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.args).not.toContain("--apply");
    expect(calls[1]!.args).toContain("-T");
    expect(calls[2]!.args).toEqual([...calls[1]!.args.filter((x) => x !== "-T"), "--apply"]);
    expect(p.asked).toEqual(["Apply this import to the state of Nokker? [y/N] "]);
    expect(out).not.toContain("will not be added");
  });

  it("refus : rien n'est écrit, code 1", async () => {
    const r = await go({ apply: true, prompt: prompter(false) });
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(2);
    expect(r.err).toContain("Import cancelled: nothing was written.");
  });

  it("--yes sans terminal : pas de question, à blanc puis --apply avec -T, avertissement sur les serveurs MCP", async () => {
    const p = prompter(false, false);
    const r = await go({ apply: true, yes: true, prompt: p });
    expect(r.code).toBe(0);
    expect(p.asked).toEqual([]);
    expect(r.calls.map((c) => c.args.includes("--apply"))).toEqual([false, false, true]);
    expect(r.calls[2]!.args).toContain("-T");
    expect(r.out).toContain("MCP servers found by the import will not be added");
  });

  it("--yes sur un terminal : pas de question, --apply sans -T", async () => {
    const p = prompter(false, true);
    const r = await go({ apply: true, yes: true, prompt: p });
    expect(p.asked).toEqual([]);
    expect(r.calls[2]!.args).not.toContain("-T");
  });

  it("sans terminal et sans --yes : code 2, aucun docker lancé", async () => {
    const r = await go({ apply: true, prompt: prompter(true, false) });
    expect(r).toMatchObject({ code: 2, calls: [] });
    expect(r.err).toContain("confirm with --yes");
  });

  it("à blanc en échec : pas de question, pas d'--apply, code du conteneur", async () => {
    const p = prompter(true);
    const r = await go({ apply: true, prompt: p }, [{ code: 0, stdout: listJson() }, { code: 3 }]);
    expect(r.code).toBe(3);
    expect(r.calls).toHaveLength(2);
    expect(p.asked).toEqual([]);
  });

  it("question en français : [o/N]", async () => {
    setLang("fr");
    const p = prompter(true);
    await go({ apply: true, prompt: p });
    expect(p.asked).toEqual(["Appliquer cet import à l'état de Nokker ? [o/N] "]);
  });
});

describe("analyse des arguments", () => {
  it("import <source> [--project <dir>] [--apply] [--yes]", () => {
    expect(parseArgs(["import", "hermes"], {})).toMatchObject({ command: "import", importSource: "hermes", project: null, apply: false, yes: false, error: null });
    expect(parseArgs(["import", "openclaw", "--apply", "--yes"], {})).toMatchObject({ importSource: "openclaw", apply: true, yes: true, error: null });
    expect(parseArgs(["import", "-y", "--apply", "cursor", "--project", "."], {})).toMatchObject({ importSource: "cursor", project: ".", apply: true, yes: true, error: null });
  });
  it("erreurs d'usage", () => {
    expect(parseArgs(["import"], {}).error).toContain("import expects one of: claude-code, cursor, hermes, openclaw");
    expect(parseArgs(["import", "vscode"], {}).error).toContain("import expects one of");
    expect(parseArgs(["import", "cursor", "extra"], {}).error).toContain("unknown argument: extra");
    expect(parseArgs(["import", "cursor", "--project"], {}).error).toContain("--project expects");
    expect(parseArgs(["import", "openclaw", "--project", "/r"], {}).error).toContain("--project only applies to claude-code, cursor");
    expect(parseArgs(["backup", "--apply"], {}).error).toContain("--apply only applies to nokker import");
    expect(parseArgs(["backup", "--project", "/r"], {}).error).toContain("--project only applies to nokker import");
    expect(parseArgs(["backup", "--yes"], {}).error).toContain("--yes only applies to nokker restore, nokker import");
  });
});

describe("bin sans TTY", () => {
  it("import cursor --apply sans --yes : code 2 avant tout docker", () => {
    const bin = join(import.meta.dirname, "../bin/nokker.mjs");
    const r = spawnSync(process.execPath, [bin, "import", "cursor", "--apply"], {
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8", timeout: 30_000, env: { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: dir },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("confirm with --yes");
  });
});
