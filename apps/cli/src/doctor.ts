/**
 * `nokker doctor` — contrôles en table : docker joignable, compose Lokkal présent, `/healthz` du serveur,
 * jeton local ou appareil valide, mémoire longue du noyau (`GET /v1/local/memory`), version du client contre la minimale
 * annoncée, git présent ; coffre OpenBao si l'installation en a un (`NOKKER_SECRETS_PROVIDER=openbao`).
 * Aucune exception ne remonte : un binaire absent est un résultat, pas une trace d'erreur.
 */
import { NokkerApiError, NokkerClient, type LocalMemoryStatus } from "@nokker-apps/sdk";
import { BRAND } from "@nokker-apps/brand";
import { isLocalServer, loadSession, readLocalToken } from "./auth.js";
import { existsSync } from "node:fs";
import { legacyLokkalFilePaths, lokkalFilePath } from "./config.js";
import { t } from "./i18n/index.js";
import { composeArgs, hostCommand, readLokkal, sourceLabel, type ServerSource } from "./lokkal.js";
import { firstLine, run as realRun, type Runner } from "./proc.js";
import { CLI_VERSION, compareVersions } from "./version.js";
import { checkVault } from "./vault-check.js";

export type CheckStatus = "ok" | "warn" | "ko";
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorOptions {
  serverUrl: string;
  fix: boolean;
  /** D'où vient `serverUrl` (--server, NOKKER_SERVER_URL, lokkal.json, défaut) : dit par la ligne « serveur ». */
  serverSource?: ServerSource;
  run?: Runner;
  /** Autres adresses sondées pour dire « ça répond ailleurs » (défaut : 8742 et le mock de dev 4310). */
  candidates?: string[];
  /** Test : `fetch` de la sonde web_url. */
  http?: (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number }>;
  /** Test : remplace `fetch` pour les sondes HTTP. */
  fetchImpl?: ConstructorParameters<typeof NokkerClient>[0]["fetchImpl"];
}

const CANDIDATES = ["http://127.0.0.1:8742", "http://127.0.0.1:4310"];

/** Contrôle « mémoire » (LOKKAL.md §7.13.6) : `direct` et `ok` → ok ; `mcp`/`off` → avertissement ; `ok: false` → échec
 * avec la raison du noyau. */
export function memoryCheck(m: LocalMemoryStatus): Check {
  const name = t("memory");
  if (m.ok === false) {
    return { name, status: "ko", detail: t("long-term memory ({0}) is down — {1}", String(m.mode), m.error ?? m.last_error ?? t("unknown reason")) };
  }
  if (m.mode === "off") return { name, status: "warn", detail: t("long-term memory disabled (memory_mode: off): nothing is recalled from one thread to the next") };
  if (m.mode === "mcp") return { name, status: "warn", detail: t("long-term memory through MCP: status not checked here (the remote service has its own)") };
  if (m.mode !== "direct" || m.ok !== true) return { name, status: "warn", detail: t("unexpected mode {0}", String(m.mode)) };
  const parts: string[] = [t("direct")];
  if (m.store?.notes != null) parts.push(t("{0} note(s)", m.store.notes));
  if (m.embed?.dim) parts.push(m.embed.ms != null ? t("embeddings {0} dim in {1} ms", m.embed.dim, m.embed.ms) : t("embeddings {0} dim", m.embed.dim));
  if (m.last_recall_ms != null) parts.push(t("last recall {0} ms", m.last_recall_ms));
  const tail = m.last_error ? t(" — last error: {0}", m.last_error) : "";
  return { name, status: "ok", detail: `${parts.join(", ")}${tail}` };
}

async function probeMemory(client: NokkerClient): Promise<Check> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    return memoryCheck(await client.getLocalMemory(ctl.signal));
  } catch (err) {
    const name = t("memory");
    if (err instanceof NokkerApiError && err.status === 404) return { name, status: "warn", detail: t("kernel without GET /v1/local/memory (predates direct memory)") };
    if (err instanceof NokkerApiError && err.status === 401) return { name, status: "warn", detail: t("cannot be checked without the local token") };
    return { name, status: "warn", detail: t("status unreadable ({0})", ctl.signal.aborted ? t("timed out") : String(err).replace(/^Error: /, "")) };
  } finally {
    clearTimeout(timer);
  }
}

async function probe(url: string, fetchImpl: DoctorOptions["fetchImpl"]): Promise<{ ok: boolean; body?: Awaited<ReturnType<NokkerClient["healthz"]>>; error?: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    const client = new NokkerClient({ baseUrl: url, userAgent: BRAND.userAgent, ...(fetchImpl ? { fetchImpl } : {}) });
    return { ok: true, body: await client.healthz(ctl.signal) };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return { ok: false, error: cause ?? (ctl.signal.aborted ? t("timed out") : String(err).replace(/^Error: /, "")) };
  } finally {
    clearTimeout(timer);
  }
}

