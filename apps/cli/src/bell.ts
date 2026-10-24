/**
 * Sonnette terminal — « toc » optionnel (BEL, `\x07`). Pas de fichier audio joué : un terminal n'en
 * lit pas nativement, et le signal portable le plus proche de la signature Nokker (packages/brand
 * `signature.ts`, désactivée par défaut sur desktop) est le caractère BEL — c'est au terminal de
 * l'utilisateur (ou à son OS) de décider d'en faire un son, une icône clignotante, ou rien.
 * Coupé par défaut (`--sound` pour l'activer), comme l'exige la règle mémoire `feedback-nokker-ui-bulles`.
 */
export function ringBell(enabled: boolean, out: NodeJS.WritableStream = process.stdout): void {
  if (enabled) out.write("\x07");
}
