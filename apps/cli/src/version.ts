import { readFileSync } from "node:fs";

/** Version du client, lue dans `package.json` (repli : 0.0.0). */
export const CLI_VERSION: string = (() => {
  // Binaire autonome : la version est figée à la compilation (`build-bin.sh`), package.json n'est pas embarqué.
  if (process.env.NOKKER_CLI_BUILD_VERSION) return process.env.NOKKER_CLI_BUILD_VERSION;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** -1 / 0 / 1 ; compare les segments numériques (`1.2.10` > `1.2.9`), ignore un suffixe `-pre`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0]!.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split("-")[0]!.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
