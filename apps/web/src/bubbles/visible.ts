/**
 * Bulles que le web n'affiche pas : celles de la maison connectée (`home`, `home_watch`), posées par le noyau à chaque
 * entité touchée ou lue. Aucun rendu ici (le web n'en a pas) : elles sont écartées de la liste de l'interface, donc du
 * compteur, de « Ranger les bulles » et du calque, sans message « type non géré ». Les données restent chez le noyau.
 */
const HIDDEN_KINDS: ReadonlySet<string> = new Set(["home", "home_watch"]);

export function visibleBubbles<T extends { kind: string }>(list: readonly T[]): T[] {
  return list.filter((b) => !HIDDEN_KINDS.has(b.kind));
}
