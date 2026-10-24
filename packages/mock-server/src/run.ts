/**
 * Lanceur dev du mock-server (`pnpm --filter @nokker-apps/mock-server dev`).
 * Port fixe par défaut 4310 — vérifier `ss -ltnp` avant de le changer (consigne de la machine hôte).
 */
import { MOCK_TOTP_CODE, defaultConfigDir, startMockServer } from "./index.js";
import { BRAND } from "@nokker-apps/brand";

const port = Number(process.env.MOCK_PORT ?? process.env.PORT ?? 4310);
const configDir = defaultConfigDir();

startMockServer({ port, configDir })
  .then((handle) => {
    // eslint-disable-next-line no-console
    console.log(`${BRAND.appName} — mock-server sur ${handle.url}`);
    // eslint-disable-next-line no-console
    console.log(`  Jeton local écrit dans ${configDir}/local-token ; réglages dans ${configDir}/settings.json`);
    // eslint-disable-next-line no-console
    console.log(`  TOTP de démo (niveau standard uniquement) : ${MOCK_TOTP_CODE}`);
    // eslint-disable-next-line no-console
    console.log(`  Démo bulles : « disque », « cherche … », « timer 5 min », « lance le backup », « montre la vidéo »,`);
    // eslint-disable-next-line no-console
    console.log(`  « crée un agent qui … », « envoie la bulle disque à Infra » ; Compta notifie ~12 s après la 1re connexion.`);
    // eslint-disable-next-line no-console
    console.log(`  Ctrl+C pour arrêter (PID ${process.pid}).`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("mock-server: échec du démarrage", err);
    process.exit(1);
  });

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
