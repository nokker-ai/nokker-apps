#!/usr/bin/env node
// Lanceur dev de la CLI (exécute src/bin.ts via tsx, pas de build préalable nécessaire).
// `pnpm build` (tsc) reste nécessaire pour un futur empaquetage compilé — ce lanceur-ci est le
// chemin court pour développer/tester (`pnpm --filter @nokker-apps/cli start`) et pour la démo
// non interactive (`nokker -p "…"`).
//
// `tsx/esm/api` expose directement une fonction `register()` qui s'enregistre elle-même (API conçue
// pour ça) — PAS un spécificateur à passer à `node:module` `register()` (qui attend l'entrée loader
// `tsx/esm`, dépréciée par Node ≥ 20.6 et refusée par tsx ≥ 4.20 : « must be loaded with --import »).
// Constaté en écrivant la démo non interactive (tsx 4.23.15) — avant ce correctif, `nokker.mjs` ne
// démarrait jamais, en interactif comme en mode `-p`.
import { register } from "tsx/esm/api";

register();
await import(new URL("../src/bin.ts", import.meta.url));
