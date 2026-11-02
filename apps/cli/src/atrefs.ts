/**
 * Références `@…` dans le message, développées AVANT l'envoi (modèle : `apps/vscode/src/context.ts`, `composeMessage`) :
 *  - `@fichier` texte : contenu inséré dans un bloc délimité (100 Ko par fichier, 300 Ko au total, au-delà tronqué) ;
 *  - `@image.png|jpg|webp|gif` : pièce jointe `{path}` relative au dossier de la session (LOKKAL.md §7.6 ; 4 images, 5 Mo) ;
 *  - `@dossier` : liste des fichiers (profondeur 2, 200 entrées, sans `.git` ni `node_modules`) ;
 *  - `@http(s)://…` : rien n'est téléchargé, une ligne demande au modèle de lire l'adresse avec son outil `web_fetch` ;
 *  - tout `@` qui ne correspond à rien (adresse mail, mot) reste tel quel.
 * Un chemin qui sort du dossier (`..`, absolu hors dossier, lien symbolique qui en sort) est refusé et laissé tel quel.
 * Les blocs destinés au modèle sont en anglais fixe (comme le prompt de `/init`) ; les remarques destinées à
 * l'utilisateur (`notes`) passent par le catalogue.
 */
import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ChatAttachment } from "@nokker-apps/sdk";
import { t } from "./i18n/index.js";

export const MAX_FILE_BYTES = 100 * 1024;
export const MAX_TOTAL_BYTES = 300 * 1024;
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_DIR_ENTRIES = 200;
export const DIR_DEPTH = 2;
const IGNORED = new Set([".git", "node_modules"]);
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
/** Ponctuation de phrase qui peut suivre une référence (`voir @src/a.ts, puis…`). */
const TRAILING = /[,;:!?)\]}"'.]+$/;

export interface AtRefResult {
  /** Message à envoyer : le texte d'origine, suivi des blocs. */
  text: string;
  attachments: ChatAttachment[];
  /** Ce qui a été inséré / joint (affichage à l'utilisateur). */
  added: string[];
  /** Ce qui a été refusé ou tronqué (affichage à l'utilisateur). */
  warnings: string[];
}

interface Token {
  /** Texte brut après `@` (sans guillemets). */
  value: string;
  /** Texte tel qu'écrit, `@` compris. */
  raw: string;
}

/** Les jetons `@…` : précédés du début ou d'un blanc (jamais le `@` d'une adresse mail). `@"avec espaces"` accepté. */
export function findAtTokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/(?:^|\s)@(?:"([^"\n]+)"|(\S+))/g)) {
    const value = m[1] ?? m[2] ?? "";
    if (value) out.push({ value, raw: `@${m[1] !== undefined ? `"${m[1]}"` : m[2]}` });
  }
  return out;
}

