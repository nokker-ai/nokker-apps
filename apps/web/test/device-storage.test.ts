import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** IndexedDB minimal : une seule base, un seul magasin, requêtes résolues en microtâche. */
function fakeIndexedDB() {
  const data = new Map<string, unknown>();
  const request = <T>(run: () => T) => {
    const req: { result?: T; onsuccess?: () => void; onerror?: () => void } = {};
    queueMicrotask(() => {
      req.result = run();
      req.onsuccess?.();
    });
    return req;
  };
  const store = {
    put: (v: unknown, k: string) => request(() => (data.set(k, v), k)),
    get: (k: string) => request(() => data.get(k)),
  };
  const db = { transaction: () => ({ objectStore: () => store }), createObjectStore: () => store };
  return {
    data,
    indexedDB: {
      open: () => {
        const req: { result: typeof db; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void } = { result: db };
        queueMicrotask(() => {
          req.onupgradeneeded?.();
          req.onsuccess?.();
        });
        return req;
      },
    },
  };
}

describe("rangement de l'appareil (format lu par deviceKeyLogin)", () => {
  let fake: ReturnType<typeof fakeIndexedDB>;
  beforeEach(() => {
    fake = fakeIndexedDB();
    vi.stubGlobal("indexedDB", fake.indexedDB);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("buildStoredKey n'a que les trois champs attendus", async () => {
    const { buildStoredKey } = await import("../src/auth.js");
    const key = { type: "private" } as unknown as CryptoKey;
    const stored = buildStoredKey("dev_1", { privateKey: key, publicKeySpkiB64Url: "SPKI" });
    expect(Object.keys(stored).sort()).toEqual(["deviceId", "privateKey", "publicKeySpkiB64Url"]);
    expect(stored).toEqual({ deviceId: "dev_1", privateKey: key, publicKeySpkiB64Url: "SPKI" });
  });

  it("storeDeviceKey écrit sous la clé « device » ; readStoredDeviceKey la relit à l'identique", async () => {
    const { buildStoredKey, storeDeviceKey, readStoredDeviceKey, DEVICE_RECORD_KEY } = await import("../src/auth.js");
    expect(DEVICE_RECORD_KEY).toBe("device");
    const stored = buildStoredKey("dev_9", { privateKey: {} as CryptoKey, publicKeySpkiB64Url: "K" });
    await storeDeviceKey(stored);
    expect([...fake.data.keys()]).toEqual(["device"]);
    expect(fake.data.get("device")).toBe(stored);
    expect(await readStoredDeviceKey()).toBe(stored);
  });
});
