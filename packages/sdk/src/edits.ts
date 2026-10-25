/**
 * Éditions de fichiers lues dans un `tool.call` (`write_file`, `patch`) — pour qu'un éditeur montre le diff d'un patch
 * (VS Code : diff natif ; ACP : contenu `diff`). Pur, sans I/O : l'appelant lit le fichier sur disque.
 *
 * Les `args` d'un événement sont caviardés et les gros champs TRONQUÉS par le noyau : on ne les prend jamais pour le
 * contenu du fichier. La méthode sûre est de lire le fichier avant (au `tool.call`) et après (au `tool.result`) ; quand
 * la lecture « avant » arrive trop tard (le noyau a déjà écrit), `reconstructBefore` refait l'ancien texte à partir du
 * nouveau et du couple `old_string`/`new_string` — seulement s'il n'est pas tronqué et s'il est sans ambiguïté.
 */

export type FileEditKind = "replace" | "write" | "patch";

export interface FileEdit {
  kind: FileEditKind;
  /** Chemin tel que donné par l'outil (relatif au dossier de la session, ou absolu dans le bac à sable). */
  path: string;
  /** `replace` : passage remplacé et son remplaçant (absents s'ils sont tronqués). */
  oldFragment?: string;
  newFragment?: string;
  /** `write` : contenu complet, absent s'il est tronqué. */
  content?: string;
  /** `patch` (V4A) : fichier créé ou supprimé. */
  op?: "add" | "update" | "delete";
}

/** Le noyau tronque les gros champs (« … » final) : un tel champ n'est pas le vrai texte. */
export function looksTruncated(v: unknown): boolean {
  return typeof v === "string" && /(…|\.\.\.\[tronqué[^\]]*\]|\[…\])$/.test(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && !looksTruncated(v) ? v : undefined;
}

/** Fichiers touchés par un patch V4A (`*** Begin Patch` … `*** End Patch`). */
export function parseV4APaths(patch: string): Array<{ path: string; op: "add" | "update" | "delete" }> {
  const out: Array<{ path: string; op: "add" | "update" | "delete" }> = [];
  for (const line of patch.split("\n")) {
    const m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/);
    if (m) out.push({ op: m[1]!.toLowerCase() as "add" | "update" | "delete", path: m[2]! });
    const mv = line.match(/^\*\*\* Move to: (.+?)\s*$/);
    if (mv && out.length) out[out.length - 1] = { ...out[out.length - 1]!, path: mv[1]! };
  }
  return out;
}

/** Éditions d'un appel d'outil ; `[]` pour un outil qui n'écrit pas de fichier. Accepte les noms d'arguments du noyau
 * (`old_string`/`new_string`, `mode: "patch"` + `patch`) et ceux du mock (`old`/`new`). */
export function fileEditsOf(name: string, args: Record<string, unknown>): FileEdit[] {
  if (name === "write_file") {
    const path = typeof args.path === "string" ? args.path : "";
    if (!path) return [];
    const content = str(args.content);
    return [{ kind: "write", path, ...(content !== undefined ? { content } : {}) }];
  }
  if (name !== "patch") return [];
  if (args.mode === "patch" || typeof args.patch === "string") {
    const text = typeof args.patch === "string" ? args.patch : "";
    return parseV4APaths(text).map((p) => ({ kind: "patch" as const, path: p.path, op: p.op }));
  }
  const path = typeof args.path === "string" ? args.path : "";
  if (!path) return [];
  const oldFragment = str(args.old_string ?? args.old);
  const newFragment = str(args.new_string ?? args.new);
  return [
    {
      kind: "replace",
      path,
      ...(oldFragment !== undefined ? { oldFragment } : {}),
      ...(newFragment !== undefined ? { newFragment } : {}),
    },
  ];
}

function count(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Ancien texte d'un fichier après un `replace`, à partir de son texte actuel : seulement si `newFragment` y figure
 * exactement une fois (sinon `null` : on ne devine pas). */
export function reconstructBefore(after: string, edit: FileEdit): string | null {
  if (edit.kind !== "replace" || edit.oldFragment === undefined || edit.newFragment === undefined) return null;
  if (!edit.newFragment || count(after, edit.newFragment) !== 1) return null;
  return after.replace(edit.newFragment, () => edit.oldFragment!);
}

/** Chemin de l'outil → chemin sur la machine de l'éditeur. Le dossier de la session est monté tel quel dans le bac à
 * sable, sous `/workspace` ; un chemin absolu hors du dossier de la session renvoie `null` (rien à montrer). */
export function hostPathOf(toolPath: string, cwd: string): string | null {
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  const base = cwd.replace(/[\\/]+$/, "");
  const join = (rel: string): string | null => {
    const parts = rel.split(/[\\/]+/).filter((p) => p && p !== ".");
    if (parts.includes("..")) return null;
    return parts.length ? `${base}${sep}${parts.join(sep)}` : null;
  };
  if (toolPath === "/workspace" || toolPath.startsWith("/workspace/")) return join(toolPath.slice("/workspace".length));
  const isAbs = toolPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(toolPath);
  if (!isAbs) return join(toolPath);
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const nb = norm(base);
  const np = norm(toolPath);
  if (np === nb) return null;
  return np.startsWith(`${nb}/`) ? join(np.slice(nb.length + 1)) : null;
}
