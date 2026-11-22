import { describe, expect, it } from "vitest";
import type { NokkerClient } from "@nokker-apps/sdk";
import { signOutDevice } from "../src/account/lifecycle.js";
import { dropSession, openWallScreen, type DropDeps } from "../src/glance/wallSession.js";

/** Un appareil avec une session : clé d'appareil (IndexedDB), passkey (localStorage), cookie de passerelle. */
function device(o: { forgetFails?: boolean } = {}) {
  const log: string[] = [];
  const store = { key: { deviceId: "dev_1" } as { deviceId: string } | undefined, passkey: true, cookie: "nk_gw=abc" };
  const client = { deleteDevice: async (id: string) => void log.push(`delete:${id}`) } as unknown as NokkerClient;
  const deps: DropDeps = {
    signOut: signOutDevice,
    readStored: async () => store.key,
    forget: async () => {
      log.push("forget");
      if (o.forgetFails) throw new Error("idb");
      store.key = undefined;
      store.passkey = false;
    },
    gatewayLogout: async () => void (log.push("gateway-logout"), (store.cookie = "")),
    passkeyLeft: () => store.passkey,
  };
  return { log, store, client, deps };
}

describe("écran mural : session fermée AVANT l'affichage (P10b, décision dev 06.11)", () => {
  it("rouvrir le mur après une reconnexion : session fermée d'abord, puis le mur ; ni clé, ni passkey, ni cookie", async () => {
    const d = device();
    await openWallScreen({
      drop: async () => (d.log.push("drop:start"), await dropSession(d.client, "gateway", d.deps), d.log.push("drop:end")),
      setWall: async () => d.log.push("setWall"),
      go: (u) => d.log.push(`go:${u}`),
    });
    expect(d.log).toEqual(["drop:start", "delete:dev_1", "forget", "gateway-logout", "drop:end", "setWall", "go:/glance?wall=1"]);
    expect(d.store).toEqual({ key: undefined, passkey: false, cookie: "" });
  });

  it("la session ne se ferme pas (stockage en panne) : le mur ne s'affiche PAS", async () => {
    const d = device({ forgetFails: true });
    const go: string[] = [];
    await expect(openWallScreen({ drop: () => dropSession(d.client, "device-key", d.deps), go: (u) => go.push(u) })).rejects.toThrow("session_still_present");
    expect(go).toEqual([]);
  });

  it("hors passerelle, pas d'appel de déconnexion de passerelle (aucune requête inutile)", async () => {
    const d = device();
    await dropSession(d.client, "device-key", d.deps);
    expect(d.log).not.toContain("gateway-logout");
    expect(d.store.key).toBeUndefined();
  });
});