const human = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} KB` : `${n} B`);
const posix = (p: string): string => p.split(sep).join("/");

function fence(body: string): { open: string; close: string } {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return { open: f, close: f };
}

/** `abs` est-il le dossier ou dessous, réellement (liens symboliques résolus) ? */
async function inside(rootReal: string, abs: string): Promise<boolean> {
  try {
    const real = await realpath(abs);
    const rel = relative(rootReal, real);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
}

async function listDir(abs: string, depth = DIR_DEPTH): Promise<{ lines: string[]; more: number }> {
  const lines: string[] = [];
  let more = 0;
  async function walk(dir: string, prefix: string, level: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue;
      if (lines.length >= MAX_DIR_ENTRIES) {
        more++;
        if (e.isDirectory() && level < depth) await walk(join(dir, e.name), `${prefix}${e.name}/`, level + 1);
        continue;
      }
      lines.push(`${prefix}${e.name}${e.isDirectory() ? "/" : ""}`);
      if (e.isDirectory() && level < depth) await walk(join(dir, e.name), `${prefix}${e.name}/`, level + 1);
    }
  }
  await walk(abs, "", 1);
  return { lines, more };
}

async function readHead(abs: string, max: number): Promise<{ buf: Buffer; size: number }> {
  const fh = await open(abs, "r");
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(Math.min(size, max));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return { buf: buf.subarray(0, bytesRead), size };
  } finally {
    await fh.close();
  }
}

/** Développe les références de `text` dans le dossier `cwd` (`null` : pas de session locale, seules les adresses http(s)
 * sont traitées — un fichier ne se lit que dans le dossier d'une session de code). */
export async function expandAtRefs(text: string, cwd: string | null): Promise<AtRefResult> {
  const result: AtRefResult = { text, attachments: [], added: [], warnings: [] };
  const tokens = findAtTokens(text);
  if (!tokens.length) return result;
  const blocks: string[] = [];
  const done = new Set<string>();
  let total = 0;
  let rootReal: string | null = null;
  if (cwd) rootReal = await realpath(cwd).catch(() => null);

  for (const tok of tokens) {
    // Candidats : le jeton entier, puis sans ponctuation finale.
    const stripped = tok.value.replace(TRAILING, "");
    const candidates = tok.raw.includes('"') || stripped === tok.value || !stripped ? [tok.value] : [tok.value, stripped];

    // Adresse http(s) : jamais téléchargée ici.
    const urlText = [stripped, tok.value].find((c) => /^https?:\/\//i.test(c));
    if (urlText) {
      let url: string | null = null;
      try {
        url = new URL(urlText).toString();
      } catch {
        // pas une adresse valide : reste telle quelle
      }
      if (url && !done.has(url)) {
        done.add(url);
        blocks.push(`Read the page at ${url} with your web_fetch tool before answering.`);
        result.added.push(url);
      }
      continue;
    }
    if (!cwd || !rootReal) continue;

    for (const cand of candidates) {
      const abs = isAbsolute(cand) ? resolve(cand) : resolve(cwd, cand);
      const relPath = relative(resolve(cwd), abs);
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue; // n'existe pas : essai suivant, sinon le jeton reste tel quel
      }
      const rel = posix(relPath);
      if (relPath.startsWith("..") || isAbsolute(relPath) || !(await inside(rootReal, abs))) {
        result.warnings.push(t("{0}: outside the session folder, not read.", tok.raw));
        break;
      }
      if (done.has(rel)) break;
      done.add(rel);

      if (st.isDirectory()) {
        const { lines, more } = await listDir(abs);
        const f = fence(lines.join("\n"));
        blocks.push(`Folder \`${rel || "."}\` (depth ${DIR_DEPTH}, ${lines.length} entries${more ? `, ${more} more not listed` : ""}):\n${f.open}\n${lines.join("\n")}\n${f.close}`);
        result.added.push(`${rel || "."}/`);
        if (more) result.warnings.push(t("{0}: list cut at {1} entries.", tok.raw, MAX_DIR_ENTRIES));
      } else if (st.isFile() && IMAGE_RE.test(rel)) {
        if (st.size > MAX_IMAGE_BYTES) result.warnings.push(t("{0}: image over 5 MB, not attached.", tok.raw));
        else if (result.attachments.length >= MAX_IMAGES) result.warnings.push(t("{0}: at most {1} images per message, not attached.", tok.raw, MAX_IMAGES));
        else {
          result.attachments.push({ path: rel });
          result.added.push(rel);
        }
      } else if (st.isFile()) {
        const room = MAX_TOTAL_BYTES - total;
        if (room <= 0) {
          result.warnings.push(t("{0}: total limit of {1} KB reached, not inlined.", tok.raw, MAX_TOTAL_BYTES / 1024));
          blocks.push(`File \`${rel}\` was not inlined: the total size limit for referenced files was reached.`);
          break;
        }
        const { buf, size } = await readHead(abs, Math.min(MAX_FILE_BYTES, room));
        if (buf.subarray(0, 8000).includes(0)) {
          result.warnings.push(t("{0}: binary file, not inlined.", tok.raw));
          break;
        }
        total += buf.length;
        const cut = size > buf.length;
        const body = buf.toString("utf8").replace(/�+$/, "");
        const f = fence(body);
        blocks.push(`File \`${rel}\` (${human(size)}${cut ? `, truncated to the first ${human(buf.length)}` : ""}):\n${f.open}\n${body.replace(/\n$/, "")}\n${f.close}`);
        result.added.push(cut ? `${rel} (${human(buf.length)}/${human(size)})` : rel);
        if (cut) result.warnings.push(t("{0}: file cut at {1}.", tok.raw, human(buf.length)));
      } else {
        result.warnings.push(t("{0}: neither a file nor a folder, ignored.", tok.raw));
      }
      break;
    }
  }
  if (blocks.length) result.text = `${text}\n\n${blocks.join("\n\n")}`;
  return result;
}

/** Complétion par Tab du dernier `@…` en fin de saisie : `value` = saisie complétée (préfixe commun), `candidates` =
 * noms proposés (dossiers terminés par `/`). `null` si la fin de saisie n'est pas une référence ou si rien ne correspond. */
export async function completeAtRef(input: string, cwd: string): Promise<{ value: string; candidates: string[] } | null> {
  const m = /(?:^|\s)@([^\s"]*)$/.exec(input);
  if (!m) return null;
  const partial = m[1]!;
  if (/^https?:/i.test(partial)) return null;
  const slash = partial.lastIndexOf("/");
  const dirPart = slash >= 0 ? partial.slice(0, slash + 1) : "";
  const base = slash >= 0 ? partial.slice(slash + 1) : partial;
  const absDir = isAbsolute(dirPart) ? dirPart : resolve(cwd, dirPart || ".");
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = entries
    .filter((e) => e.name.startsWith(base) && !IGNORED.has(e.name) && (base.startsWith(".") || !e.name.startsWith(".")))
    .map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`)
    .sort();
  if (!names.length) return null;
  let common = names[0]!;
  for (const n of names) while (!n.startsWith(common)) common = common.slice(0, -1);
  const head = input.slice(0, input.length - partial.length);
  const value = `${head}${dirPart}${common}`;
  // Un seul candidat fichier : une espace derrière, pour enchaîner la phrase.
  const only = names.length === 1 && !common.endsWith("/");
  return { value: only ? `${value} ` : value, candidates: names };
}
