// Paquet .vsix LOCAL : aucune publication. Le Visual Studio Marketplace et Open VSX attendent une décision et un compte
// d'éditeur (D2) ; ce script ne contacte aucun des deux. Construit en mode prod, copie la licence de la racine, puis
// `vsce package --no-dependencies` (tout est déjà empaqueté dans dist/).
//
// `--check` (essai à blanc de la publication) : après le paquet, relit le .vsix et vérifie ce que les deux registres
// exigent, sans réseau ni jeton :
//   - Marketplace : les contrôles de `vsce package` (manifeste, icône, liens du README…), puis contenu du paquet
//     (seulement dist/, media/, l10n/, manifeste et textes : ni sources, ni cartes de sources, ni node_modules),
//     icône PNG d'au moins 128 px, `engines.vscode` aligné sur `@types/vscode`, aucune dépendance d'exécution,
//     aucune activation `*` ;
//   - Open VSX : `ovsx publish` n'a pas de mode à blanc (il emballe puis envoie) ; ses contrôles avant l'envoi sont
//     refaits ici à l'identique (ovsx 1.2.0 : `validateManifest` = `publisher`, `name`, `version` ; `isLicenseOk` =
//     champ `license` ou fichier LICENSE dans le paquet).
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const { version, name } = pkg;
execFileSync(process.execPath, [join(root, "scripts/build.mjs"), "--prod"], { stdio: "inherit" });
copyFileSync(join(root, "../../LICENSE"), join(root, "LICENSE"));
const require = createRequire(import.meta.url);
const vsce = require.resolve("@vscode/vsce/vsce");
const out = join(root, `${name}-${version}.vsix`);
execFileSync(process.execPath, [vsce, "package", "--no-dependencies", "--out", out], { cwd: root, stdio: "inherit" });
console.log(`paquet : ${out}`);

if (check) {
  const { readZip } = require(join(dirname(vsce), "out", "zip.js"));
  const entries = await readZip(out, () => true);
  const files = [...entries.keys()].filter((f) => f.startsWith("extension/")).map((f) => f.slice("extension/".length)).sort();
  const errors = [];
  // vsce range README, CHANGELOG et LICENSE sous `readme.md`, `changelog.md`, `license.txt`.
  const allowed = /^(package\.json|package\.nls(\.[a-z-]+)?\.json|readme\.md|changelog\.md|license(\.txt)?|dist\/(extension\.cjs|webview\.js)|media\/[\w.-]+\.(css|svg|png)|l10n\/bundle\.l10n\.[a-z-]+\.json)$/i;
  for (const f of files) if (!allowed.test(f)) errors.push(`fichier inattendu dans le paquet : ${f}`);
  const has = (f) => files.some((x) => x.toLowerCase() === f.toLowerCase());
  for (const f of ["package.json", "package.nls.json", "package.nls.fr.json", "readme.md", "changelog.md", "license.txt", "dist/extension.cjs", "dist/webview.js", "media/icon.png", "l10n/bundle.l10n.fr.json"]) {
    if (!has(f)) errors.push(`absent du paquet : ${f}`);
  }
  const manifest = JSON.parse(entries.get("extension/package.json").toString("utf-8"));
  // Open VSX (ovsx 1.2.0, validateManifest + isLicenseOk).
  for (const field of ["publisher", "name", "version"]) if (!manifest[field]) errors.push(`Open VSX : champ requis absent : ${field}`);
  if (!manifest.license && !files.some((f) => /^license(\.(md|txt))?$/i.test(f))) errors.push("Open VSX : ni champ license ni fichier LICENSE");
  // Marketplace.
  if (!manifest.repository?.url) errors.push("manifeste : repository absent");
  if (!manifest.icon) errors.push("manifeste : icon absent");
  if (manifest.dependencies && Object.keys(manifest.dependencies).length) errors.push(`dépendances d'exécution : ${Object.keys(manifest.dependencies).join(", ")}`);
  if ((manifest.activationEvents ?? []).includes("*")) errors.push("activation « * » (au démarrage, sans condition)");
  if (manifest.enabledApiProposals) errors.push("API proposées : refusées par le Marketplace");
  const typesVersion = JSON.parse(readFileSync(require.resolve("@types/vscode/package.json"), "utf-8")).version;
  if (manifest.engines?.vscode !== `^${typesVersion}`) errors.push(`engines.vscode (${manifest.engines?.vscode}) ≠ ^@types/vscode (${typesVersion})`);
  const icon = entries.get(`extension/${manifest.icon}`);
  if (icon) {
    const png = icon.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const w = icon.readUInt32BE(16);
    const h = icon.readUInt32BE(20);
    if (!png || w < 128 || h < 128 || w !== h) errors.push(`icône : PNG carré d'au moins 128 px attendu (${png ? `${w}×${h}` : "pas un PNG"})`);
  }
  const size = statSync(out).size;
  if (size > 5 * 1024 * 1024) errors.push(`paquet trop gros : ${size} octets`);
  console.log(`\nessai à blanc (rien n'est publié) — ${files.length} fichiers, ${(size / 1024).toFixed(0)} Kio :`);
  for (const f of files) console.log(`  ${f}`);
  if (errors.length) {
    console.error(`\n${errors.length} problème(s) :\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    process.exit(1);
  }
  console.log("\nprêt pour le Marketplace et Open VSX (publication : décision D2, compte d'éditeur requis — non faite ici).");
}
