// Paquet .vsix LOCAL (aucune publication : Marketplace et Open VSX attendent la décision D2). Construit en mode prod,
// copie la licence de la racine, puis `vsce package --no-dependencies` (tout est déjà empaqueté dans dist/).
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version, name } = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
execFileSync(process.execPath, [join(root, "scripts/build.mjs"), "--prod"], { stdio: "inherit" });
copyFileSync(join(root, "../../LICENSE"), join(root, "LICENSE"));
const vsce = createRequire(import.meta.url).resolve("@vscode/vsce/vsce");
const out = join(root, `${name}-${version}.vsix`);
execFileSync(process.execPath, [vsce, "package", "--no-dependencies", "--out", out], { cwd: root, stdio: "inherit" });
console.log(`paquet : ${out}`);
