// Premier lancement (langue autre que l'anglais seulement) : VS Code repère le module linguistique et écrit
// `languagepacks.json` dans le dossier utilisateur ; la langue ne s'applique qu'au lancement suivant.
const { existsSync } = require("node:fs");
const { join } = require("node:path");

exports.run = async function run() {
  const file = join(process.env.NOKKER_E2E_USER_DIR, "languagepacks.json");
  for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(file)) throw new Error(`module linguistique non repéré (${file})`);
};
