/**
 * `nokker open [chemin]` et `nokker sessions [revoke <id>]` : l'accès web à la machine SANS jeton dans l'URL.
 *
 * `open` demande au noyau un code d'ouverture (60 s, usage unique) avec le jeton local et affiche le lien
 * `<web>/<chemin>#code=<code>` : le web échange le code contre un jeton de session (distinct du jeton local, révocable)
 * et efface le fragment dès le chargement. Le jeton local n'apparaît jamais dans un lien ni dans une sortie.
 * `sessions` liste les sessions d'accès de la machine (créée, dernière utilisation, agent) ; `revoke <id>` en révoque une.
 */
import { NokkerApiError, type AccessSession, type NokkerClient } from "@nokker-apps/sdk";
import { t } from "./i18n/index.js";

export interface AccessIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Chemin normalisé sous l'adresse web : `/setup`, `setup` ou rien (la racine) ; jamais d'adresse complète ni de fragment. */
export function webPath(arg: string | undefined): string | null {
  const raw = (arg ?? "").trim();
  if (raw === "" || raw === "/") return "/";
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.includes("#") || raw.includes("..") || /\s/.test(raw)) return null;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

/** Le lien d'ouverture : adresse web de la machine, chemin, puis `#code=`. */
export function openLink(web: string, path: string, code: string): string {
  return `${web.replace(/\/+$/, "")}${path === "/" ? "/" : path}#code=${code}`;
}

export function explain(err: unknown): string {
  if (err instanceof NokkerApiError) {
    if (err.status === 401 || err.status === 403) return t("the local key was refused (is this the machine that runs Nokker? nokker doctor)");
    if (err.status === 404 || err.status === 405) return t("this Nokker does not offer opening links yet (update it: nokker update)");
    if (err.status === 429) return t("too many codes in a short time: wait a minute");
    return err.serverMessage;
  }
  return t("Nokker is not responding (nokker doctor)");
}

export async function runOpen(client: NokkerClient, web: string | null, pathArg: string | undefined, io: AccessIo, opts: { codeOnly?: boolean } = {}): Promise<number> {
  if (opts.codeOnly) {
    // Le code seul (60 s, une fois, portée propriétaire) : à coller dans la page « ouvrir avec la clé » d'un autre appareil.
    try {
      const { code, expires_in } = await client.mintSessionCode();
      io.out(`${code}\n`);
      io.err(`${t("Paste this code on the key page within {0} s: it works once.", expires_in)}\n`);
      return 0;
    } catch (err) {
      io.err(`${t("Error: {0}", explain(err))}\n`);
      return 1;
    }
  }
  const path = webPath(pathArg);
  if (path === null) {
    io.err(`${t("open expects a path of this machine, for example: nokker open /setup")}\n`);
    return 2;
  }
  if (!web) {
    io.err(`${t("no Lokkal install found here: the web address is read from lokkal.json (nokker doctor)")}\n`);
    return 1;
  }
  try {
    const { code, expires_in } = await client.mintSessionCode();
    io.out(`${openLink(web, path, code)}\n`);
    io.err(`${t("Open this link in your browser within {0} s: it works once.", expires_in)}\n`);
    return 0;
  } catch (err) {
    io.err(`${t("Error: {0}", explain(err))}\n`);
    return 1;
  }
}

/** User-Agent d'un navigateur lu comme une personne le lit : « Chrome 131 · Linux ». Un agent qui n'est pas un navigateur
 * (la CLI, curl…) reste tel quel, tronqué. Affichage seulement. */
export function shortAgent(ua: string): string {
  const u = (ua ?? "").trim();
  if (!u) return "-";
  const browser =
    /Edg\/(\d+)/.exec(u) ? `Edge ${/Edg\/(\d+)/.exec(u)![1]}`
    : /OPR\/(\d+)/.exec(u) ? `Opera ${/OPR\/(\d+)/.exec(u)![1]}`
    : /(?:Chrome|CriOS)\/(\d+)/.exec(u) ? `Chrome ${/(?:Chrome|CriOS)\/(\d+)/.exec(u)![1]}`
    : /(?:Firefox|FxiOS)\/(\d+)/.exec(u) ? `Firefox ${/(?:Firefox|FxiOS)\/(\d+)/.exec(u)![1]}`
    : /Version\/(\d+)[^ ]* .*Safari\//.exec(u) ? `Safari ${/Version\/(\d+)/.exec(u)![1]}`
    : null;
  if (!browser) return u.length > 40 ? `${u.slice(0, 39)}…` : u;
  const os = /Windows/.test(u) ? "Windows" : /(iPhone|iPad|iPod)/.test(u) ? "iOS" : /Android/.test(u) ? "Android" : /Mac OS X|Macintosh/.test(u) ? "macOS" : /CrOS/.test(u) ? "ChromeOS" : /Linux|X11/.test(u) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
}

const day = (s: number): string => new Date(s * 1000).toISOString().replace("T", " ").slice(0, 16);

/** Une ligne par session : id, créée, dernière utilisation, expire, agent. */
export function formatSessions(list: AccessSession[]): string {
  if (list.length === 0) return t("No access session: no browser holds a key for this machine.");
  const head = [t("id"), t("created"), t("last used"), t("expires"), t("agent")];
  const rows = list.map((s) => [s.id, day(s.created_at), day(s.last_used_at), day(s.expires_at), shortAgent(s.agent)]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]): string => r.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd();
  return [line(head), ...rows.map(line)].join("\n");
}

export async function runSessions(client: NokkerClient, args: string[], io: AccessIo): Promise<number> {
  try {
    if (args[0] === "revoke" && args[1]) {
      await client.revokeAccessSession(args[1]);
      io.out(`${t("Session {0} revoked: its browser must be opened again with: nokker open", args[1])}\n`);
      return 0;
    }
    io.out(`${formatSessions((await client.listAccessSessions()).sessions)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof NokkerApiError && err.status === 404 && args[0] === "revoke") {
      io.err(`${t("Error: {0}", t("no such session (nokker sessions)"))}\n`);
      return 1;
    }
    io.err(`${t("Error: {0}", explain(err))}\n`);
    return 1;
  }
}
