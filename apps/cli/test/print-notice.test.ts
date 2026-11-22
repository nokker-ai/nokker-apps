import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NokkerClient } from "@nokker-apps/sdk";
import { startMockServer } from "@nokker-apps/mock-server";
import { connect } from "../src/auth.js";
import { runPrint } from "../src/headless.js";

describe("nokker -p : dossier hors des racines du serveur", () => {
  it("le dit (notice, sur stderr côté bin) au lieu de tomber en silence dans un fil ordinaire", async () => {
    const d = await mkdtemp(join(tmpdir(), "nokker-cli-roots-"));
    const keep = process.env.NOKKER_CONFIG_DIR_OVERRIDE;
    process.env.NOKKER_CONFIG_DIR_OVERRIDE = d;
    const m = await startMockServer({ port: 0, seed: false, speed: 0.01, localRoots: ["/srv/racine"] });
    try {
      const c = new NokkerClient({ baseUrl: m.url });
      const conn = await connect(c, m.url, "batch");
      const outside = await runPrint("bonjour", c, conn, "/home/x/nokker/calc");
      expect(outside.cwd).toBeNull(); // fil ordinaire…
      expect(outside.notice).toContain("Folder outside the roots declared by the server: /home/x/nokker/calc");
      expect(outside.notice).toContain("Plain thread opened instead");
      const inside = await runPrint("bonjour", c, conn, "/srv/racine/calc");
      expect(inside.cwd).toBe("/srv/racine/calc");
      expect(inside.notice).toBeUndefined();
    } finally {
      await m.close();
      if (keep === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
      else process.env.NOKKER_CONFIG_DIR_OVERRIDE = keep;
      await rm(d, { recursive: true, force: true });
    }
  });
});
