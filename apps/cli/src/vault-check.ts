/**
 * Contrôle « coffre » de `nokker doctor` (lot X4, profil `vault` du compose Lokkal). Présent SEULEMENT si le `.env`
 * de l'installation dit `NOKKER_SECRETS_PROVIDER=openbao` ; sinon aucun contrôle (doctor reste à 7 lignes).
 * Ne lit ni n'affiche JAMAIS une valeur du coffre : du `.env`, seules deux clés non secrètes sont retenues ; des
 * fichiers AppRole, seules la présence et la taille.
 */
import { readFileSync, statSync } from "node:fs";
import { t } from "./i18n/index.js";
import { composeArgs, hostCommand, type LokkalConfig } from "./lokkal.js";
import type { Runner } from "./proc.js";

export interface VaultCheck {
  /** Nom de la ligne (traduit : « coffre » en français). */
  name: string;
  status: "ok" | "ko";
  detail: string;
}

const WANTED = /^(NOKKER_SECRETS_PROVIDER|NOKKER_VAULT_UNSEAL)=(.*)$/;

/** Les deux réglages du coffre, et rien d'autre du `.env` (qui porte aussi des secrets). */
export function vaultSettings(envText: string): { provider?: string; unseal?: string } {
  const out: { provider?: string; unseal?: string } = {};
  for (const line of envText.split(/\r?\n/)) {
    const m = WANTED.exec(line.trim());
    if (!m) continue;
    const v = m[2]!.trim().replace(/^["']|["']$/g, "");
    if (m[1] === "NOKKER_SECRETS_PROVIDER") out.provider = v;
    else out.unseal = v;
  }
  return out;
}

async function readSettings(c: LokkalConfig, run: Runner): Promise<{ provider?: string; unseal?: string } | null> {
  if (c.wsl_distro) {
    // Sous WSL, le .env est un chemin Linux : grep n'en ramène que les deux clés voulues.
    const g = hostCommand(c, "grep", ["-E", "^(NOKKER_SECRETS_PROVIDER|NOKKER_VAULT_UNSEAL)=", c.env_file]);
    const r = await run(g.cmd, g.args, { timeoutMs: 10_000 });
    return r.code === 0 || r.code === 1 ? vaultSettings(r.stdout) : null;
  }
  try {
    return vaultSettings(readFileSync(c.env_file, "utf8"));
  } catch {
    return null;
  }
}

async function nonEmpty(c: LokkalConfig, path: string, run: Runner): Promise<boolean> {
  if (c.wsl_distro) {
    const probe = hostCommand(c, "test", ["-s", path]);
    return (await run(probe.cmd, probe.args, { timeoutMs: 10_000 })).code === 0;
  }
  try {
    const s = statSync(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/** `null` : pas de coffre OpenBao dans cette installation, donc pas de ligne. */
export async function checkVault(c: LokkalConfig, run: Runner): Promise<VaultCheck | null> {
  const settings = await readSettings(c, run);
  if (!settings || settings.provider !== "openbao") return null;
  const name = t("vault");
  const ko = (detail: string): VaultCheck => ({ name, status: "ko", detail });

  const args = [...composeArgs(c)];
  args.splice(3, 0, "--env-file", c.env_file); // compose -p <projet> --env-file <env> -f <compose>
  const st = hostCommand(c, "docker", [...args, "exec", "-T", "openbao", "bao", "status", "-format=json"]);
  const r = await run(st.cmd, st.args, { timeoutMs: 20_000 });
  let status: { initialized?: boolean; sealed?: boolean } | null = null;
  try {
    status = JSON.parse(r.stdout) as { initialized?: boolean; sealed?: boolean };
  } catch {
    status = null;
  }
  const p = c.project;
  if (!status) return ko(t("OpenBao does not respond (docker compose -p {0} ps openbao)", p));
  if (status.initialized !== true) return ko(t("OpenBao is not initialised (rerun install.sh with the vault profile)"));
  if (status.sealed !== false) {
    return ko(
      settings.unseal === "manual"
        ? t("vault sealed: docker compose -p {0} exec openbao bao operator unseal", p)
        : t("vault-unseal does not unseal: docker compose -p {0} logs vault-unseal", p),
    );
  }
  if (!c.install_dir) return ko(t("install_dir is missing from lokkal.json: AppRole credentials not found"));
  const dir = `${c.install_dir.replace(/\/+$/, "")}/vault/approle`;
  const missing: string[] = [];
  for (const f of ["role_id", "secret_id"]) if (!(await nonEmpty(c, `${dir}/${f}`, run))) missing.push(f);
  if (missing.length) return ko(t("AppRole credentials missing or empty: {0} (in {1})", missing.join(", "), dir));
  return { name, status: "ok", detail: t("OpenBao initialised and unsealed, AppRole credentials in place") };
}
