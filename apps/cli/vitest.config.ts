import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Runner de test partagé (conteneur borné à 8 cœurs / 8 Go sans swap) : 4 workers au plus, en forks comme en threads.
    poolOptions: { forks: { maxForks: 4, minForks: 1 }, threads: { maxThreads: 4, minThreads: 1 } },
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    testTimeout: 30_000,
    // La suite tourne en anglais, la langue par défaut (les processus lancés par les tests en héritent) ; les tests du
    // français posent `setLang("fr")` ou `NOKKER_LANG=fr`.
    env: { NOKKER_LANG: "en" },
  },
});
