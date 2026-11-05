/**
 * Capacités du noyau pour l'appelant (`GET /v1/capabilities`, core docs/CLIENT-API.md §Capacités) : lues une fois
 * après connexion, AVANT que la coque ne soit prête, pour ne plus sonder les routes une à une (404 en série). Un noyau
 * d'avant (404, erreur) ne donne rien : `known()` est faux et chaque écran garde sa sonde d'avant.
 */
import type { Capabilities, CapabilityName, NokkerClient } from "@nokker-apps/sdk";

let caps: Capabilities | null = null;

export async function loadCapabilities(client: NokkerClient): Promise<Capabilities | null> {
  try {
    caps = await client.getCapabilities();
  } catch {
    caps = null;
  }
  return caps;
}

/** Tests, déconnexion : oublie les capacités lues. */
export function setCapabilities(c: Capabilities | null): void {
  caps = c;
}

/** Les capacités ont été lues (noyau ≥ 6aaccb4). */
export function known(): boolean {
  return caps !== null;
}

/** `true`/`false` quand le noyau l'a dit, `null` quand il faut encore sonder (noyau plus ancien). Une clé absente d'une
 * réponse lue vaut `false` (contrat additif). */
export function capability(name: CapabilityName): boolean | null {
  return caps ? caps.features[name] === true : null;
}

/** Le noyau a dit que la fonction est éteinte pour cet appelant : ne pas appeler ses routes. */
export function off(name: CapabilityName): boolean {
  return capability(name) === false;
}
