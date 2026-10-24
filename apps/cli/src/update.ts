/**
 * `nokker update [--check]` (contrat emballage) :
 *  - `--check` compare la `version` de lokkal.json à la dernière release GitHub `lokkal-v*` de `nokker-ai/nokker`
 *    (API publique, sans jeton ; l'absence de réseau est tolérée) ;
 *  - sinon : `install.sh --update` s'il est à côté du compose (ou `~/.nokker/install.sh`), à défaut réécrit
 *    `NOKKER_VERSION=<cible>` dans `env_file` puis `docker compose -p <project> -f <compose> pull && up -d`,
 *    attend `/healthz`, et finit par remplacer le binaire `nokker` par celui de la même release.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { NokkerClient, type Healthz } from "@nokker-apps/sdk";
import { BRAND } from "@nokker-apps/brand";
import { lokkalProblem, readLokkal, composeArgs, hostCommand, type LokkalConfig } from "./lokkal.js";
import { lokkalFilePath } from "./config.js";
import { firstLine, run as realRun, type Runner } from "./proc.js";
import { CLI_VERSION, compareVersions } from "./version.js";

export const RELEASES_REPO = "nokker-ai/nokker";
export const RELEASE_TAG_PREFIX = "lokkal-v";

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
  /** Test : dossier de `~/.nokker`. */
  nokkerHome?: string;
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

/** Dernière release `lokkal-v*` publiée (ni brouillon ni préversion), `null` si GitHub est injoignable. */
export async function latestRelease(http: HttpFetch): Promise<Release | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await http(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=30`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": BRAND.userAgent },
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const list = (await res.json()) as Array<{ tag_name?: string; draft?: boolean; prerelease?: boolean }>;
    const hit = list.find((r) => r.tag_name?.startsWith(RELEASE_TAG_PREFIX) && !r.draft && !r.prerelease);
    return hit?.tag_name ? { tag: hit.tag_name, version: hit.tag_name.slice(RELEASE_TAG_PREFIX.length) } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function clientHint(h: Healthz | null): string | null {
  const min = h?.min_client_version;
  if (min && compareVersions(CLI_VERSION, min) < 0) {
    return `Le serveur demande un client ≥ ${min} (le tien : ${CLI_VERSION}) — nokker update remplace le binaire par celui de la dernière release.`;
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

/** `<install_dir>/install.sh` d'abord (toujours écrit par install.sh), puis à côté du compose, puis `~/.nokker/install.sh`.
 * Sous WSL, install_dir est un chemin Linux : présumé présent. */
function findInstaller(cfg: LokkalConfig, home: string): string | null {
  if (cfg.wsl_distro) return `${cfg.install_dir}/install.sh`;
  const candidates = [...(cfg.install_dir ? [join(cfg.install_dir, "install.sh")] : []), join(dirname(cfg.compose), "install.sh"), join(home, "install.sh")];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Remplace le binaire autonome par celui de la release (sha256 obligatoire + cosign si présent ; rename atomique). */
export async function replaceSelf(opts: UpdateOptions, version: string): Promise<boolean> {
  const out = opts.out ?? ((t) => process.stdout.write(t));
  const err = opts.err ?? ((t) => process.stderr.write(t));
  const platform = opts.platform ?? currentPlatform();
  const self = opts.selfPath !== undefined ? opts.selfPath : /^nokker(-|\.|$)/.test(basename(process.execPath)) ? process.execPath : null;
  const asset = assetName(platform);
  if (!self) {
    out(`Ce client n'est pas le binaire autonome (npm ou sources) : récupère ${asset} dans la release ${RELEASE_TAG_PREFIX}${version}.\n`);
    return true;
  }
  const http = httpOf(opts);
  const base = `https://github.com/${RELEASES_REPO}/releases/download/${RELEASE_TAG_PREFIX}${version}/${asset}`;
  let buf: Buffer;
  try {
    const res = await http(base);
    if (!res.ok) {
      err(`Binaire ${asset} introuvable dans la release ${RELEASE_TAG_PREFIX}${version} (HTTP ${res.status}) : client inchangé.\n`);
      return false;
    }
    buf = Buffer.from(await res.arrayBuffer());
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared && declared !== buf.length) {
      err(`Téléchargement tronqué (${buf.length} sur ${declared} octets) : client inchangé.\n`);
      return false;
    }
  } catch (e) {
    err(`Téléchargement du binaire impossible (${String(e)}) : client inchangé.\n`);
    return false;
  }
  // sha256 OBLIGATOIRE (sortie de `sha256sum` : « <hex>  <fichier> »), publié à côté du binaire.
  try {
    const sha = await http(`${base}.sha256`);
    if (!sha.ok) {
      err(`Pas de ${asset}.sha256 dans la release (HTTP ${sha.status}) : vérification impossible, client inchangé.\n`);
      return false;
    }
    const expected = (await sha.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const actual = createHash("sha256").update(buf).digest("hex");
    if (!/^[0-9a-f]{64}$/.test(expected) || expected !== actual) {
      err(`Somme sha256 incorrecte (attendue ${expected.slice(0, 12)}…, reçue ${actual.slice(0, 12)}…) : client inchangé.\n`);
      return false;
    }
  } catch (e) {
    err(`Somme sha256 introuvable (${String(e)}) : vérification impossible, client inchangé.\n`);
    return false;
  }
  if (buf.length < 1_000_000) {
    err("Binaire téléchargé trop petit pour être valide : client inchangé.\n");
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
      if (!b.ok) throw new Error(`bundle sigstore absent (HTTP ${b.status})`);
      writeFileSync(bundlePath, Buffer.from(await b.arrayBuffer()));
      const v = await run(
        "cosign",
        ["verify-blob", "--bundle", bundlePath, "--certificate-identity-regexp", `^https://github\\.com/${RELEASES_REPO.replace(/\./g, "\\.")}/\\.github/workflows/lokkal-images\\.yml@refs/tags/lokkal-v`, "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com", next],
        { timeoutMs: 60_000 },
      );
      if (v.code !== 0) throw new Error(firstLine(v.stderr) || "signature invalide");
      signed = true;
    } catch (e) {
      rmSync(next, { force: true });
      err(`Vérification cosign échouée (${e instanceof Error ? e.message : String(e)}) : client inchangé.\n`);
      return false;
    } finally {
      rmSync(bundlePath, { force: true });
    }
  }
  if (platform.os === "windows") {
    out(`Windows ne remplace pas un exécutable en cours : ${next} est prêt. Ferme nokker puis renomme-le en ${basename(self)}.\n`);
    return true;
  }
  chmodSync(next, 0o755);
  renameSync(next, self); // atomique ; un binaire en cours d'exécution reste valide sous Linux/macOS
  out(`Client remplacé : ${self} (release ${RELEASE_TAG_PREFIX}${version}${signed ? ", sha256 + cosign vérifiés" : ", sha256 vérifié"}).\n`);
  return true;
}

