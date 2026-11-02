/**
 * Thème des écrans hors de la coque (invitation, premier lancement de Lokkal) : le réglage mémorisé par la coque
 * (`theme`, clair par défaut, choix produit) s'applique aussi ici, sinon un testeur en sombre retrouvait ces écrans en
 * clair. Lecture seule : seule la coque change le réglage.
 */
import { readJson } from "../viewState.js";

export function applyStoredTheme(): void {
  if (typeof document === "undefined") return;
  if (readJson<"light" | "dark">("theme", "light") === "dark") document.documentElement.setAttribute("data-theme", "dark");
}
