import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

function stubPage(hostname: string, pathname = "/"): void {
  const location = { hostname, pathname, host: `${hostname}:7420`, origin: `http://${hostname}:7420`, hash: "", search: "" };
  vi.stubGlobal("location", location);
  vi.stubGlobal("navigator", { language: "fr-CH" });
  vi.stubGlobal("window", { location, navigator: { language: "fr-CH" } }); // no jsdom in this package
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("Lokkal opened without its local key", () => {
  const core = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;

  it("loopback host served by a Lokkal core: the Lokkal page, not the nokker.ai sign-in", async () => {
    for (const h of ["127.0.0.1", "localhost", "[::1]"]) {
      stubPage(h);
      const { lokkalWithoutKey } = await import("../src/auth.js");
      expect(await lokkalWithoutKey(false, "", h, core(401))).toBe(true);
    }
  });

  it("cloud host, gateway host, the mock or a cloud core run locally: unchanged (sign-in)", async () => {
    stubPage("app.nokker.ai");
    const { lokkalWithoutKey } = await import("../src/auth.js");
    expect(await lokkalWithoutKey(false, "", "app.nokker.ai", core(401))).toBe(false);
    expect(await lokkalWithoutKey(false, "", "alice.nokker.app", core(401))).toBe(false);
    stubPage("localhost");
    expect(await lokkalWithoutKey(true, "", "localhost", core(401))).toBe(false); // dev and e2e against the mock
    expect(await lokkalWithoutKey(false, "", "localhost", core(404))).toBe(false); // cloud core without local routes
    const down = (async () => {
      throw new TypeError("refused");
    }) as unknown as typeof fetch;
    expect(await lokkalWithoutKey(false, "", "localhost", down)).toBe(false);
  });

  it("the page says how to open it with the key; no beta, no « Apply »", async () => {
    stubPage("127.0.0.1");
    const { Welcome } = await import("../src/welcome/Welcome.js");
    const props = { client: {} as never, status: "", retryAccess: () => undefined, lang: "fr" as const };
    const local = renderToStaticMarkup(React.createElement(Welcome, { ...props, access: "lokkal-no-key" }));
    expect(local).toContain("data-local-key-page");
    expect(local).toContain("Ce Nokker tourne sur ta machine");
    expect(local).toContain("http://127.0.0.1:7420/setup");
    expect(local).toContain("~/.nokker/state/local-token");
    expect(local).not.toMatch(/bêta privée|Candidater|Se connecter/);

    stubPage("app.nokker.ai");
    const cloud = renderToStaticMarkup(React.createElement(Welcome, { ...props, access: "signed-out" }));
    expect(cloud).not.toContain("data-local-key-page");
    expect(cloud).toContain("Candidater");
  });

  it("a pasted key goes to /setup until the first launch is done, then to the app", async () => {
    stubPage("127.0.0.1");
    const { afterLocalKey } = await import("../src/onboarding/LocalKey.js");
    expect(afterLocalKey(false)).toBe("/setup");
    expect(afterLocalKey(true)).toBe("/");
  });
});
