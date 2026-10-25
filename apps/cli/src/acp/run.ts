/**
 * Processus `nokker acp` : stdin/stdout = ACP (une ligne JSON par message), rien d'autre sur stdout. Le journal va dans
 * `cli.log` (`nokker logs --component cli`).
 */
import { readFile, stat } from "node:fs/promises";
import { NokkerClient, type EditorFs } from "@nokker-apps/sdk";
import { BRAND } from "@nokker-apps/brand";
import { isLocalServer, loadSession, readLocalToken } from "../auth.js";
import { t } from "../i18n/index.js";
import { cliLog } from "../log.js";
import { CLI_VERSION } from "../version.js";
import { AcpAgent } from "./agent.js";
import { RPC, RpcFailure, RpcPeer } from "./rpc.js";

/** Fichiers relus pour les diffs : au-delà, pas de diff (un éditeur n'a pas à recevoir un gros binaire). */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

export const nodeFs: EditorFs = {
  async read(path) {
    try {
      const st = await stat(path);
      if (!st.isFile() || st.size > MAX_DIFF_BYTES) return null;
      const text = await readFile(path, "utf-8");
      return text.includes("\u0000") ? null : text;
    } catch {
      return null;
    }
  },
};

/** Jeton local sur un noyau local (comme la CLI), sinon la session d'appareil enregistrée par `nokker`. */
export async function acpConnect(serverUrl: string): Promise<NokkerClient> {
  const client = new NokkerClient({ baseUrl: serverUrl, userAgent: `${BRAND.userAgent} acp` });
  if (isLocalServer(serverUrl)) {
    const token = await readLocalToken();
    if (token) {
      client.setToken(token);
      return client;
    }
  }
  const saved = await loadSession();
  if (saved) {
    client.setToken(saved.token);
    return client;
  }
  throw new RpcFailure(
    RPC.authRequired,
    isLocalServer(serverUrl)
      ? t("local token not found: is Lokkal installed and running? (nokker doctor)")
      : t("no session for {0}: first run {1} --server {0} in a terminal", serverUrl, BRAND.cliBin),
  );
}

export async function runAcp(serverUrl: string): Promise<number> {
  const peer = new RpcPeer({
    write: (line) => process.stdout.write(line),
    onLog: (level, msg) => cliLog(level, `acp : ${msg}`),
  });
  const agent = new AcpAgent({
    peer,
    connect: () => acpConnect(serverUrl),
    fs: nodeFs,
    version: CLI_VERSION,
    log: (level, msg) => cliLog(level, msg),
    costLine: process.env.NOKKER_ACP_COST_LINE !== "0",
  });
  cliLog("info", `acp: started (server ${serverUrl})`);
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => peer.feed(chunk));
  await new Promise<void>((resolve) => process.stdin.on("end", resolve));
  peer.close();
  agent.dispose();
  cliLog("info", "acp: end of stdin, stopping");
  return 0;
}
