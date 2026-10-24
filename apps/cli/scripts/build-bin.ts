// Compile le client en binaire autonome (bun --compile). Appelé par build-bin.sh :
//   bun scripts/build-bin.ts <os-arch> <version> <outfile>
// `react-devtools-core` (import statique d'Ink, utilisé seulement avec DEV=true) est remplacé par un module vide.
import type { BunPlugin } from "bun";

const [target, version, outfile] = process.argv.slice(2);
if (!target || !version || !outfile) {
  console.error("usage: bun scripts/build-bin.ts <linux-x64|...> <version> <outfile>");
  process.exit(2);
}

const stubDevtools: BunPlugin = {
  name: "stub-react-devtools-core",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default { connectToDevTools() {} };", loader: "js" }));
  },
};

const result = await Bun.build({
  entrypoints: [new URL("../src/bin.ts", import.meta.url).pathname],
  compile: { target: `bun-${target}` as never, outfile },
  define: { "process.env.NOKKER_CLI_BUILD_VERSION": JSON.stringify(version) },
  plugins: [stubDevtools],
});
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}
