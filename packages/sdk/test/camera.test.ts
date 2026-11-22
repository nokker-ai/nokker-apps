import { describe, expect, it } from "vitest";
import { decryptThumb, encryptThumb, thumbUrlCheck, PHONE_OP_CAP, PHONE_OPS } from "../src/index.js";

describe("caméra de veille (P10c)", () => {
  it("vignette chiffrée de bout en bout : seule la clé de la demande et le bon id l'ouvrent", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const { key, data } = await encryptThumb(jpeg, "cam_1");
    expect(data.length).toBe(12 + jpeg.length + 16);
    expect(Buffer.from(data).includes(Buffer.from(jpeg))).toBe(false); // le LAN ne voit que du chiffré
    expect(await decryptThumb(data, key, "cam_1")).toEqual(jpeg);
    await expect(decryptThumb(data, key, "cam_2")).rejects.toBeTruthy(); // AAD = id
    const other = await encryptThumb(jpeg, "cam_1");
    await expect(decryptThumb(data, other.key, "cam_1")).rejects.toBeTruthy();
    const bad = data.slice();
    bad[20] ^= 1;
    await expect(decryptThumb(bad, key, "cam_1")).rejects.toBeTruthy();
  });
  it("URL de vignette : http, IPv4 privée, port 8802, /t/<32>, rien d'autre", () => {
    const t = "A".repeat(32);
    expect(thumbUrlCheck(`http://192.168.1.40:8802/t/${t}`)).toBe(true);
    expect(thumbUrlCheck(`http://10.0.0.7:8802/t/${t}`)).toBe(true);
    for (const bad of [`https://192.168.1.40:8802/t/${t}`, `http://8.8.8.8:8802/t/${t}`, `http://192.168.1.40:80/t/${t}`, `http://192.168.1.40:8802/x/${t}`, `http://192.168.1.40:8802/t/short`, `http://nas.local:8802/t/${t}`, `http://192.168.1.40:8802/t/${t}?a=1`])
      expect(thumbUrlCheck(bad), bad).toBe(false);
  });
  it("opérations de la file : capacité camera", () => {
    expect(PHONE_OPS.has("camera.watch_event") && PHONE_OPS.has("camera.thumb_url")).toBe(true);
    expect(PHONE_OP_CAP["camera.thumb_url"]).toBe("camera");
  });
});
