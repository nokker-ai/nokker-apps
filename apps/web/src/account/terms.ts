/**
 * Version lisible des conditions acceptées. Le noyau identifie une version par l'empreinte SHA-256 de son texte
 * (`terms.version`) ; le texte lui-même porte en tête sa version lisible (« **Version 2 — 28 octobre 2026** »).
 * On l'affiche quand l'empreinte acceptée est celle du texte courant ; sinon l'empreinte courte.
 */

/** « 2 — 28 octobre 2026 » depuis la ligne « **Version 2 — 28 octobre 2026** » du texte ; null si absente. */
export function termsVersionLabel(text: string): string | null {
  const m = /^\s*\**\s*Version\s+([^*\n]+?)\s*\**\s*$/im.exec(text.slice(0, 2000));
  const v = m?.[1]?.replace(/[.\s]+$/, "");
  return v ? v : null;
}

/** Empreinte courte (8 caractères) quand aucune version lisible n'est connue. */
export function shortVersion(version: string): string {
  return /^[0-9a-f]{16,}$/i.test(version) ? `${version.slice(0, 8)}…` : version;
}
