/**
 * Import d'un autre agent (lot 30), comme le noyau : `/v1/local/import/scan|apply` (jeton local, 403 par la
 * passerelle) et `GET /v1/local/import/report` (dernier rapport de la commande lancée sur l'hôte). Rapports de
 * démonstration, sans aucune valeur de secret ; `apply` reprend le prévu, jamais un serveur MCP.
 */
import type { ImportedMemoryEntry, ImportItem, ImportReport, ImportSource } from "@nokker-apps/sdk";
import { LOCAL_OWNER, type MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;
const SOURCES: ImportSource[] = ["claude-code", "codex", "cursor", "hermes", "openclaw"];

const CODES: [string, string][] = [["réunies dans NOKKER.md", "rules_to_nokker_md"], ["note de mémoire", "user_note"], ["ajout après confirmation", "mcp_confirm"], ["serveur stdio", "mcp_stdio"], ["valeur jamais copiée", "secret_name_only"], ["Aucune étape", "unread_path"], ["prompt personnalisé repris", "prompt_as_skill"], ["mémoire générée par le modèle", "codex_memory_generated"], ["à ajouter dans une session", "mcp_in_session"]];
const codeOf = (reason: string): string => (reason ? (CODES.find(([f]) => reason.includes(f))?.[1] ?? "other") : "");
const it = (kind: string, source: string, target: string | null, status: ImportItem["status"], reason: string, detail: Record<string, unknown> = {}): ImportItem => ({ kind, source, target, status, reason, code: codeOf(reason), detail });

function demo(source: ImportSource): ImportReport {
  const items: ImportItem[] =
    source === "cursor"
      ? [it("rules", "/work/repo/.cursorrules", "/work/repo/NOKKER.md", "planned", "réunies dans NOKKER.md, lu par Nokker comme mémoire de projet")]
      : [
          it("user-note", `~/.${source}/SOUL.md#Style`, "memory:user", "planned", "note de mémoire de portée utilisateur (rappelée dans tous les fils)", { title: "Style", text: "Réponds court, en français." }),
          it("skill", `~/.${source}/skills/pdf`, `~/.nokker/skills/${source}/pdf`, "planned", "", { name: "pdf", description: "Lire et remplir des PDF" }),
          it("mcp", `~/.${source}.json#mcpServers.docs`, "mcp-servers", "planned", "ajout après confirmation, serveur par serveur ; à poser ensuite : nokker secret set MCP_DOCS_TOKEN", {
            name: "docs",
            entry: { name: "docs", url: "https://mcp.example.org/mcp", token: "secret:MCP_DOCS_TOKEN" },
            secret_names: ["MCP_DOCS_TOKEN"],
          }),
          it("mcp", `~/.${source}.json#mcpServers.fs`, null, "unsupported", "serveur stdio (commande lancée sur l'hôte) : pas d'équivalent dans Nokker"),
          it("secret-name", `~/.${source}/.env#OPENAI_API_KEY`, null, "skipped", "valeur jamais copiée : à ressaisir dans le coffre de Nokker si c'est un secret"),
          ...(source === "codex"
            ? [
                it("prompt", "~/.codex/prompts/review.md", "~/.nokker/skills/codex/review", "planned", "prompt personnalisé repris comme skill (Codex ne les lit plus)", { name: "review" }),
                it("codex-memory", "~/.codex/memories_v2/memory_summary.md", null, "skipped", "mémoire générée par le modèle de Codex à partir des conversations : montrée ici, pas reprise sans décision", { version: "v2" }),
              ]
            : []),
          it("unaccounted-source", `~/.${source}/plugins`, null, "unsupported", "Aucune étape de cet importeur ne lit ce chemin.", { files: 3 }),
        ];
  return withCounts({ origin: source, counts: {} as ImportReport["counts"], items });
}

function withCounts(r: ImportReport): ImportReport {
  const counts = { planned: 0, imported: 0, native: 0, skipped: 0, unsupported: 0, conflict: 0, error: 0 };
  for (const i of r.items) counts[i.status] += 1;
  return { ...r, counts };
}

export async function handleImport(state: MockState, user: string | null, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send, relayed = false): Promise<boolean> {
  const bare = path.split("?", 1)[0]!;
  if (!bare.startsWith("/v1/local/import/")) return false;
  if (user !== LOCAL_OWNER) return send(401, { error: { message: "jeton local requis" } }), true;
  if (relayed) return send(403, { error: { message: "import : sur la machine seulement (jeton local)" } }), true;
  const st = state as MockState & { importReports?: ImportReport[] };
  if (method === "GET" && bare === "/v1/local/import/report") {
    const src = new URLSearchParams(path.split("?", 2)[1] ?? "").get("source");
    const found = [...(st.importReports ?? [])].reverse().find((r) => !src || r.origin === src);
    return found ? send(200, found) : send(404, { error: { message: "aucun rapport d'import", code: "not_found" } }), true;
  }
  // Mémoire importée (Codex) gardée comme données (noyau lot 30 d). `MOCK_IMPORT_MEMORY=off` : drapeau éteint (404).
  if (bare === "/v1/local/import/memory" || bare.startsWith("/v1/local/import/memory/") || bare === "/v1/local/import/undo") {
    if (process.env.MOCK_IMPORT_MEMORY === "off") return send(404, { error: { message: "mémoire importée désactivée", code: "import_memory_off" } }), true;
    const mem = st as MockState & { importedMemory?: ImportedMemoryEntry[] };
    mem.importedMemory ??= [
      { name: "codex-2026-10-30-projets-site-boulangerie-a1b2c3", title: "Projets : Travaille sur le site de la boulangerie (Astro).", text: "Travaille sur le site de la boulangerie (Astro).", date: "2026-10-30", source: "codex" },
      { name: "codex-2026-10-28-memoire-codex-prefere-pytest-d4e5f6", title: "Mémoire Codex : Préfère pytest à unittest.", text: "Préfère pytest à unittest.", date: "2026-10-28", source: "codex" },
      { name: "codex-2026-10-28-memoire-codex-toujours-repondre-0a9b8c", title: "Mémoire Codex : Toujours répondre en anglais.", text: "Toujours répondre en anglais.", date: "2026-10-28", source: "codex" },
    ];
    if (method === "GET" && bare === "/v1/local/import/memory") return send(200, { entries: mem.importedMemory }), true;
    if (method === "POST" && bare === "/v1/local/import/undo") {
      const b = await readBody();
      if (b.source !== "codex" || b.what !== "memory") return send(400, { error: { message: "corps {source, what, name?}", code: "bad_body" } }), true;
      const before = mem.importedMemory.length;
      mem.importedMemory = b.name ? mem.importedMemory.filter((e) => e.name !== b.name) : [];
      const undone = before - mem.importedMemory.length;
      return b.name && !undone ? send(404, { error: { message: "entrée inconnue", code: "not_found" } }) : send(200, { undone }), true;
    }
    const pr = /^\/v1\/local\/import\/memory\/([^/]+)\/promote$/.exec(bare);
    if (method === "POST" && pr) {
      const e = mem.importedMemory.find((x) => x.name === pr[1]);
      if (!e) return send(404, { error: { message: "entrée inconnue", code: "not_found" } }), true;
      mem.importedMemory = mem.importedMemory.filter((x) => x !== e);
      return send(200, { note: { name: `fact-${e.name.slice(17)}`, title: e.title, scope: "user" } }), true;
    }
    return false;
  }
  if (method !== "POST" || (bare !== "/v1/local/import/scan" && bare !== "/v1/local/import/apply")) return false;
  const body = await readBody();
  const source = String(body.source ?? "") as ImportSource;
  if (!SOURCES.includes(source)) return send(400, { error: { message: "source ∈ claude-code, cursor, hermes, openclaw", code: "bad_body" } }), true;
  const r = demo(source);
  if (bare.endsWith("/apply")) {
    for (const i of r.items) {
      if (i.status !== "planned") continue;
      if (i.kind === "mcp") Object.assign(i, { status: "skipped", reason: "à ajouter dans une session : Nina le propose, vous signez la carte forte", code: "mcp_in_session" });
      else i.status = "imported";
    }
    const done = withCounts(r);
    st.importReports = [...(st.importReports ?? []), { ...done, dir: `${source}-demo` }];
    return send(200, done), true;
  }
  return send(200, r), true;
}
