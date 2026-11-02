import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { castStatusLabel } from "../src/bubbles/kinds.js";
import { setShellLang } from "../src/i18n/index.js";

afterEach(() => setShellLang(null));

describe("cast bubble", () => {
  it("one short status per core status, in the interface language", () => {
    setShellLang("en");
    expect(["pending", "showing", "stopped", "expired", "refused", "failed"].map((s) => castStatusLabel(s as never))).toEqual(["to approve", "on screen", "stopped", "expired", "refused", "failed"]);
    setShellLang("fr");
    expect(castStatusLabel("pending")).toBe("à approuver");
  });
  it("no bubble iframe ever gets allow-same-origin (the page is untrusted HTML)", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/bubbles/kinds.tsx", import.meta.url)), "utf8");
    const frames = src.match(/<iframe[^>]*>/g) ?? [];
    expect(frames.some((f) => f.includes("cast-frame"))).toBe(true);
    for (const f of frames) expect(f).not.toMatch(/allow-same-origin/);
  });
});
