/**
 * Windows avec Lokkal dans WSL 2 (lokkal.json `wsl_distro`) : le noyau tourne dans la distro et ne connaît que des chemins
 * Linux, alors que `nokker.exe` est lancé depuis un dossier Windows. Sans traduction, `POST /v1/local/sessions {cwd}`
 * reçoit `\\wsl.localhost\Ubuntu\home\u\projet` ou `C:\Users\u\projet`, hors des racines du noyau : 403, fil ordinaire.
 *
 * - `serverCwdFor` : dossier local → dossier à demander au noyau.
 *   `\\wsl.localhost\<distro>\…` et `\\wsl$\<distro>\…` (distro de lokkal.json, casse ignorée) → `/…` ;
 *   `C:\…` → `/mnt/c/…` (montage WSL par défaut ; accepté seulement si les racines du noyau le couvrent) ;
 *   UNC d'une AUTRE distro → `other-distro` (on n'essaie pas, le message dit pourquoi).
 * - `localPathFor` : l'inverse, pour les lectures locales de la CLI (@refs, complétion, /export) quand la session porte
 *   un chemin Linux.
 * Hors Windows, ou sans `wsl_distro`, les deux fonctions rendent le chemin tel quel.
 */

export interface WslContext {
  platform: string;
  wslDistro?: string | null;
}

export type ServerCwd =
  | { kind: "same"; cwd: string }
  | { kind: "wsl"; cwd: string }
  | { kind: "drive"; cwd: string; drive: string }
  | { kind: "other-distro"; cwd: string; distro: string };

const UNC_WSL = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/i;
const DRIVE = /^([A-Za-z]):(?:[\\/](.*))?$/;

function active(ctx: WslContext): string | null {
  return ctx.platform === "win32" && ctx.wslDistro ? ctx.wslDistro : null;
}

function posixTail(rest: string | undefined): string {
  const parts = (rest ?? "").split(/[\\/]+/).filter(Boolean);
  return "/" + parts.join("/");
}

export function serverCwdFor(local: string, ctx: WslContext): ServerCwd {
  const distro = active(ctx);
  if (!distro) return { kind: "same", cwd: local };
  const unc = UNC_WSL.exec(local);
  if (unc) {
    const d = unc[1]!;
    if (d.toLowerCase() !== distro.toLowerCase()) return { kind: "other-distro", cwd: local, distro: d };
    return { kind: "wsl", cwd: posixTail(unc[2]) };
  }
  const drive = DRIVE.exec(local);
  if (drive) {
    const letter = drive[1]!.toLowerCase();
    const tail = posixTail(drive[2]);
    return { kind: "drive", cwd: `/mnt/${letter}${tail === "/" ? "" : tail}`, drive: `${drive[1]!.toUpperCase()}:` };
  }
  return { kind: "same", cwd: local };
}

/** Chemin Linux de la session → chemin lisible depuis Windows (`/mnt/c/x` → `C:\x`, `/home/u` → `\\wsl.localhost\<distro>\home\u`). */
export function localPathFor(serverPath: string, ctx: WslContext): string {
  const distro = active(ctx);
  if (!distro || !serverPath.startsWith("/")) return serverPath;
  const mnt = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(serverPath);
  if (mnt) return `${mnt[1]!.toUpperCase()}:\\${(mnt[2] ?? "").split("/").filter(Boolean).join("\\")}`;
  const parts = serverPath.split("/").filter(Boolean);
  return `\\\\wsl.localhost\\${distro}${parts.length ? "\\" + parts.join("\\") : ""}`;
}
