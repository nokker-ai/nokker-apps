/** Sans terminal ou avec un argument inconnu : code 2, message clair, jamais de trace de pile (« Raw mode is not supported »). */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const bin = join(import.meta.dirname, "../bin/nokker.mjs");
const run = (args: string[]) => spawnSync(process.execPath, [bin, ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8", timeout: 30_000 });

describe("bin sans TTY", () => {
  it("stdin non-TTY : code 2, message, pas de trace", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("mode interactif impossible sans terminal");
    expect(r.stderr + r.stdout).not.toMatch(/Raw mode|\bat .*\(.*:\d+:\d+\)/);
  });
  it("argument inconnu : code 2 et message", () => {
    const r = run(["status"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("argument inconnu : status (nokker --help)");
    expect(r.stderr).not.toMatch(/Raw mode/);
  });
});
