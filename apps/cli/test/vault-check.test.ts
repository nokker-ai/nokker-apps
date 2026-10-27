import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LokkalConfig } from "../src/lokkal.js";
import type { Runner } from "../src/proc.js";
import { checkVault, vaultSettings } from "../src/vault-check.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-vault-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const cfg = (over: Partial<LokkalConfig> = {}): LokkalConfig => ({
  compose: join(dir, "docker-compose.yml"),
  project: "nokker",
  version: "0.1.0",
  core_service: "core",
  api_url: "http://127.0.0.1:8742",
  web_url: "http://127.0.0.1:7420",
  token_path: join(dir, "local-token"),
  env_file: join(dir, ".env"),
  install_dir: dir,
  ...over,
});
const bao = (status: object | null, calls: string[][] = []): Runner => async (cmd, args) => {
  calls.push([cmd, ...args]);
  return { code: status ? 0 : 1, stdout: status ? JSON.stringify(status) : "", stderr: "" };
};
const SECRET = "valeur-secrete-qui-ne-doit-jamais-sortir";

describe("doctor : coffre (X4)", () => {
  it("ne retient du .env que les deux réglages", () => {
    expect(vaultSettings(`NOKKER_LOCAL_SECRET_KEY=${SECRET}\nNOKKER_SECRETS_PROVIDER="openbao"\nNOKKER_VAULT_UNSEAL=manual\n`)).toEqual({ provider: "openbao", unseal: "manual" });
  });

  it("sans OpenBao : aucune ligne (pas « skip »)", async () => {
    await writeFile(join(dir, ".env"), "NOKKER_SECRETS_PROVIDER=file\n");
    expect(await checkVault(cfg(), bao({ initialized: true, sealed: false }))).toBeNull();
    await writeFile(join(dir, ".env"), "FOO=1\n");
    expect(await checkVault(cfg(), bao({ initialized: true, sealed: false }))).toBeNull();
  });

  it("descellé + AppRole en place : ok ; la commande porte --env-file", async () => {
    await writeFile(join(dir, ".env"), `NOKKER_SECRETS_PROVIDER=openbao\nNOKKER_LOCAL_SECRET_KEY=${SECRET}\n`);
    await mkdir(join(dir, "vault", "approle"), { recursive: true });
    await writeFile(join(dir, "vault", "approle", "role_id"), SECRET);
    await writeFile(join(dir, "vault", "approle", "secret_id"), SECRET);
    const calls: string[][] = [];
    const r = await checkVault(cfg(), bao({ initialized: true, sealed: false }, calls));
    expect(r).toMatchObject({ name: "vault", status: "ok" });
    expect(calls[0]!.join(" ")).toBe(`docker compose -p nokker --env-file ${join(dir, ".env")} -f ${join(dir, "docker-compose.yml")} exec -T openbao bao status -format=json`);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("scellé : la bonne commande selon le mode ; AppRole vide : nommé, jamais lu", async () => {
    await writeFile(join(dir, ".env"), "NOKKER_SECRETS_PROVIDER=openbao\nNOKKER_VAULT_UNSEAL=manual\n");
    expect((await checkVault(cfg(), bao({ initialized: true, sealed: true })))!.detail).toBe("vault sealed: docker compose -p nokker exec openbao bao operator unseal");
    await writeFile(join(dir, ".env"), "NOKKER_SECRETS_PROVIDER=openbao\n");
    expect((await checkVault(cfg(), bao({ initialized: true, sealed: true })))!.detail).toBe("vault-unseal does not unseal: docker compose -p nokker logs vault-unseal");
    expect((await checkVault(cfg(), bao(null)))!.status).toBe("ko");
    await writeFile(join(dir, "vault", "approle", "secret_id"), "");
    const r = await checkVault(cfg(), bao({ initialized: true, sealed: false }));
    expect(r).toMatchObject({ status: "ko", detail: expect.stringContaining("secret_id") });
    expect(r!.detail).not.toContain("role_id,");
  });

  it("WSL : tout passe par wsl.exe -d <distro> (grep des deux clés, test -s)", async () => {
    const calls: string[][] = [];
    const run: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      const line = args.join(" ");
      if (line.includes("grep")) return { code: 0, stdout: "NOKKER_SECRETS_PROVIDER=openbao\n", stderr: "" };
      if (line.includes("bao status")) return { code: 0, stdout: JSON.stringify({ initialized: true, sealed: false }), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const c = cfg({ wsl_distro: "Ubuntu", compose: "/home/u/.nokker/docker-compose.yml", env_file: "/home/u/.nokker/.env", install_dir: "/home/u/.nokker" });
    expect(await checkVault(c, run)).toMatchObject({ status: "ok" });
    expect(calls.every((x) => x[0] === "wsl.exe" && x[1] === "-d" && x[2] === "Ubuntu")).toBe(true);
    expect(calls.map((x) => x.slice(4).join(" "))).toContain("test -s /home/u/.nokker/vault/approle/secret_id");
  });
});
