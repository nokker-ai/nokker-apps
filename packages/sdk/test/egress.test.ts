import { describe, expect, it } from "vitest";
import { fetchUrlCheck, hostAllowed, normalizeEgressHost, phoneResultMax } from "../src/index.js";

describe("règles P11", () => {
  it("hôtes de la liste", () => {
    expect(normalizeEgressHost("Example.CH.")).toBe("example.ch");
    expect(normalizeEgressHost("*.example.ch")).toBe("*.example.ch");
    for (const b of ["*", "*.*.ch", "ch", "192.168.1.1", "nas.local", "x.lan", "box.home.arpa", "srv.internal", "a..b", "-a.ch"]) expect(normalizeEgressHost(b), b).toBeNull();
    expect(hostAllowed("a.example.ch", ["*.example.ch"])).toBe(true);
    expect(hostAllowed("example.ch", ["*.example.ch"])).toBe(false);
    expect(hostAllowed("evilexample.ch", ["*.example.ch"])).toBe(false);
    expect(hostAllowed("EXAMPLE.ch", ["example.ch"])).toBe(true);
  });
  it("URL acceptable : https:443, ni IP, ni identifiants, ni suffixe local", () => {
    expect(fetchUrlCheck("https://example.ch/a?b=1")).toEqual({ host: "example.ch" });
    expect(fetchUrlCheck("https://example.ch:443/")).toEqual({ host: "example.ch" });
    expect(fetchUrlCheck("http://example.ch/")).toEqual({ error: "scheme_not_allowed" });
    expect(fetchUrlCheck("https://example.ch:8443/")).toEqual({ error: "port_not_allowed" });
    expect(fetchUrlCheck("https://u:p@example.ch/")).toEqual({ error: "host_not_allowed" });
    expect(fetchUrlCheck("https://10.0.0.1/")).toEqual({ error: "host_not_allowed" });
    expect(fetchUrlCheck("https://[::1]/")).toEqual({ error: "host_not_allowed" });
    expect(fetchUrlCheck("https://printer.local/")).toEqual({ error: "host_not_allowed" });
    expect(phoneResultMax("fetch.get")).toBe(1024 * 1024);
    expect(phoneResultMax("zone.state")).toBe(64 * 1024);
  });
});
