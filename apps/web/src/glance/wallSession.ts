/**
 * Écran mural (P10b, décision dev 06.11) : fermeture de la session complète de l'appareil AVANT l'affichage du mur.
 * Fonctions sans dépendance lourde (testées seules, test/wall-session.test.ts) ; les dépendances réelles (clé
 * d'appareil, passkey, passerelle) sont injectées par components/WallSettings.tsx.
 */
import type { NokkerClient } from "@nokker-apps/sdk";

export interface DropDeps {
  /** `signOutDevice` (account/lifecycle.ts) : supprime l'appareil côté noyau puis l'oublie localement. */
  signOut: (client: { deleteDevice(id: string): Promise<void> }, readStored: () => Promise<{ deviceId: string } | undefined>, forget: () => Promise<void>) => Promise<void>;
  readStored: () => Promise<{ deviceId: string } | undefined>;
  forget: () => Promise<void>;
  gatewayLogout: () => Promise<void>;
  /** Une passkey rangée dans ce navigateur (localStorage). */
  passkeyLeft: () => boolean;
}

/** Ferme la session complète de cet appareil (clé d'appareil ou passkey, cookie de passerelle) et VÉRIFIE que rien ne
 * reste : sinon `session_still_present` (le mur ne s'affiche pas). */
export async function dropSession(client: NokkerClient, authMode: string | null, deps: DropDeps): Promise<void> {
  await deps.signOut(client, deps.readStored, deps.forget);
  if (authMode === "gateway") await deps.gatewayLogout().catch(() => undefined);
  if ((await deps.readStored().catch(() => undefined)) || deps.passkeyLeft()) throw new Error("session_still_present");
}

/** Afficher le mur : la session est fermée D'ABORD ; si elle ne se ferme pas, le mur ne s'affiche pas. */
export async function openWallScreen(o: { drop: () => Promise<void>; setWall?: () => Promise<unknown>; go: (url: string) => void }): Promise<void> {
  await o.drop();
  await o.setWall?.().catch(() => undefined);
  o.go("/glance?wall=1");
}
