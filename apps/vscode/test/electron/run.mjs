// Essai dans un vrai VS Code (@vscode/test-electron), sans écran : `xvfb-run -a node test/electron/run.mjs`.
// Démarre le mock-server, un dossier de travail et un dossier de config jetables, puis lance VS Code avec l'extension
// en développement. Télécharge VS Code dans .vscode-test/ au premier lancement (version : $NOKKER_VSCODE_VERSION ou stable).
import { register } from "tsx/esm/api";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

register();
const { startMockServer } = await import("@nokker-apps/mock-server");
const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..", "..");
const dir = await mkdtemp(join(tmpdir(), "nokker-vscode-e2e-"));
const proj = join(dir, "projets", "calc");
await mkdir(join(proj, "src"), { recursive: true });
await writeFile(join(proj, "src", "app.py"), "def add(a, b):\n    return a - b\n");
const config = join(dir, "config");
// Écritures réelles : le patch du scénario modifie src/app.py et les points de retour photographient le dossier.
const mock = await startMockServer({ port: 0, seed: false, speed: 0.02, configDir: config, localRoots: [join(dir, "projets")], localWrites: true });
// `NOKKER_E2E_LOCALE=fr` : VS Code en français (libellés de l'extension par son paquet l10n).
const locale = process.env.NOKKER_E2E_LOCALE || "";
let code = 0;
try {
  const version = process.env.NOKKER_VSCODE_VERSION || "stable";
  if (locale) {
    await runTests({
      version,
      extensionDevelopmentPath: ext,
      extensionTestsPath: join(here, "warmup.cjs"),
      launchArgs: [proj, "--no-sandbox", "--disable-gpu", "--disable-workspace-trust", `--user-data-dir=${join(dir, "user")}`, `--extensions-dir=${join(ext, ".vscode-test", `extensions-${locale}`)}`],
      extensionTestsEnv: { NOKKER_E2E_USER_DIR: join(dir, "user"), NOKKER_SERVER_URL: mock.url, NOKKER_CONFIG_DIR_OVERRIDE: config },
    });
  }
  await runTests({
    version,
    extensionDevelopmentPath: ext,
    extensionTestsPath: join(here, "suite.cjs"),
    launchArgs: [
      proj,
      ...(locale ? [] : ["--disable-extensions"]),
      "--no-sandbox",
      "--disable-gpu",
      "--disable-workspace-trust",
      `--user-data-dir=${join(dir, "user")}`,
      // Une langue autre que l'anglais demande son module linguistique (installé une fois dans
      // .vscode-test/extensions-<langue>, voir le README) ; sans lui, VS Code reste en anglais.
      ...(locale ? [`--locale=${locale}`, `--extensions-dir=${join(ext, ".vscode-test", `extensions-${locale}`)}`] : []),
    ],
    extensionTestsEnv: {
      NOKKER_CONFIG_DIR_OVERRIDE: config,
      NOKKER_SERVER_URL: mock.url,
      NOKKER_E2E_PROJ: proj,
      NOKKER_E2E_SHOT: process.env.NOKKER_E2E_SHOT ?? "",
      NOKKER_E2E_LOCALE: locale,
    },
  });
} catch (err) {
  console.error(`échec : ${err instanceof Error ? err.message : String(err)}`);
  code = 1;
} finally {
  await mock.close();
  await rm(dir, { recursive: true, force: true });
}
process.exit(code);