export async function runDoctor(opts: DoctorOptions): Promise<{ checks: Check[]; code: number }> {
  const run = opts.run ?? realRun;
  const checks: Check[] = [];
  const fixes: string[] = [];

  // 1. docker (sous Windows : dans WSL, `wsl.exe -d <distro> -- docker …`)
  const lokkal = readLokkal();
  const hostCfg = lokkal.status === "ok" ? lokkal.config : null;
  const dk = hostCommand(hostCfg, "docker", ["info", "--format", "{{.ServerVersion}}"]);
  const docker = await run(dk.cmd, dk.args, { timeoutMs: 15_000 });
  let dockerOk = false;
  if (docker.error === "ENOENT") checks.push({ name: "docker", status: "ko", detail: hostCfg?.wsl_distro ? t("wsl.exe not found (is WSL 2 installed?)") : t("docker is not installed (or not in PATH)") });
  else if (docker.code === 0) {
    dockerOk = true;
    const inWsl = hostCfg?.wsl_distro ? t(" in WSL ({0})", hostCfg.wsl_distro) : "";
    checks.push({ name: "docker", status: "ok", detail: t("daemon reachable{0} ({1})", inWsl, docker.stdout.trim() || t("unknown version")) });
  } else {
    checks.push({ name: "docker", status: "ko", detail: t("daemon unreachable — {0}", firstLine(docker.stderr) || docker.error || t("no response")) });
  }

  // 2. compose Lokkal
  const composeName = t("Lokkal compose");
  if (lokkal.status === "absent") {
    checks.push({ name: composeName, status: "warn", detail: t("lokkal.json is missing (no Lokkal installed by install.sh?)") });
  } else if (lokkal.status === "invalid") {
    checks.push({ name: composeName, status: "ko", detail: lokkal.error });
  } else if (!lokkal.composeExists) {
    checks.push({ name: composeName, status: "ko", detail: t("{0} not found", lokkal.config.compose) });
  } else {
    checks.push({ name: composeName, status: "ok", detail: t("{0} (project {1}, version {2})", lokkal.config.compose, lokkal.config.project, lokkal.config.version) });
  }
  const composeReady = lokkal.status === "ok" && lokkal.composeExists ? lokkal.config : null;
  const legacy = (lokkal.status === "ok" ? lokkal.legacyPath : undefined) ?? legacyLokkalFilePaths().find((p) => existsSync(p));
  if (legacy) {
    checks.push({ name: t("config location"), status: "warn", detail: t("lokkal.json read from the old location {0}; the installer writes it to {1} — rerun install.sh or move it", legacy, lokkalFilePath()) });
  }

  // interface web : GET <web_url>/healthz → 200 (web_url ne sert qu'à ça)
  if (lokkal.status === "ok") {
    const web = lokkal.config.web_url.replace(/\/+$/, "");
    const webName = t("web interface");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    try {
      const res = await (opts.http ?? fetch)(`${web}/healthz`, { signal: ctl.signal });
      checks.push(res.status === 200
        ? { name: webName, status: "ok", detail: `${web}/healthz → 200` }
        : { name: webName, status: "ko", detail: `${web}/healthz → ${res.status}` });
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      checks.push({ name: webName, status: "ko", detail: t("{0}/healthz unreachable ({1})", web, cause ?? (ctl.signal.aborted ? t("timed out") : t("network error"))) });
    } finally {
      clearTimeout(timer);
    }
  }

  // 3. serveur : ce qui répond
  const serverName = t("server");
  const urls = [...new Set([opts.serverUrl, ...(opts.candidates ?? CANDIDATES)])];
  const probes = await Promise.all(urls.map(async (u) => ({ u, r: await probe(u, opts.fetchImpl) })));
  const main = probes[0]!;
  let health = main.r.body;
  if (main.r.ok) {
    const src = main.u === opts.serverUrl && opts.serverSource ? ` (${sourceLabel(opts.serverSource)})` : "";
    const ver = main.r.body?.version ? t(" (version {0})", main.r.body.version) : "";
    const mock = main.r.body?.mock ? t(" — dev MOCK") : "";
    checks.push({ name: serverName, status: "ok", detail: t("{0}{1} responds{2}{3}", main.u, src, ver, mock) });
  } else {
    const others = probes.slice(1).filter((p) => p.r.ok).map((p) => `${p.u}${p.r.body?.mock ? t(" (dev mock)") : ""}`);
    const src = opts.serverSource ? ` (${sourceLabel(opts.serverSource)})` : "";
    const elsewhere = others.length ? t(" — but something responds on {0}: use --server", others.join(", ")) : "";
    checks.push({
      name: serverName,
      status: "ko",
      detail: t("{0}{1} does not respond ({2}){3}", main.u, src, main.r.error ?? "", elsewhere),
    });
    if (opts.fix && dockerOk && composeReady) fixes.push("up");
  }

  // 4. identité
  const authName = t("authentication");
  if (!main.r.ok) {
    checks.push({ name: authName, status: "warn", detail: t("cannot be checked without a server") });
  } else {
    const client = new NokkerClient({ baseUrl: main.u, userAgent: BRAND.userAgent, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
    const local = isLocalServer(main.u) ? await readLocalToken() : null;
    const saved = await loadSession();
    if (local) {
      client.setToken(local);
      const ok = await client.listThreads().then(() => true, () => false);
      checks.push(ok
        ? { name: authName, status: "ok", detail: t("local token accepted (no enrolment needed)") }
        : { name: authName, status: "ko", detail: t("local token present but rejected by the server (stale? restart the kernel)") });
      // Mémoire longue : route sous jeton local seulement (un mock de dev n'en a pas toujours une).
      if (ok) checks.push(await probeMemory(client));
    } else if (saved) {
      client.setToken(saved.token);
      const ok = await client.listThreads().then(() => true, () => false);
      checks.push(ok
        ? { name: authName, status: "ok", detail: t("device enrolled, session of {0} valid until {1}", saved.user, saved.expires_at) }
        : { name: authName, status: "warn", detail: t("device session expired — rerun nokker to sign in again") });
    } else {
      checks.push({ name: authName, status: "warn", detail: t("neither a local token nor an enrolled device — the first run of nokker will enrol you") });
    }
  }

  // 5. version
  const min = health?.min_client_version;
  const versionName = t("client version");
  if (!main.r.ok) checks.push({ name: versionName, status: "warn", detail: t("{0} (minimum unknown: server unreachable)", CLI_VERSION) });
  else if (!min) checks.push({ name: versionName, status: "ok", detail: t("{0} (the server announces no minimum)", CLI_VERSION) });
  else if (compareVersions(CLI_VERSION, min) < 0) {
    checks.push({ name: versionName, status: "ko", detail: t("{0} < minimum {1} — run 'nokker update'", CLI_VERSION, min) });
  } else checks.push({ name: versionName, status: "ok", detail: t("{0} ≥ minimum {1}", CLI_VERSION, min) });

  // 6. git
  const git = await run("git", ["--version"], { timeoutMs: 5000 });
  checks.push(git.code === 0
    ? { name: "git", status: "ok", detail: git.stdout.trim() }
    : { name: "git", status: "ko", detail: t("git is missing from the host (needed for /diff and checkpoints)") });

  // 7. coffre (X4) : seulement si l'installation utilise OpenBao (sinon aucune ligne)
  if (dockerOk && composeReady) {
    const vault = await checkVault(composeReady, run);
    if (vault) checks.push(vault);
  }

  // --fix : relance ce qui peut l'être
  const repairName = t("repair");
  if (fixes.includes("up") && composeReady) {
    const upCmd = hostCommand(composeReady, "docker", [...composeArgs(composeReady), "up", "-d"]);
    const up = await run(upCmd.cmd, upCmd.args, { timeoutMs: 300_000 });
    checks.push({ name: repairName, status: up.code === 0 ? "ok" : "ko", detail: up.code === 0 ? t("docker compose up -d started") : t("docker compose up -d failed — {0}", firstLine(up.stderr)) });
    if (up.code === 0) {
      await new Promise((r) => setTimeout(r, 2000));
      const again = await probe(opts.serverUrl, opts.fetchImpl);
      checks.push({ name: t("server (after)"), status: again.ok ? "ok" : "warn", detail: again.ok ? t("{0} responds", opts.serverUrl) : t("does not respond yet — wait a few seconds and rerun doctor") });
    }
  } else if (opts.fix && !fixes.length && checks.some((c) => c.status === "ko")) {
    checks.push({ name: repairName, status: "warn", detail: t("nothing can be repaired automatically (docker must be reachable and a compose file known)") });
  }

  return { checks, code: checks.some((c) => c.status === "ko") ? 1 : 0 };
}

const GLYPH: Record<CheckStatus, string> = { ok: "✓", warn: "!", ko: "✗" };

export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks.map((c) => `${GLYPH[c.status]} ${c.name.padEnd(width)}  ${c.detail}`).join("\n");
}
