import { describe, expect, it } from "vitest";
import { entityAllowed, haReadOp, haTargetsCheck, haUrlCheck, normalizeEntityPattern, phoneResultMax, PHONE_OP_CAP, PHONE_OPS, privateIPv4, privateIPv6, stripCoordinates } from "../src/index.js";

describe("nœud maison (P10a)", () => {
  it("URL de HA : privée seulement (RFC 1918, lien local, ULA, .local), sans identifiants ni chemin", () => {
    expect(haUrlCheck("http://192.168.1.20:8123")).toEqual({ url: "http://192.168.1.20:8123" });
    expect(haUrlCheck("https://homeassistant.local:8123/")).toEqual({ url: "https://homeassistant.local:8123" });
    expect(haUrlCheck("http://[fd12:3456::10]:8123")).toEqual({ url: "http://[fd12:3456::10]:8123" });
    expect(haUrlCheck("http://10.0.0.5")).toEqual({ url: "http://10.0.0.5" });
    for (const bad of ["https://ha.example.ch", "http://8.8.8.8:8123", "http://127.0.0.1:8123", "http://[2001:db8::1]:8123"]) expect(haUrlCheck(bad), bad).toEqual({ error: "ha_unreachable" });
    for (const bad of ["ftp://192.168.1.2", "http://u:p@192.168.1.2", "http://192.168.1.2/api", "pas une url", "http://192.168.1.2/?x=1"]) expect(haUrlCheck(bad), bad).toEqual({ error: "bad_args" });
  });
  it("adresses : CGNAT, boucle locale et publiques refusées", () => {
    const cgnat = [100, 64, 0, 1].join(".");
    expect([privateIPv4("172.16.0.1"), privateIPv4("172.31.255.1"), privateIPv4("169.254.3.4")]).toEqual([true, true, true]);
    expect([privateIPv4("172.32.0.1"), privateIPv4(cgnat), privateIPv4("127.0.0.1"), privateIPv4("192.169.0.1"), privateIPv4("10.0.0.256")]).toEqual([false, false, false, false, false]);
    expect([privateIPv6("fe80::1"), privateIPv6("fc00::1"), privateIPv6("2001:db8::1"), privateIPv6("::1")]).toEqual([true, true, false, false]);
  });
  it("motifs d'entités : syntaxe de home-bridge, jamais tout", () => {
    expect(normalizeEntityPattern(" Light.* ")).toBe("light.*");
    expect(normalizeEntityPattern("switch.salon_?")).toBe("switch.salon_?");
    for (const bad of ["*.*", "light", "light.", ".x", "light.salon/1", "a b.c"]) expect(normalizeEntityPattern(bad), bad).toBeNull();
    expect(entityAllowed("light.salon", ["light.*"])).toBe(true);
    expect(entityAllowed("switch.salon", ["light.*"])).toBe(false);
    expect(entityAllowed("light.salon", [])).toBe(false);
    expect(entityAllowed("lightXsalon", ["light.salon"])).toBe(false); // le point n'est pas un joker
  });
  it("cibles d'un appel : domaine du service, 10 au plus, aucune cible dans data, références vérifiées", () => {
    const P = ["light.*", "media_player.cuisine"];
    expect(haTargetsCheck({ domain: "light", service: "turn_on", entity_ids: ["light.salon"], data: { brightness: 120 } }, P)).toEqual({ ok: true });
    expect(haTargetsCheck({ domain: "light", service: "turn_on", entity_ids: ["switch.four"] }, P)).toEqual({ error: "entity_not_allowed" });
    expect(haTargetsCheck({ domain: "switch", service: "turn_on", entity_ids: ["light.salon"] }, P)).toEqual({ error: "entity_not_allowed" });
    expect(haTargetsCheck({ domain: "light", service: "turn_on", entity_ids: ["light.salon"], data: { area_id: "salon" } }, P)).toEqual({ error: "entity_not_allowed" });
    expect(haTargetsCheck({ domain: "light", service: "turn_on", entity_ids: Array.from({ length: 11 }, (_, i) => `light.l${i}`) }, P)).toEqual({ error: "bad_args" });
    expect(haTargetsCheck({ domain: "music_assistant", service: "play_media", entity_ids: ["media_player.cuisine"], data: { group_members: ["media_player.salon"] } }, P)).toEqual({ error: "entity_not_allowed" });
    expect(haTargetsCheck({ domain: "music_assistant", service: "play_media", entity_ids: ["media_player.cuisine"] }, P)).toEqual({ ok: true });
  });
  it("aucune coordonnée ne quitte le téléphone : person, device_tracker, zone", () => {
    const p = { entity_id: "person.lea", state: "home", attributes: { friendly_name: "Léa", latitude: 46.2, longitude: 6.1, gps_accuracy: 12, source: "device_tracker.x" } };
    expect(stripCoordinates(p)).toEqual({ entity_id: "person.lea", state: "home", attributes: { friendly_name: "Léa", source: "device_tracker.x" } });
    expect(stripCoordinates({ entity_id: "zone.home", attributes: { latitude: 1, longitude: 2, radius: 100 } }).attributes).toEqual({ radius: 100 });
    const sensor = { entity_id: "sensor.meteo", attributes: { latitude: 1 } };
    expect(stripCoordinates(sensor)).toBe(sensor); // autre domaine : intact (le noyau garde ses propres règles)
  });
  it("opérations : capacité lan_home, plafonds, lectures permises sans attestation", () => {
    expect(PHONE_OPS.has("ha.states")).toBe(true);
    expect(PHONE_OP_CAP["ha.call_service"]).toBe("lan_home");
    expect([phoneResultMax("ha.states"), phoneResultMax("ha.logbook"), phoneResultMax("ha.events"), phoneResultMax("fetch.get"), phoneResultMax("zone.state")]).toEqual([262144, 262144, 65536, 1048576, 65536]);
    expect([haReadOp("ha.states"), haReadOp("ha.events"), haReadOp("ha.call_service"), haReadOp("ha.notify"), haReadOp("ha.tracker_see")]).toEqual([true, true, false, false, false]);
  });
});
