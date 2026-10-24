/**
 * `nokker doctor` — contrôles en table : docker joignable, compose Lokkal présent, `/healthz` du serveur,
 * jeton local ou appareil valide, version du client contre la minimale annoncée, git présent ; coffre OpenBao si
 * l'installation en a un (`NOKKER_SECRETS_PROVIDER=openbao`).
 * Aucune exception ne remonte : un binaire absent est un résultat, pas une trace d'erreur.
 */
import { NokkerClient } from "@nokker-apps/sdk";
import { BRAND } from "@nokker-apps/brand";
import { isLocalServer, loadSession, readLocalToken } from "./auth.js";
import { existsSync } from "node:fs";
import { legacyLokkalFilePaths, lokkalFilePath } from "./config.js";
import { composeArgs, hostCommand, readLokkal, type ServerSource } from "./lokkal.js";
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

async function probe(url: string, fetchImpl: DoctorOptions["fetchImpl"]): Promise<{ ok: boolean; body?: Awaited<ReturnType<NokkerClient["healthz"]>>; error?: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    const client = new NokkerClient({ baseUrl: url, userAgent: BRAND.userAgent, ...(fetchImpl ? { fetchImpl } : {}) });
    return { ok: true, body: await client.healthz(ctl.signal) };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return { ok: false, error: cause ?? (ctl.signal.aborted ? "délai dépassé" : String(err).replace(/^Error: /, "")) };
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
  if (docker.error === "ENOENT") checks.push({ name: "docker", status: "ko", detail: hostCfg?.wsl_distro ? "wsl.exe introuvable (WSL 2 est-il installé ?)" : "docker n'est pas installé (ou pas dans le PATH)" });
  else if (docker.code === 0) {
    dockerOk = true;
    checks.push({ name: "docker", status: "ok", detail: `démon joignable${hostCfg?.wsl_distro ? ` dans WSL (${hostCfg.wsl_distro})` : ""} (${docker.stdout.trim() || "version inconnue"})` });
  } else {
    checks.push({ name: "docker", status: "ko", detail: `démon injoignable — ${firstLine(docker.stderr) || docker.error || "pas de réponse"}` });
  }

  // 2. compose Lokkal
  if (lokkal.status === "absent") {
    checks.push({ name: "compose Lokkal", status: "warn", detail: "lokkal.json absent (aucun Lokkal installé par install.sh ?)" });
  } else if (lokkal.status === "invalid") {
    checks.push({ name: "compose Lokkal", status: "ko", detail: lokkal.error });
  } else if (!lokkal.composeExists) {
    checks.push({ name: "compose Lokkal", status: "ko", detail: `${lokkal.config.compose} introuvable` });
  } else {
    checks.push({ name: "compose Lokkal", status: "ok", detail: `${lokkal.config.compose} (projet ${lokkal.config.project}, version ${lokkal.config.version})` });
  }
  const composeReady = lokkal.status === "ok" && lokkal.composeExists ? lokkal.config : null;
  const legacy = (lokkal.status === "ok" ? lokkal.legacyPath : undefined) ?? legacyLokkalFilePaths().find((p) => existsSync(p));
  if (legacy) {
    checks.push({ name: "emplacement de config", status: "warn", detail: `lokkal.json lu à l'ancien emplacement ${legacy} ; l'installeur l'écrit dans ${lokkalFilePath()} — relance install.sh ou déplace-le` });
  }

  // interface web : GET <web_url>/healthz → 200 (web_url ne sert qu'à ça)
  if (lokkal.status === "ok") {
    const web = lokkal.config.web_url.replace(/\/+$/, "");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    try {
      const res = await (opts.http ?? fetch)(`${web}/healthz`, { signal: ctl.signal });
      checks.push(res.status === 200
        ? { name: "interface web", status: "ok", detail: `${web}/healthz → 200` }
        : { name: "interface web", status: "ko", detail: `${web}/healthz → ${res.status}` });
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      checks.push({ name: "interface web", status: "ko", detail: `${web}/healthz injoignable (${cause ?? (ctl.signal.aborted ? "délai dépassé" : "erreur réseau")})` });
    } finally {
      clearTimeout(timer);
    }
  }

  // 3. serveur : ce qui répond
  const urls = [...new Set([opts.serverUrl, ...(opts.candidates ?? CANDIDATES)])];
  const probes = await Promise.all(urls.map(async (u) => ({ u, r: await probe(u, opts.fetchImpl) })));
  const main = probes[0]!;
  let health = main.r.body;
  if (main.r.ok) {
    checks.push({ name: "serveur", status: "ok", detail: `${main.u}${main.u === opts.serverUrl && opts.serverSource ? ` (${opts.serverSource})` : ""} répond${main.r.body?.version ? ` (version ${main.r.body.version})` : ""}${main.r.body?.mock ? " — MOCK de dev" : ""}` });
  } else {
    const others = probes.slice(1).filter((p) => p.r.ok).map((p) => `${p.u}${p.r.body?.mock ? " (mock de dev)" : ""}`);
    checks.push({
      name: "serveur",
      status: "ko",
      detail: `${main.u}${opts.serverSource ? ` (${opts.serverSource})` : ""} ne répond pas (${main.r.error})${others.length ? ` — mais ça répond sur ${others.join(", ")} : utilise --server` : ""}`,
    });
    if (opts.fix && dockerOk && composeReady) fixes.push("up");
  }

  // 4. identité
  if (!main.r.ok) {
    checks.push({ name: "authentification", status: "warn", detail: "non vérifiable sans serveur" });
  } else {
    const client = new NokkerClient({ baseUrl: main.u, userAgent: BRAND.userAgent, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
    const local = isLocalServer(main.u) ? await readLocalToken() : null;
    const saved = await loadSession();
    if (local) {
      client.setToken(local);
      const ok = await client.listThreads().then(() => true, () => false);
      checks.push(ok
        ? { name: "authentification", status: "ok", detail: "jeton local accepté (aucun enrôlement nécessaire)" }
        : { name: "authentification", status: "ko", detail: "jeton local présent mais refusé par le serveur (périmé ? relance le noyau)" });
    } else if (saved) {
      client.setToken(saved.token);
      const ok = await client.listThreads().then(() => true, () => false);
      checks.push(ok
        ? { name: "authentification", status: "ok", detail: `appareil enrôlé, session de ${saved.user} valide jusqu'à ${saved.expires_at}` }
        : { name: "authentification", status: "warn", detail: "session d'appareil expirée — relance nokker pour te reconnecter" });
    } else {
      checks.push({ name: "authentification", status: "warn", detail: "ni jeton local ni appareil enrôlé — le premier lancement de nokker t'enrôlera" });
    }
  }

  // 5. version
  const min = health?.min_client_version;
  if (!main.r.ok) checks.push({ name: "version client", status: "warn", detail: `${CLI_VERSION} (minimale inconnue : serveur injoignable)` });
  else if (!min) checks.push({ name: "version client", status: "ok", detail: `${CLI_VERSION} (le serveur n'annonce pas de minimale)` });
  else if (compareVersions(CLI_VERSION, min) < 0) {
    checks.push({ name: "version client", status: "ko", detail: `${CLI_VERSION} < minimale ${min} — lancez « nokker update »` });
  } else checks.push({ name: "version client", status: "ok", detail: `${CLI_VERSION} ≥ minimale ${min}` });

  // 6. git
  const git = await run("git", ["--version"], { timeoutMs: 5000 });
  checks.push(git.code === 0
    ? { name: "git", status: "ok", detail: git.stdout.trim() }
    : { name: "git", status: "ko", detail: "git absent de l'hôte (nécessaire pour /diff et les points de retour)" });

  // 7. coffre (X4) : seulement si l'installation utilise OpenBao (sinon aucune ligne)
  if (dockerOk && composeReady) {
    const vault = await checkVault(composeReady, run);
    if (vault) checks.push(vault);
  }

  // --fix : relance ce qui peut l'être
  if (fixes.includes("up") && composeReady) {
    const upCmd = hostCommand(composeReady, "docker", [...composeArgs(composeReady), "up", "-d"]);
    const up = await run(upCmd.cmd, upCmd.args, { timeoutMs: 300_000 });
    checks.push({ name: "réparation", status: up.code === 0 ? "ok" : "ko", detail: up.code === 0 ? "docker compose up -d lancé" : `docker compose up -d a échoué — ${firstLine(up.stderr)}` });
    if (up.code === 0) {
      await new Promise((r) => setTimeout(r, 2000));
      const again = await probe(opts.serverUrl, opts.fetchImpl);
      checks.push({ name: "serveur (après)", status: again.ok ? "ok" : "warn", detail: again.ok ? `${opts.serverUrl} répond` : "ne répond pas encore — patiente quelques secondes et relance doctor" });
    }
  } else if (opts.fix && !fixes.length && checks.some((c) => c.status === "ko")) {
    checks.push({ name: "réparation", status: "warn", detail: "rien de réparable automatiquement (il faut docker joignable et un compose connu)" });
  }

  return { checks, code: checks.some((c) => c.status === "ko") ? 1 : 0 };
}

const GLYPH: Record<CheckStatus, string> = { ok: "✓", warn: "!", ko: "✗" };

export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks.map((c) => `${GLYPH[c.status]} ${c.name.padEnd(width)}  ${c.detail}`).join("\n");
}
