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
    console.log(`${BRAND.appName} — mock-server on ${handle.url}`);
    // eslint-disable-next-line no-console
    console.log(`  Local token written to ${configDir}/local-token; settings in ${configDir}/settings.json`);
    // eslint-disable-next-line no-console
    console.log(`  Demo TOTP (standard level only): ${MOCK_TOTP_CODE}`);
    // eslint-disable-next-line no-console
    console.log(`  Bubble demo: “disk”, “search …”, “timer 5 min”, “run the backup”, “show the video”,`);
    // eslint-disable-next-line no-console
    console.log(`  “create an agent that …”, “send the disk bubble to Infra”; Accounting notifies ~12 s after the first connection.`);
    // eslint-disable-next-line no-console
    console.log(`  Ctrl+C to stop (PID ${process.pid}).`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("mock-server: failed to start", err);
    process.exit(1);
  });

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
