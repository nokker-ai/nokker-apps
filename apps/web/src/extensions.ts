/**
 * Routes ajoutées par le noyau pour le client web (BUBBLES.md §9, noyau main 25de65c) — branchées ici, en un seul
 * endroit : notifications ouvertes (§9.1), utilisateurs connus (§9.2), Crew (§9.4). Les images d'aperçu signées
 * (§9.3, `?exp=&sig=`) passent telles quelles par `client.resolveUrl` : rien à faire côté client.
 */
import type { Agent, Bubble, NokkerClient } from "@nokker-apps/sdk";

export interface Member {
  id: string;
  name: string;
  initials: string;
  color: string;
}

/** Couleur d'avatar : côté client, stable par identifiant (l'API ne porte jamais de couleur). */
/** Teinte HSL dérivée de l'identifiant (hash stable) : saturation et clarté fixes, assez profondes pour un texte blanc lisible (AA)
 * sur le thème clair comme sur le sombre. */
function colorFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 62%, 38%)`;
}

/** §9.1 — `notify` ouvertes adressées à l'appelant : un rechargement de page ne les perd plus. */
export async function loadOpenNotifications(client: NokkerClient): Promise<Bubble[]> {
  try {
    return await client.listNotifications();
  } catch {
    return [];
  }
}

/** §9.2 — utilisateurs connus de la config (cibles du partage). */
export async function loadMembers(client: NokkerClient): Promise<Member[]> {
  try {
    return (await client.listUsers()).map((u) => ({ ...u, color: colorFor(u.id) }));
  } catch {
    return [];
  }
}

/** §9.4 — agents du Crew. */
export async function loadAgents(client: NokkerClient): Promise<Agent[]> {
  try {
    return await client.listAgents();
  } catch {
    return [];
  }
}

/** Image d'aperçu : URL signée du noyau (§9.3), re-servie par lui (jamais le site tiers), sans jeton. */
export function previewImageUrl(client: NokkerClient, path: string | null | undefined): string | null {
  return client.resolveUrl(path);
}
