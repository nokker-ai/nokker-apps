/**
 * Clé d'appareil (LOKKAL-PHONE §1.1 W3) — interface à deux implémentations :
 *  - web (aujourd'hui) : paire ECDSA P-256 WebCrypto NON extractible, rangée telle quelle dans IndexedDB (`auth.ts`) ;
 *  - native (lot P3, plugin maison `nokker-keys`) : clé dans la Secure Enclave (iOS) ou le Keystore StrongBox (Android),
 *    jamais exportée ; la signature se fait dans le matériel.
 * Le code d'appareil du noyau ne change pas : même enrôlement (`public_key` SPKI base64url), même défi signé.
 * Lot P0 : l'interface et l'implémentation web ; `auth.ts` passera par `deviceKeys()` au lot P3, quand la native existe.
 */
import { generateDeviceKeyPair, signChallenge } from "@nokker-apps/sdk";
import { isNativeShell } from "./native.js";

export type SignPurpose = Parameters<typeof signChallenge>[2];

export interface DeviceKeyHandle {
  deviceId: string;
  publicKeySpkiB64Url: string;
  sign(challenge: string, purpose: SignPurpose): Promise<string>;
}

export interface DeviceKeys {
  readonly kind: "web" | "native";
  /** Nouvelle paire ; la privée ne sort jamais (WebCrypto non extractible, ou matériel). */
  generate(): Promise<{ publicKeySpkiB64Url: string; commit(deviceId: string): Promise<DeviceKeyHandle> }>;
  load(): Promise<DeviceKeyHandle | undefined>;
  forget(): Promise<void>;
}

/** Contrat attendu du plugin natif (`Capacitor.Plugins.NokkerKeys`, lot P3). */
export interface NativeKeysPlugin {
  generate(): Promise<{ key_ref: string; public_key: string }>;
  commit(o: { key_ref: string; device_id: string }): Promise<void>;
  load(): Promise<{ device_id: string; public_key: string } | null>;
  sign(o: { challenge: string; purpose: string }): Promise<{ signature: string }>;
  forget(): Promise<void>;
}

/** Rangement de la clé web : celui d'`auth.ts` (même base, même entrée `device`). */
export interface WebKeyStore {
  put(v: { deviceId: string; privateKey: CryptoKey; publicKeySpkiB64Url: string }): Promise<void>;
  get(): Promise<{ deviceId: string; privateKey: CryptoKey; publicKeySpkiB64Url: string } | undefined>;
  remove(): Promise<void>;
}

export function webDeviceKeys(store: WebKeyStore): DeviceKeys {
  const handle = (deviceId: string, privateKey: CryptoKey, pub: string): DeviceKeyHandle => ({
    deviceId,
    publicKeySpkiB64Url: pub,
    sign: (challenge, purpose) => signChallenge(privateKey, challenge, purpose),
  });
  return {
    kind: "web",
    async generate() {
      const pair = await generateDeviceKeyPair();
      const privateKey = pair.privateKey as CryptoKey;
      return {
        publicKeySpkiB64Url: pair.publicKeySpkiB64Url,
        async commit(deviceId) {
          await store.put({ deviceId, privateKey, publicKeySpkiB64Url: pair.publicKeySpkiB64Url });
          return handle(deviceId, privateKey, pair.publicKeySpkiB64Url);
        },
      };
    },
    async load() {
      const k = await store.get();
      return k ? handle(k.deviceId, k.privateKey, k.publicKeySpkiB64Url) : undefined;
    },
    forget: () => store.remove(),
  };
}

export function nativeDeviceKeys(p: NativeKeysPlugin): DeviceKeys {
  const handle = (deviceId: string, pub: string): DeviceKeyHandle => ({
    deviceId,
    publicKeySpkiB64Url: pub,
    sign: async (challenge, purpose) => (await p.sign({ challenge, purpose: String(purpose) })).signature,
  });
  return {
    kind: "native",
    async generate() {
      const g = await p.generate();
      return {
        publicKeySpkiB64Url: g.public_key,
        async commit(deviceId) {
          await p.commit({ key_ref: g.key_ref, device_id: deviceId });
          return handle(deviceId, g.public_key);
        },
      };
    },
    async load() {
      const k = await p.load();
      return k ? handle(k.device_id, k.public_key) : undefined;
    },
    forget: () => p.forget(),
  };
}

/** L'implémentation de CET appareil : native si la coque porte le plugin, sinon web. */
export function deviceKeys(web: WebKeyStore, w: unknown = globalThis): DeviceKeys {
  const plugin = isNativeShell(w) ? (w as { Capacitor?: { Plugins?: { NokkerKeys?: NativeKeysPlugin } } }).Capacitor?.Plugins?.NokkerKeys : undefined;
  return plugin ? nativeDeviceKeys(plugin) : webDeviceKeys(web);
}
