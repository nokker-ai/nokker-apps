// Construit dist/extension.cjs (Node, CommonJS, `vscode` externe) et dist/webview.js (navigateur, IIFE), puis copie
// l'icône de la marque. Aucune dépendance d'exécution : le SDK et le code partagé avec la CLI sont empaquetés.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const prod = process.argv.includes("--prod");
mkdirSync(join(root, "dist"), { recursive: true });
const common = { bundle: true, sourcemap: !prod, minify: prod, legalComments: "none", logLevel: "warning" };
await build({
  ...common,
  entryPoints: [join(root, "src/extension.ts")],
  outfile: join(root, "dist/extension.cjs"),
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
});
await build({
  ...common,
  entryPoints: [join(root, "src/webview/main.ts")],
  outfile: join(root, "dist/webview.js"),
  platform: "browser",
  format: "iife",
  target: "es2022",
});
copyFileSync(join(root, "../../packages/brand/assets/icon/nokker-app-192.png"), join(root, "media/icon.png"));
