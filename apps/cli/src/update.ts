/**
 * `nokker update [--check]` (contrat emballage) :
 *  - `--check` compare la `version` de lokkal.json à la dernière release GitHub `lokkal-v*` de `nokker-ai/nokker`
 *    (API publique, sans jeton ; l'absence de réseau est tolérée) ;
 *  - sinon : version cible = `--version X.Y.Z` ou la dernière release ; télécharge l'`install.sh` de CETTE release
 *    (+ `.sha256` obligatoire, + `.sigstore.json` vérifié par cosign s'il est installé) et lance
 *    `sh <install.sh> --update --version <cible>` ; empreinte ou signature fausse = refus, rien n'est exécuté.
 *    Release sans install.sh : réécrit `NOKKER_VERSION=<cible>` dans `env_file` puis
 *    `docker compose -p <project> -f <compose> pull && up -d`. Attend `/healthz`, et finit par remplacer le binaire
 *    `nokker` par celui de la même release.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NokkerClient, type Healthz } from "@nokker-apps/sdk";
import { BRAND } from "@nokker-apps/brand";
import { lokkalProblem, readLokkal, composeArgs, hostCommand, type LokkalConfig } from "./lokkal.js";
import { lokkalFilePath } from "./config.js";
import { t } from "./i18n/index.js";
import { firstLine, run as realRun, type Runner } from "./proc.js";
import { CLI_VERSION, compareSemver, compareVersions } from "./version.js";

export const RELEASES_REPO = "nokker-ai/nokker";
export const RELEASE_TAG_PREFIX = "lokkal-v";
/** Identité attendue des signatures (même règle que install.sh) : le workflow de release du dépôt, sur un tag lokkal-v. */
export const COSIGN_IDENTITY_RE = `^https://github\\.com/${RELEASES_REPO.replace(/\./g, "\\.")}/\\.github/workflows/lokkal-images\\.yml@refs/tags/lokkal-v`;
export const COSIGN_ISSUER = "https://token.actions.githubusercontent.com";
export const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;

function cosignVerifyArgs(bundle: string, file: string): string[] {
  return ["verify-blob", "--bundle", bundle, "--certificate-identity-regexp", COSIGN_IDENTITY_RE, "--certificate-oidc-issuer", COSIGN_ISSUER, file];
}

type HttpFetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface UpdateOptions {
  serverUrl: string;
  check: boolean;
  /** `--version X.Y.Z` : version cible (sinon la dernière release). */
  version?: string | null;
  run?: Runner;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Test : `fetch` du SDK pour /healthz. */
  fetchImpl?: ConstructorParameters<typeof NokkerClient>[0]["fetchImpl"];
  /** Test : `fetch` pour GitHub (API et téléchargement du binaire). */
  http?: HttpFetch;
  healthWaitMs?: number;
  /** Test : chemin du binaire à remplacer (`null` = pas un binaire autonome). Défaut : `process.execPath` s'il s'appelle `nokker*`. */
  selfPath?: string | null;
  platform?: { os: "linux" | "darwin" | "windows"; arch: "x64" | "arm64" };
  /** Test : dossier temporaire où l'installeur est téléchargé (défaut : `os.tmpdir()`). */
  tmpRoot?: string;
}

export interface Release {
  version: string;
  tag: string;
}

