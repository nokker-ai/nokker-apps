import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    testTimeout: 30_000,
    // La suite tourne en anglais, la langue par défaut (les processus lancés par les tests en héritent) ; les tests du
    // français posent `setLang("fr")` ou `NOKKER_LANG=fr`.
    env: { NOKKER_LANG: "en" },
  },
});
