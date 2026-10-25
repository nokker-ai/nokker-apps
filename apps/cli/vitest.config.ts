import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    testTimeout: 30_000,
    // Les tests historiques vérifient les libellés français : la suite tourne en français (les processus lancés par les
    // tests en héritent), les tests de l'anglais (langue par défaut) posent `setLang("en")` ou `NOKKER_LANG=en`.
    env: { NOKKER_LANG: "fr" },
  },
});