async function health(opts: UpdateOptions): Promise<Healthz | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    return await new NokkerClient({ baseUrl: opts.serverUrl, userAgent: BRAND.userAgent, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }).healthz(ctl.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function httpOf(opts: UpdateOptions): HttpFetch {
  return opts.http ?? ((url, init) => fetch(url, init as RequestInit) as never);
}

/** Release `lokkal-v*` la plus HAUTE en semver (préversions comprises : elles ne l'emportent que si aucune finale n'est
 * plus haute), quel que soit l'ordre de l'API ; brouillons et tags mal formés exclus. `null` si GitHub est injoignable. */
export async function latestRelease(http: HttpFetch): Promise<Release | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await http(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=100`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": BRAND.userAgent },
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const list = (await res.json()) as Array<{ tag_name?: string; draft?: boolean; prerelease?: boolean }>;
    let best: Release | null = null;
    for (const r of Array.isArray(list) ? list : []) {
      if (r.draft || !r.tag_name?.startsWith(RELEASE_TAG_PREFIX)) continue;
      const version = r.tag_name.slice(RELEASE_TAG_PREFIX.length);
      if (!VERSION_RE.test(version)) continue;
      if (!best || compareSemver(version, best.version) > 0) best = { tag: r.tag_name, version };
    }
    return best;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function clientHint(h: Healthz | null): string | null {
  const min = h?.min_client_version;
  if (min && compareVersions(CLI_VERSION, min) < 0) {
    return t("The server requires a client ≥ {0} (yours: {1}) — nokker update replaces the binary with the one from the latest release.", min, CLI_VERSION);
  }
  return null;
}

export function currentPlatform(): { os: "linux" | "darwin" | "windows"; arch: "x64" | "arm64" } {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  return { os, arch: process.arch === "arm64" ? "arm64" : "x64" };
}

export function assetName(p: { os: string; arch: string }): string {
  return `nokker-${p.os}-${p.arch}${p.os === "windows" ? ".exe" : ""}`;
}

/** Remplace (ou ajoute) `NOKKER_VERSION=<v>` dans un fichier .env en conservant le reste et les droits. */
export function setEnvVersionFile(envFile: string, version: string): void {
  const text = existsSync(envFile) ? readFileSync(envFile, "utf-8") : "";
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => /^\s*NOKKER_VERSION\s*=/.test(l));
  if (idx >= 0) lines[idx] = `NOKKER_VERSION=${version}`;
  else {
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(`NOKKER_VERSION=${version}`, "");
  }
  writeFileSync(envFile, lines.join("\n"), { mode: 0o600 });
}

/** Écrit `NOKKER_VERSION` dans env_file : directement, ou (WSL, chemin Linux) par `sh -c` dans la distro. */
async function setEnvVersion(cfg: LokkalConfig, version: string, run: Runner): Promise<boolean> {
  if (!cfg.wsl_distro) {
    try {
      setEnvVersionFile(cfg.env_file, version);
      return true;
    } catch {
      return false;
    }
  }
  const f = cfg.env_file.replace(/'/g, "'\\''");
  const script = `grep -q '^NOKKER_VERSION=' '${f}' && sed -i 's/^NOKKER_VERSION=.*/NOKKER_VERSION=${version}/' '${f}' || echo 'NOKKER_VERSION=${version}' >> '${f}'`;
  const h = hostCommand(cfg, "sh", ["-c", script]);
  return (await run(h.cmd, h.args, { timeoutMs: 15_000 })).code === 0;
}

function setLokkalVersion(version: string): void {
  try {
    const path = lokkalFilePath();
    const doc = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    doc.version = version;
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // sans importance : install.sh réécrit ce fichier
  }
}

export type InstallerFetch =
  | { status: "absent" }
  | { status: "refused"; reason: string }
  | { status: "ok"; path: string; dir: string; signed: boolean };

/** Télécharge `install.sh` de la release `lokkal-v<version>` dans un dossier temporaire 0700 et le vérifie :
 * sha256 TOUJOURS (`install.sh.sha256`, sortie de `sha256sum`), signature `install.sh.sigstore.json` si `cosign` est
 * présent (même identité et même émetteur qu'install.sh). `absent` = la release ne publie pas d'install.sh (404) ;
 * `refused` = rien ne doit être exécuté (le dossier temporaire est déjà effacé). */
export async function fetchInstaller(opts: UpdateOptions, version: string): Promise<InstallerFetch> {
  const http = httpOf(opts);
  const run = opts.run ?? realRun;
  const base = `https://github.com/${RELEASES_REPO}/releases/download/${RELEASE_TAG_PREFIX}${version}/install.sh`;
  let body: Buffer;
  try {
    const res = await http(base);
    if (res.status === 404) return { status: "absent" };
    if (!res.ok) return { status: "refused", reason: t("download of install.sh failed (HTTP {0})", res.status) };
    body = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { status: "refused", reason: t("download of install.sh failed ({0})", String(e)) };
  }
  try {
    const sha = await http(`${base}.sha256`);
    if (!sha.ok) return { status: "refused", reason: t("no install.sh.sha256 in the release (HTTP {0}): cannot verify", sha.status) };
    const expected = (await sha.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const actual = createHash("sha256").update(body).digest("hex");
    if (!/^[0-9a-f]{64}$/.test(expected) || expected !== actual) {
      return { status: "refused", reason: t("wrong sha256 checksum for install.sh (expected {0}…, received {1}…)", expected.slice(0, 12), actual.slice(0, 12)) };
    }
  } catch (e) {
    return { status: "refused", reason: t("install.sh.sha256 not found ({0}): cannot verify", String(e)) };
  }
  const dir = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "nokker-update-"));
  const path = join(dir, "install.sh");
  writeFileSync(path, body, { mode: 0o600 });
  const cosign = await run("cosign", ["version"], { timeoutMs: 10_000 });
  if (cosign.error === "ENOENT" || cosign.code !== 0) return { status: "ok", path, dir, signed: false };
  try {
    const b = await http(`${base}.sigstore.json`);
    if (!b.ok) throw new Error(t("sigstore bundle missing (HTTP {0})", b.status));
    const bundlePath = join(dir, "install.sh.sigstore.json");
    writeFileSync(bundlePath, Buffer.from(await b.arrayBuffer()), { mode: 0o600 });
    const v = await run("cosign", cosignVerifyArgs(bundlePath, path), { timeoutMs: 60_000 });
    if (v.code !== 0) throw new Error(firstLine(v.stderr) || t("invalid signature"));
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return { status: "refused", reason: t("cosign verification of install.sh failed ({0})", e instanceof Error ? e.message : String(e)) };
  }
  return { status: "ok", path, dir, signed: true };
}

