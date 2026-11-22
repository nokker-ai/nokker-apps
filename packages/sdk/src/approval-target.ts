/**
 * Ce que la carte d'approbation dit sur sa FACE de l'action qui va partir : le champ `target` du noyau (cible lisible, caviardée),
 * jamais `arguments`. Sans `target` (noyau plus ancien, outil sans cible lisible) : rien.
 */

/** Longueur montrée sur la face ; le texte entier reste dans le dépliage. */
export const TARGET_FACE_MAX = 120;

/** La cible telle que le noyau l'a donnée, rognée ; chaîne vide si absente ou pas du texte. */
export function cardTarget(a: { target?: unknown }): string {
  return typeof a.target === "string" ? a.target.trim() : "";
}

/** `max` caractères VISIBLES (pas des unités UTF-16) puis « … » ; le texte tel quel s'il tient. Un saut de ligne devient une espace :
 * la face est une seule ligne. */
export function faceTarget(target: string, max = TARGET_FACE_MAX): string {
  const flat = target.replace(/\s*[\r\n]+\s*/g, " ");
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max).join("").trimEnd()}\u2026`;
}

/** Outils qui EXÉCUTENT une commande (la face dit « va exécuter ») ; les autres : « cible ». */
const COMMAND_TOOLS = /^(?:terminal|shell|bash|sh|exec|run_command|run)$/i;
export const isCommandTool = (toolName: string): boolean => COMMAND_TOOLS.test(toolName);
