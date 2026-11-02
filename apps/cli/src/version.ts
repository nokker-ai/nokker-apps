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

/** Ordre semver complet (préversions comprises) : `0.1.0` > `0.1.0-rc.8.1` > `0.1.0-rc.8` > `0.1.0-rc.7`.
 * Identifiants de préversion séparés par « . » : numériques comparés en nombre et inférieurs aux alphanumériques ;
 * les alphanumériques en ordre naturel (`rc10` > `rc9`) ; à préfixe égal, la liste la plus longue l'emporte. -1 / 0 / 1. */
export function compareSemver(a: string, b: string): number {
  const core = compareVersions(a, b);
  if (core !== 0) return core;
  const pre = (v: string): string[] => {
    const i = v.indexOf("-");
    return i < 0 ? [] : v.slice(i + 1).split("+")[0]!.split(".");
  };
  const pa = pre(a);
  const pb = pre(b);
  if (!pa.length || !pb.length) return pa.length === pb.length ? 0 : pa.length ? -1 : 1; // finale > préversion
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]!;
    const y = pb[i]!;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    let d: number;
    if (nx && ny) d = Number(x) - Number(y);
    else if (nx || ny) d = nx ? -1 : 1;
    else d = x.localeCompare(y, "en", { numeric: true });
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return pa.length === pb.length ? 0 : pa.length < pb.length ? -1 : 1;
}
