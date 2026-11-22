import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Runner de test partagé (conteneur borné à 8 cœurs / 8 Go sans swap) : 4 workers au plus, en forks comme en threads.
    poolOptions: { forks: { maxForks: 4, minForks: 1 }, threads: { maxThreads: 4, minThreads: 1 } },
    include: ["test/unit/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