/** Commande qui lance l'installeur téléchargé. Sous WSL il est sur le disque Windows : `wslpath -u` le traduit. */
export function installerCommand(cfg: LokkalConfig, path: string, version: string): { cmd: string; args: string[] } {
  const tail = ["--update", "--version", version, ...(cfg.install_dir ? ["--dir", cfg.install_dir] : [])];
  if (cfg.wsl_distro) return hostCommand(cfg, "sh", ["-c", 'p=$(wslpath -u "$1") && shift && exec sh "$p" "$@"', "sh", path, ...tail]);
  return { cmd: "sh", args: [path, ...tail] };
}

/** Remplace le binaire autonome par celui de la release (sha256 obligatoire + cosign si présent ; rename atomique). */
export async function replaceSelf(opts: UpdateOptions, version: string): Promise<boolean> {
  const out = opts.out ?? ((s) => process.stdout.write(s));
  const err = opts.err ?? ((s) => process.stderr.write(s));
  const platform = opts.platform ?? currentPlatform();
  const self = opts.selfPath !== undefined ? opts.selfPath : /^nokker(-|\.|$)/.test(basename(process.execPath)) ? process.execPath : null;
  const asset = assetName(platform);
  const tag = RELEASE_TAG_PREFIX + version;
  if (!self) {
    out(`${t("This client is not the standalone binary (npm or sources): get {0} from release {1}.", asset, tag)}\n`);
    return true;
  }
  const http = httpOf(opts);
  const base = `https://github.com/${RELEASES_REPO}/releases/download/${RELEASE_TAG_PREFIX}${version}/${asset}`;
  let buf: Buffer;
  try {
    const res = await http(base);
    if (!res.ok) {
      err(`${t("Binary {0} not found in release {1} (HTTP {2}): client unchanged.", asset, tag, res.status)}\n`);
      return false;
    }
    buf = Buffer.from(await res.arrayBuffer());
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared && declared !== buf.length) {
      err(`${t("Download truncated ({0} of {1} bytes): client unchanged.", buf.length, declared)}\n`);
      return false;
    }
  } catch (e) {
    err(`${t("Could not download the binary ({0}): client unchanged.", String(e))}\n`);
    return false;
  }
  // sha256 OBLIGATOIRE (sortie de `sha256sum` : « <hex>  <fichier> »), publié à côté du binaire.
  try {
    const sha = await http(`${base}.sha256`);
    if (!sha.ok) {
      err(`${t("No {0}.sha256 in the release (HTTP {1}): cannot verify, client unchanged.", asset, sha.status)}\n`);
      return false;
    }
    const expected = (await sha.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const actual = createHash("sha256").update(buf).digest("hex");
    if (!/^[0-9a-f]{64}$/.test(expected) || expected !== actual) {
      err(`${t("Wrong sha256 checksum (expected {0}…, received {1}…): client unchanged.", expected.slice(0, 12), actual.slice(0, 12))}\n`);
      return false;
    }
  } catch (e) {
    err(`${t("sha256 checksum not found ({0}): cannot verify, client unchanged.", String(e))}\n`);
    return false;
  }
  if (buf.length < 1_000_000) {
    err(`${t("Downloaded binary too small to be valid: client unchanged.")}\n`);
    return false;
  }
  const next = `${self}.new`;
  writeFileSync(next, buf, { mode: 0o755 });
  // Signature sigstore : vérifiée en plus si `cosign` est présent sur la machine (échec = pas de remplacement).
  const run = opts.run ?? realRun;
  const cosign = await run("cosign", ["version"], { timeoutMs: 10_000 });
  let signed = false;
  if (cosign.error !== "ENOENT" && cosign.code === 0) {
    const bundlePath = `${next}.sigstore.json`;
    try {
      const b = await http(`${base}.sigstore.json`);
      if (!b.ok) throw new Error(t("sigstore bundle missing (HTTP {0})", b.status));
      writeFileSync(bundlePath, Buffer.from(await b.arrayBuffer()));
      const v = await run("cosign", cosignVerifyArgs(bundlePath, next), { timeoutMs: 60_000 });
      if (v.code !== 0) throw new Error(firstLine(v.stderr) || t("invalid signature"));
      signed = true;
    } catch (e) {
      rmSync(next, { force: true });
      err(`${t("cosign verification failed ({0}): client unchanged.", e instanceof Error ? e.message : String(e))}\n`);
      return false;
    } finally {
      rmSync(bundlePath, { force: true });
    }
  }
  if (platform.os === "windows") {
    out(`${t("Windows cannot replace a running executable: {0} is ready. Close nokker then rename it to {1}.", next, basename(self))}\n`);
    return true;
  }
  chmodSync(next, 0o755);
  renameSync(next, self); // atomique ; un binaire en cours d'exécution reste valide sous Linux/macOS
  out(`${t("Client replaced: {0} (release {1}{2}).", self, tag, signed ? t(", sha256 + cosign verified") : t(", sha256 verified"))}\n`);
  return true;
}