export async function runUpdate(opts: UpdateOptions): Promise<number> {
  const out = opts.out ?? ((t) => process.stdout.write(t));
  const err = opts.err ?? ((t) => process.stderr.write(t));
  const run = opts.run ?? realRun;
  const http = httpOf(opts);

  const lokkal = readLokkal();
  const problem = lokkalProblem(lokkal);
  const before = await health(opts);
  const hint = clientHint(before);
  if (problem || lokkal.status !== "ok") {
    err(`Mise à jour du noyau impossible : ${problem}.\n`);
    if (hint) out(`${hint}\n`);
    return 1;
  }
  const cfg = lokkal.config;
  const latest = await latestRelease(http);

  if (opts.check) {
    out(`Installé : ${cfg.version}\n`);
    if (!latest) {
      out("Dernière release : inconnue (GitHub injoignable — pas de réseau ?)\n");
    } else {
      const cmp = compareVersions(cfg.version, latest.version);
      out(`Dernière release : ${latest.version}\n`);
      out(cmp < 0 ? `↑ mise à jour disponible : nokker update\n` : "✓ à jour.\n");
      if (compareVersions(CLI_VERSION, latest.version) < 0) out(`Client : ${CLI_VERSION} (nokker update le remplace par ${latest.version}).\n`);
    }
    if (hint) out(`${hint}\n`);
    return 0;
  }

  if (!latest) {
    err("Impossible de joindre GitHub pour connaître la dernière release (réseau ?) : rien n'a été modifié.\n");
    return 1;
  }
  const target = latest.version;
  const dk = hostCommand(cfg, "docker", ["info", "--format", "{{.ServerVersion}}"]);
  const info = await run(dk.cmd, dk.args, { timeoutMs: 15_000 });
  if (info.error === "ENOENT" || info.code !== 0) {
    err(
      info.error === "ENOENT"
        ? "docker n'est pas installé (ou pas dans le PATH) : le noyau ne peut pas être mis à jour d'ici.\n"
        : `Le démon docker ne répond pas (${firstLine(info.stderr) || "pas de réponse"}).\n`,
    );
    if (hint) out(`${hint}\n`);
    return 1;
  }

  if (compareVersions(cfg.version, target) >= 0) {
    out(`Noyau déjà à jour (${cfg.version}).\n`);
  } else {
    const home = opts.nokkerHome ?? join(homedir(), ".nokker");
    const installer = findInstaller(cfg, home);
    if (installer) {
      out(`Mise à jour par ${installer} --update…\n`);
      // Sous WSL : `wsl.exe -d <distro> -- sh <install_dir>/install.sh --update` ; ailleurs `bash <install.sh> --update`.
      const h = hostCommand(cfg, cfg.wsl_distro ? "sh" : "bash", [installer, "--update"]);
      const r = await run(h.cmd, h.args, { inherit: true, timeoutMs: 1_800_000, env: { NOKKER_VERSION: target } });
      if (r.code !== 0) {
        err("install.sh --update a échoué.\n");
        return 1;
      }
    } else {
      const set = await setEnvVersion(cfg, target, run);
      if (!set) {
        err(`Impossible d'écrire NOKKER_VERSION dans ${cfg.env_file}.\n`);
        return 1;
      }
      out(`NOKKER_VERSION=${target} écrit dans ${cfg.env_file}. Téléchargement des images…\n`);
      const pullC = hostCommand(cfg, "docker", [...composeArgs(cfg), "pull"]);
      const pull = await run(pullC.cmd, pullC.args, { inherit: true, timeoutMs: 1_800_000 });
      if (pull.code !== 0) {
        err("docker compose pull a échoué (réseau, registre ou droits).\n");
        return 1;
      }
      out("Redémarrage du noyau…\n");
      const upC = hostCommand(cfg, "docker", [...composeArgs(cfg), "up", "-d"]);
      const up = await run(upC.cmd, upC.args, { inherit: true, timeoutMs: 600_000 });
      if (up.code !== 0) {
        err("docker compose up -d a échoué.\n");
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
      err("Le noyau ne répond pas encore sur /healthz après la mise à jour — vérifie avec nokker doctor.\n");
      return 1;
    }
    out(`Noyau : version ${cfg.version} → ${target}\n`);
  }

  if (compareVersions(CLI_VERSION, target) < 0) {
    return (await replaceSelf(opts, target)) ? 0 : 1;
  }
  return 0;
}
