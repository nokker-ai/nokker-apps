import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";

const prev = process.env.NOKKER_CONFIG_DIR_OVERRIDE;
let dir = "";
const lokkal = (extra: Record<string, unknown>) =>
  writeFileSync(join(dir, "lokkal.json"), JSON.stringify({
    compose: "/home/alice/.nokker/docker-compose.yml", project: "nokker-alice", version: "0.1.0", core_service: "core",
    api_url: "http://127.0.0.1:1", web_url: "http://127.0.0.1:2", token_path: join(dir, "local-token"),
    env_file: "/home/alice/.nokker/.env", install_dir: "/home/alice/.nokker", ...extra,
  }));
// Rien ne répond : docker, wsl.exe et git absents.
const none = async () => ({ code: 1, stdout: "", stderr: "", error: "ENOENT" });
const gitLine = async (platform: NodeJS.Platform) =>
  (await runDoctor({ serverUrl: "http://127.0.0.1:1", serverSource: "lokkal.json", fix: false, run: none, candidates: [], platform } as never))
    .checks.find((c) => c.name === "git");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "doc-wsl-"));
  process.env.NOKKER_CONFIG_DIR_OVERRIDE = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
  else process.env.NOKKER_CONFIG_DIR_OVERRIDE = prev;
});

describe("doctor : git absent de l'hôte", () => {
  it("Windows avec la pile dans WSL : avertissement qui le dit, pas d'échec", async () => {
    lokkal({ wsl_distro: "Ubuntu" });
    const g = await gitLine("win32");
    expect(g).toMatchObject({ status: "warn" });
    expect(g!.detail).toContain("WSL (Ubuntu)");
    expect(g!.detail).toContain("not needed");
  });

  it("Windows sans WSL dans lokkal.json : reste un échec", async () => {
    lokkal({});
    expect(await gitLine("win32")).toMatchObject({ status: "ko" });
  });

  it("Linux, même avec wsl_distro (fichier copié) : reste un échec", async () => {
    lokkal({ wsl_distro: "Ubuntu" });
    expect(await gitLine("linux")).toMatchObject({ status: "ko" });
  });
});