export async function runUpdate(opts: UpdateOptions): Promise<number> {
  const out = opts.out ?? ((s) => process.stdout.write(s));
  const err = opts.err ?? ((s) => process.stderr.write(s));
  const run = opts.run ?? realRun;
  const http = httpOf(opts);

  const lokkal = readLokkal();
  const problem = lokkalProblem(lokkal);
  const before = await health(opts);
  const hint = clientHint(before);
  if (problem || lokkal.status !== "ok") {
    err(`${t("Cannot update the kernel: {0}.", String(problem))}\n`);
    if (hint) out(`${hint}\n`);
    return 1;
  }
  const cfg = lokkal.config;
  const latest = opts.check || !opts.version ? await latestRelease(http) : null;

  if (opts.check) {
    out(`${t("Installed: {0}", cfg.version)}\n`);
    if (!latest) {
      out(`${t("Latest release: unknown (GitHub unreachable — no network?)")}\n`);
    } else {
      const cmp = compareSemver(cfg.version, latest.version);
      out(`${t("Latest release: {0}", latest.version)}\n`);
      out(cmp < 0 ? `${t("↑ update available: nokker update")}\n` : `${t("✓ up to date.")}\n`);
      if (compareSemver(CLI_VERSION, latest.version) < 0) out(`${t("Client: {0} (nokker update replaces it with {1}).", CLI_VERSION, latest.version)}\n`);
    }
    if (hint) out(`${hint}\n`);
    return 0;
  }

  if (opts.version && !VERSION_RE.test(opts.version)) {
    err(`${t("--version expects a version like 1.2.3 (got {0}).", opts.version)}\n`);
    return 2;
  }
  if (!opts.version && !latest) {
    err(`${t("Cannot reach GitHub to find the latest release (network?): nothing was changed.")}\n`);
    return 1;
  }
  const target = opts.version ?? (latest as Release).version;
  const dk = hostCommand(cfg, "docker", ["info", "--format", "{{.ServerVersion}}"]);
  const info = await run(dk.cmd, dk.args, { timeoutMs: 15_000 });
  if (info.error === "ENOENT" || info.code !== 0) {
    err(
      info.error === "ENOENT"
        ? `${t("docker is not installed (or not in PATH): the kernel cannot be updated from here.")}\n`
        : `${t("The docker daemon does not respond ({0}).", firstLine(info.stderr) || t("no response"))}\n`,
    );
    if (hint) out(`${hint}\n`);
    return 1;
  }

  const cmp = compareSemver(cfg.version, target);
  if (cmp > 0 && opts.version) {
    err(`${t("Kernel {0} is newer than {1}: downgrades are not supported (migrations only go forward).", cfg.version, target)}\n`);
    return 1;
  }
  if (cmp >= 0) {
    out(`${t("Kernel already up to date ({0}).", cfg.version)}\n`);
  } else {
    const inst = await fetchInstaller(opts, target);
    if (inst.status === "refused") {
      err(`${t("Update refused: {0}. Nothing was run.", inst.reason)}\n`);
      return 1;
    }
    if (inst.status === "ok") {
      out(
        inst.signed
          ? `${t("install.sh {0}: sha256 and cosign signature verified.", target)}\n`
          : `${t("install.sh {0}: sha256 verified; signature NOT verified (cosign is not installed).", target)}\n`,
      );
      out(`${t("Updating through {0} --update…", inst.path)}\n`);
      const h = installerCommand(cfg, inst.path, target);
      try {
        const r = await run(h.cmd, h.args, { inherit: true, timeoutMs: 1_800_000 });
        if (r.code !== 0) {
          err(`${t("install.sh --update failed.")}\n`);
          return 1;
        }
      } finally {
        rmSync(inst.dir, { recursive: true, force: true });
      }
    } else {
      out(`${t("Release {0} publishes no install.sh: updating through the compose file.", target)}\n`);
      const set = await setEnvVersion(cfg, target, run);
      if (!set) {
        err(`${t("Cannot write NOKKER_VERSION to {0}.", cfg.env_file)}\n`);
        return 1;
      }
      out(`${t("NOKKER_VERSION={0} written to {1}. Downloading images…", target, cfg.env_file)}\n`);
      const pullC = hostCommand(cfg, "docker", [...composeArgs(cfg), "pull"]);
      const pull = await run(pullC.cmd, pullC.args, { inherit: true, timeoutMs: 1_800_000 });
      if (pull.code !== 0) {
        err(`${t("docker compose pull failed (network, registry or permissions).")}\n`);
        return 1;
      }
      out(`${t("Restarting the kernel…")}\n`);
      const upC = hostCommand(cfg, "docker", [...composeArgs(cfg), "up", "-d"]);
      const up = await run(upC.cmd, upC.args, { inherit: true, timeoutMs: 600_000 });
      if (up.code !== 0) {
        err(`${t("docker compose up -d failed.")}\n`);
        return 1;
      }
      setLokkalVersion(target);
    }
    let after: Healthz | null = null;
    for (let i = 0; i < 30 && !after; i++) {
      after = await health(opts);
      if (!after) await new Promise((r) => setTimeout(r, opts.healthWaitMs ?? 2000));
    }
    if (!after) {
      err(`${t("The kernel does not respond on /healthz yet after the update — check with nokker doctor.")}\n`);
      return 1;
    }
    out(`${t("Kernel: version {0} → {1}", cfg.version, target)}\n`);
  }

  if (compareSemver(CLI_VERSION, target) < 0) {
    return (await replaceSelf(opts, target)) ? 0 : 1;
  }
  return 0;
}
