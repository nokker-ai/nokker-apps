/** Liens des sites connectés servis par le web (CONNECTED-SITES §15) — module léger, lu par main.tsx au démarrage. */
const ID = /^[A-Za-z0-9_-]{6,128}$/;
/** `/sites/r/<rid>` → rid ; `/sites/h/<jeton>` → jeton ; sinon null. */
export function sitesLink(path: string): { kind: "request" | "handoff"; id: string } | null {
  const m = /^\/sites\/(r|h)\/([^/]+)\/?$/.exec(path);
  if (!m || !ID.test(m[2]!)) return null;
  return { kind: m[1] === "r" ? "request" : "handoff", id: m[2]! };
}
