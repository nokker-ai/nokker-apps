/**
 * Le client piloté dans un VRAI pseudo-terminal (python3 pty.fork) : Entrée doit soumettre la ligne, qu'elle arrive
 * d'un bloc (« /sessions\r », comme un pilote ou un collage) ou touche par touche. Régression : « > /sessions/quit »
 * restait sur la même ligne.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";

const run = promisify(execFile);
const hasPython = (() => {
  try {
    execFileSync("python3", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

let dir: string;
let mock: MockServerHandle;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-cli-pty-"));
  mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: dir });
});
afterAll(async () => {
  await mock.close();
  await rm(dir, { recursive: true, force: true });
});

async function drive(steps: Array<[number, string] | [number, string, string]>, tail = 3): Promise<{ screen: string; exited: boolean }> {
  const cfg = {
    argv: [process.execPath, join(import.meta.dirname, "../bin/nokker.mjs"), "--server", mock.url],
    cwd: dir,
    env: { NOKKER_CONFIG_DIR_OVERRIDE: dir },
    steps,
    tail,
  };
  const { stdout } = await run("python3", [join(import.meta.dirname, "pty_drive.py"), JSON.stringify(cfg)], { timeout: 60_000 });
  return { screen: stdout, exited: /EXITED=1/.test(stdout) };
}

describe.skipIf(!hasPython)("pty", () => {
  it("« /sessions\\r » envoyé d'un bloc exécute la commande, puis « /quit\\r » quitte", async () => {
    const { screen, exited } = await drive([[30, "/sessions\r", "Session de code sur"], [10, "/quit\r", "Sessions de code :"]]);
    expect(screen).toContain("Sessions de code :");
    expect(screen).not.toContain("> /sessions/quit");
    expect(exited).toBe(true);
  }, 70_000);

  it("une ligne tapée pendant « connexion… » part exactement une fois", async () => {
    // 0,3 s : Node démarre à peine, la session n'est pas ouverte ; la ligne attend dans le terminal/Ink puis part.
    const { exited } = await drive([[0.3, "pty-unique\r"], [30, "/quit\r", "Demande-moi par exemple"]], 4); // attend la réponse du tour avant de quitter
    expect(exited).toBe(true);
    const sent = [...mock.state.threads.values()].flatMap((t) => t.turns).filter((t) => t.user === "pty-unique");
    expect(sent).toHaveLength(1);
  }, 70_000);

  it("touche par touche : texte puis Entrée seule", async () => {
    const { screen, exited } = await drive([[30, "/sessions", "Session de code sur"], [0.4, "\r"], [10, "/quit", "Sessions de code :"], [0.4, "\r"]]);
    expect(screen).toContain("Sessions de code :");
    expect(exited).toBe(true);
  }, 70_000);
});
