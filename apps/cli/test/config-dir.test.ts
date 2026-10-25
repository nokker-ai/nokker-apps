/** Dossier de config aligné sur l'installeur (~/.config/nokker partout) + repli lecture sur les anciens emplacements. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, legacyConfigDirs, lokkalFilePath } from "../src/config.js";
import { readLokkal } from "../src/lokkal.js";
import { runDoctor } from "../src/doctor.js";

const KEYS = ["NOKKER_CONFIG_DIR_OVERRIDE", "HOME", "USERPROFILE", "APPDATA", "XDG_CONFIG_HOME"] as const;
const saved: Record<string, string | undefined> = {};
const realPlatform = process.platform;
let home: string;
const setPlatform = (p: NodeJS.Platform): void => void Object.defineProperty(process, "platform", { value: p });
const LOKKAL = { compose: "/c/docker-compose.yml", project: "nokker", version: "0.1.0", core_service: "core", api_url: "http://127.0.0.1:18742", web_url: "http://127.0.0.1:7420", token_path: "/c/t", env_file: "/c/.env", install_dir: "/c" };

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
  delete process.env.XDG_CONFIG_HOME;
  home = mkdtempSync(join(tmpdir(), "nokker-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
});
afterEach(() => {
  setPlatform(realPlatform);
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

describe("configDir sur les 3 OS", () => {
  it("Linux : $XDG_CONFIG_HOME/nokker si défini, sinon ~/.config/nokker", () => {
    setPlatform("linux");
    expect(configDir()).toBe(join(home, ".config", "nokker"));
    process.env.XDG_CONFIG_HOME = join(home, "xdg");
    expect(configDir()).toBe(join(home, "xdg", "nokker"));
    expect(legacyConfigDirs()).toEqual([]);
  });
  it("macOS : ~/.config/nokker (plus Application Support), ancien emplacement en repli", () => {
    setPlatform("darwin");
    expect(configDir()).toBe(join(home, ".config", "nokker"));
    expect(legacyConfigDirs()).toEqual([join(home, "Library", "Application Support", "nokker")]);
  });
  it("Windows : %USERPROFILE%\\.config\\nokker (plus %APPDATA%), ancien emplacement en repli", () => {
    setPlatform("win32");
    expect(configDir()).toBe(join(home, ".config", "nokker"));
    expect(legacyConfigDirs()).toEqual([join(home, "AppData", "Roaming", "nokker")]);
  });
  it("NOKKER_CONFIG_DIR_OVERRIDE l'emporte partout", () => {
    process.env.NOKKER_CONFIG_DIR_OVERRIDE = "/tmp/iso";
    for (const p of ["linux", "darwin", "win32"] as const) {
      setPlatform(p);
      expect(configDir()).toBe("/tmp/iso");
    }
  });
});

describe("repli lecture sur les anciens emplacements", () => {
  function put(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "lokkal.json");
    writeFileSync(f, JSON.stringify(LOKKAL));
    return f;
  }
  it("nouvel emplacement : lu sans avertissement", async () => {
    setPlatform("darwin");
    put(join(home, ".config", "nokker"));
    const r = readLokkal();
    expect(r.status).toBe("ok");
    expect(r.status === "ok" && r.legacyPath).toBeFalsy();
    expect(lokkalFilePath()).toBe(join(home, ".config", "nokker", "lokkal.json"));
  });
  for (const [os, legacy] of [["darwin", ["Library", "Application Support", "nokker"]], ["win32", ["AppData", "Roaming", "nokker"]]] as const) {
    it(`${os} : ancien fichier lu en repli, doctor avertit`, async () => {
      setPlatform(os);
      const f = put(join(home, ...legacy));
      const r = readLokkal();
      expect(r).toMatchObject({ status: "ok", legacyPath: f });
      const { checks } = await runDoctor({ serverUrl: "http://127.0.0.1:1", serverSource: "default", fix: false, run: async () => ({ code: 1, stdout: "", stderr: "", error: "ENOENT" }) } as never);
      const w = checks.find((c) => c.name === "emplacement de config");
      expect(w).toMatchObject({ status: "warn" });
      expect(w!.detail).toContain(f);
    });
  }
  it("Linux : pas d'ancien emplacement", () => {
    setPlatform("linux");
    expect(readLokkal().status).toBe("absent");
  });
});
