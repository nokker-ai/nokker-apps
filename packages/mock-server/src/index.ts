import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { createMockHttpServer } from "./server.js";
import { MockState } from "./state.js";

export { MOCK_TOTP_CODE } from "./server.js";
export { accountMock } from "./account.js";
export { linkMock } from "./link.js";
export { MockState, MOCK_USER, KNOWN_USERS, LOCAL_OWNER } from "./state.js";
export { isHardline } from "./local.js";
export { costBook, MOCK_COST_MODEL, MOCK_PREFIX_TOKENS, MOCK_PRICES } from "./cost.js";
export { localMock, LOCAL_TOKEN } from "./local-setup.js";
export { seedDemo, sessionMessage, type DemoIds } from "./demo.js";
import { seedDemo, type DemoIds } from "./demo.js";

export interface MockServerHandle {
  url: string;
  port: number;
  state: MockState;
  /** Identifiants des fils de démo (absent si `seed: false`). */
  demo: DemoIds | null;
  /** Jeton local écrit dans `<configDir>/local-token` (absent si aucun `configDir`). */
  localToken: string | null;
  /** Où le jeton a été écrit. */
  localTokenPath: string | null;
  configDir: string | null;
  close(): Promise<void>;
}

/** Dossier de config du mock : `NOKKER_CONFIG_DIR_OVERRIDE`, sinon `NOKKER_CONFIG_DIR`, sinon `~/.config/nokker`. */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.NOKKER_CONFIG_DIR_OVERRIDE || env.NOKKER_CONFIG_DIR || join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "nokker");
}

/** Démarre le mock-server. `port: 0` (par défaut) laisse l'OS choisir un port libre — c'est ce
 * qu'utilisent les tests pour ne jamais entrer en conflit avec un service déjà lié sur la
 * machine (machine hôte : toujours vérifier `ss -ltnp` avant d'ouvrir un port fixe en dev manuel). */
export async function startMockServer(
  opts: {
    port?: number;
    seed?: boolean;
    speed?: number;
    /** Dossier où écrire `local-token` et lire/écrire `settings.json`. Par défaut : `NOKKER_CONFIG_DIR_OVERRIDE`
     * si défini, sinon rien (les tests ne touchent jamais au vrai `$HOME`) ; `run.ts` passe `defaultConfigDir()`. */
    configDir?: string | null;
    /** Racines des sessions locales ; défaut `MOCK_LOCAL_ROOTS` (séparateur `:`), sinon tout accepter. */
    localRoots?: string[] | null;
    minClientVersion?: string | null;
    devicePending?: boolean;
    /** Cartes locales : `inline` (défaut) ou `kernel` (comme le noyau, voir `MockStateOptions.approvalStyle`). */
    approvalStyle?: "inline" | "kernel";
    /** Drapeau `sso` (LOKKAL §7.24) ; défaut `MOCK_SSO=1`, sinon éteint. */
    sso?: boolean;
    /** Drapeau `packs_web` (LOKKAL §7.30) ; défaut `MOCK_PACKS_WEB=1`, sinon éteint. */
    packsWeb?: boolean;
    /** Écritures réelles du scénario local et points de retour photographiés (voir `MockStateOptions.localWrites`) ;
     * défaut : `MOCK_LOCAL_WRITES=1`. */
    localWrites?: boolean;
    /** Drapeau `local.project_memory` (défaut : allumé ; `MOCK_PROJECT_MEMORY=0` l'éteint). */
    projectMemory?: boolean;
    /** Drapeau `local.project_skills` (défaut : éteint ; `MOCK_PROJECT_SKILLS=1` l'allume). */
    projectSkills?: boolean;
    /** Foyer (X23) : `MOCK_HOUSEHOLD=payer|member|minor|none` (défaut `off` : 404 comme le noyau sans drapeau). */
    household?: "off" | "payer" | "member" | "minor" | "none";
  } = {},
): Promise<MockServerHandle> {
  const configDir = opts.configDir !== undefined ? opts.configDir : process.env.NOKKER_CONFIG_DIR_OVERRIDE || null;
  const envRoots = process.env.MOCK_LOCAL_ROOTS ? process.env.MOCK_LOCAL_ROOTS.split(delimiter).filter(Boolean) : null;
  const state = new MockState({
    speed: opts.speed ?? 1,
    configDir,
    localRoots: opts.localRoots !== undefined ? opts.localRoots : envRoots,
    minClientVersion: opts.minClientVersion ?? process.env.MOCK_MIN_CLIENT_VERSION ?? null,
    devicePending: opts.devicePending ?? process.env.MOCK_DEVICE_PENDING === "1",
    sso: opts.sso ?? process.env.MOCK_SSO === "1",
    packsWeb: opts.packsWeb ?? process.env.MOCK_PACKS_WEB === "1",
    ...(opts.approvalStyle ? { approvalStyle: opts.approvalStyle } : {}),
    localWrites: opts.localWrites ?? process.env.MOCK_LOCAL_WRITES === "1",
    projectMemory: opts.projectMemory ?? process.env.MOCK_PROJECT_MEMORY !== "0",
    projectSkills: opts.projectSkills ?? process.env.MOCK_PROJECT_SKILLS === "1",
    household: opts.household ?? (["payer", "member", "minor", "none"].includes(process.env.MOCK_HOUSEHOLD ?? "") ? (process.env.MOCK_HOUSEHOLD as "payer" | "member" | "minor" | "none") : "off"),
  });
  if (configDir) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    state.localToken = randomBytes(32).toString("base64url");
    // Contrat emballage : si lokkal.json existe et donne `token_path`, le jeton y est écrit ; sinon dans le dossier de config.
    let tokenPath = join(configDir, "local-token");
    try {
      const lk = JSON.parse(readFileSync(join(configDir, "lokkal.json"), "utf-8")) as { token_path?: unknown };
      if (typeof lk.token_path === "string" && lk.token_path) {
        tokenPath = lk.token_path;
        mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
      }
    } catch {
      // pas de lokkal.json : comportement historique
    }
    state.localTokenPath = tokenPath;
    writeFileSync(tokenPath, `${state.localToken}\n`, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
  }
  const demo = opts.seed === false ? null : seedDemo(state);
  const server = createMockHttpServer(state);
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    demo,
    localToken: state.localToken,
    localTokenPath: state.localTokenPath,
    configDir,
    close: () =>
      new Promise<void>((resolve, reject) => {
        state.dispose();
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
