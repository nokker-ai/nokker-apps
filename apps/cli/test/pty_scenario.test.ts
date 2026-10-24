/**
 * Pilote pty de mesure (pty_drive.py, mode scénario) contre le mock : « corrige le test » = EXACTEMENT 1 décision (pytest ;
 * le nettoyage `rm -rf build` est couvert par une règle allow posée dans les réglages), jamais de texte parasite
 * (le fil n'a qu'UN tour utilisateur). Détection des cartes par GET /v1/local/approvals, jamais par le tampon cumulé.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
let work: string;
let mock: MockServerHandle;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-cli-scn-"));
  work = join(dir, "projet");
  await mkdir(work);
  await writeFile(join(dir, "settings.json"), JSON.stringify({ permissions: { allow: ["terminal(rm -rf build)"] } }));
  mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: dir });
});
afterAll(async () => {
  await mock.close();
  await rm(dir, { recursive: true, force: true });
});

async function scenario(extra: string[]): Promise<{ cards: Array<{ t: number; tool: string; command: string }>; turns_user: number; duration_s: number; final_text: string; bounded: boolean; error: string | null }> {
  const { stdout } = await run(
    "python3",
    [join(import.meta.dirname, "pty_drive.py"), "--server", mock.url, "--cwd", work, "--config-dir", dir, "--idle", "3", ...extra],
    { timeout: 120_000 },
  );
  return JSON.parse(stdout.trim().split("\n").pop()!);
}

describe.skipIf(!hasPython)("pty_drive.py scénario", () => {
  it("« corrige le test » : 1 décision exactement, 1 seul tour utilisateur", async () => {
    const r = await scenario(["--task", "corrige le test add", "--decide", "1", "--max-decisions", "3"]);
    expect(r.error).toBeNull();
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]).toMatchObject({ tool: "terminal", command: "pytest -q tests/test_add.py" });
    expect(r.bounded).toBe(false);
    expect(r.turns_user).toBe(1);
    expect(r.final_text).toContain("build/");
    // état du mock : un seul tour utilisateur, aucun texte parasite
    const turns = [...mock.state.threads.values()].flatMap((t) => t.turns).filter((t) => t.user.trim());
    expect(turns.map((t) => t.user)).toEqual(["corrige le test add"]);
  }, 130_000);

  it("borne : max-decisions 0 s'arrête sur la première carte sans la décider", async () => {
    const r = await scenario(["--task", "corrige le test sub", "--max-decisions", "0", "--timeout", "60"]);
    expect(r.bounded).toBe(true);
    expect(r.cards).toHaveLength(0);
  }, 130_000);
});
