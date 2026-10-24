/**
 * Contrôle « coffre » de `nokker doctor` (lot X4, profil `vault` du compose Lokkal). Présent SEULEMENT si le `.env`
 * de l'installation dit `NOKKER_SECRETS_PROVIDER=openbao` ; sinon aucun contrôle (doctor reste à 7 lignes).
 * Ne lit ni n'affiche JAMAIS une valeur du coffre : du `.env`, seules deux clés non secrètes sont retenues ; des
 * fichiers AppRole, seules la présence et la taille.
 */
import { readFileSync, statSync } from "node:fs";
import { composeArgs, hostCommand, type LokkalConfig } from "./lokkal.js";
import type { Runner } from "./proc.js";

export interface VaultCheck {
  name: "coffre";
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
    const t = hostCommand(c, "test", ["-s", path]);
    return (await run(t.cmd, t.args, { timeoutMs: 10_000 })).code === 0;
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
  const ko = (detail: string): VaultCheck => ({ name: "coffre", status: "ko", detail });

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
  if (!status) return ko(`OpenBao ne répond pas (docker compose -p ${p} ps openbao)`);
  if (status.initialized !== true) return ko("OpenBao n'est pas initialisé (relance install.sh avec le profil vault)");
  if (status.sealed !== false) {
    return ko(
      settings.unseal === "manual"
        ? `coffre scellé : docker compose -p ${p} exec openbao bao operator unseal`
        : `vault-unseal ne descelle pas : docker compose -p ${p} logs vault-unseal`,
    );
  }
  if (!c.install_dir) return ko("install_dir absent de lokkal.json : identifiants AppRole introuvables");
  const dir = `${c.install_dir.replace(/\/+$/, "")}/vault/approle`;
  const missing: string[] = [];
  for (const f of ["role_id", "secret_id"]) if (!(await nonEmpty(c, `${dir}/${f}`, run))) missing.push(f);
  if (missing.length) return ko(`identifiants AppRole absents ou vides : ${missing.join(", ")} (dans ${dir})`);
  return { name: "coffre", status: "ok", detail: "OpenBao initialisé et descellé, identifiants AppRole en place" };
}
