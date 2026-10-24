import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// En dev, le navigateur parle à Vite (même origine) qui relaie /v1 et /healthz vers le mock-server resté en
// loopback (127.0.0.1:4310) : rien d'autre à exposer sur le réseau, et SSE passe tel quel par le proxy.
const target = process.env.NOKKER_SERVER_URL ?? "http://127.0.0.1:4310";

/** Le kit de marque vit UNE fois dans `packages/brand/assets/` ; servi sous `/brand/*` en dev et copié dans le
 * build (favicon, icônes d'app du manifest, emblèmes) — pas de copie du kit dans `apps/web`. */
function brandAssets(): Plugin {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/brand/assets");
  const types: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
  const walk = (d: string, base = ""): string[] =>
    readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f), `${base}${f}/`) : [`${base}${f}`]));
  return {
    name: "nokker-brand-assets",
    configureServer(server) {
      server.middlewares.use("/brand/", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]!.replace(/^\//, ""));
        if (rel.includes("..")) return next();
        try {
          const body = readFileSync(join(dir, rel));
          res.setHeader("Content-Type", types[extname(rel)] ?? "application/octet-stream");
          res.setHeader("Cache-Control", "public, max-age=3600");
          res.end(body);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const f of walk(dir)) this.emitFile({ type: "asset", fileName: `brand/${f}`, source: readFileSync(join(dir, f)) });
    },
  };
}

/** Pose dans dist/sw.js un identifiant de build dérivé des noms d'assets (hachés) : le sw change si et seulement si
 * le contenu déployé change. */
function swBuildId(): Plugin {
  let outDir = "dist";
  return {
    name: "nokker-sw-build-id",
    apply: "build",
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const id = createHash("sha256").update(walkNames(join(outDir, "assets")).join("\n")).digest("hex").slice(0, 12);
      const sw = join(outDir, "sw.js");
      writeFileSync(sw, readFileSync(sw, "utf8").replaceAll("__BUILD_ID__", id));
    },
  };
}
const walkNames = (d: string): string[] => readdirSync(d).filter((f) => !f.endsWith(".map")).sort();

export default defineConfig({
  plugins: [react(), brandAssets(), swBuildId()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/v1": { target, changeOrigin: true },
      "/healthz": { target, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
