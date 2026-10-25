/**
 * `nokker acp` — pont Agent Client Protocol (v1, JSON-RPC sur stdio) vers l'API locale du noyau (LOKKAL.md §7.4).
 * Un éditeur ACP (Zed, JetBrains, Neovim…) lance ce processus ; chaque session ACP est une session de code locale
 * du dossier de l'éditeur. La logique de tour est celle de `EditorSession` (SDK), partagée avec l'extension VS Code.
 *
 * Correspondances :
 * - `session/new {cwd}` → `POST /v1/local/sessions {cwd}` (fil neuf) ; `session/load` reprend un fil local et rejoue
 *   son historique ; `session/list` → `GET /v1/local/sessions` ;
 * - `session/prompt` → `POST /v1/chat/completions` en flux ; texte → `agent_message_chunk`, `tool.call`/`tool.result`
 *   → `tool_call`/`tool_call_update` (effet en `kind`, diff des patchs en contenu `diff`) ;
 * - carte d'approbation → `session/request_permission` (une fois / pour la session / toujours / refuser), décidée par
 *   `POST /v1/local/approvals/{id}/decide` ; une carte FORTE n'est pas proposée : l'appel dit où elle attend (le
 *   téléphone si le noyau l'a déposée chez nokker.ai, sinon le terminal `nokker`) ;
 * - `session/cancel` → `POST /v1/threads/{id}/cancel`, réponse `stopReason: "cancelled"` ;
 * - `/cost`, `/diff`, `/plan`, `/checkpoints` : sans tour modèle (`GET /v1/local/cost`, `POST /v1/local/tools/call`).
 */
import {
  EditorSession,
  LocalEventHub,
  NokkerApiError,
  formatCostLine,
  hostPathOf,
  parseToolJson,
  strongCardText,
  type ChatAttachment,
  type CheckpointDiff,
  type CheckpointInfo,
  type EditorApprovalCard,
  type EditorDiff,
  type EditorFs,
  type EditorToolCall,
  type LocalChoice,
  type NokkerClient,
  type TodoResult,
  type TurnCostEvent,
} from "@nokker-apps/sdk";
import { RPC, RpcFailure, type JsonRpcId, type RpcPeer } from "./rpc.js";

/** Version du protocole ACP parlée ici (schéma v1 du SDK officiel `@agentclientprotocol/sdk`, entrée stable). */
export const ACP_PROTOCOL_VERSION = 1;

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string | null }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string | null }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string | null } };

type PermissionOutcome = { outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } };

export interface AcpAgentDeps {
  peer: RpcPeer;
  /** Client authentifié (jeton local) : appelé à la première session, pour qu'`initialize` marche noyau éteint. */
  connect: () => Promise<NokkerClient>;
  fs: EditorFs;
  version: string;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  /** Ligne de coût sous chaque tour (défaut : oui). */
  costLine?: boolean;
}

const COMMANDS = [
  { name: "cost", description: "Coût de la session et du jour (sans appel modèle)" },
  { name: "diff", description: "Diff depuis le dernier point de retour (sans appel modèle)" },
  { name: "plan", description: "Plan du fil (sans appel modèle)" },
  { name: "checkpoints", description: "Points de retour du fil (sans appel modèle)" },
] as const;

const MAX_IMAGES = 4;

export function toolKind(name: string, effect: string | null): string {
  if (name === "read_file" || name === "skill_view" || name === "checkpoint_list") return "read";
  if (name === "search_files") return "search";
  if (name === "write_file" || name === "patch" || name === "checkpoint_restore") return "edit";
  if (name === "terminal" || name.startsWith("process_")) return "execute";
  if (name === "web_fetch" || name === "web_search") return "fetch";
  if (name === "delegate" || name === "todo") return "think";
  if (effect === "read") return "read";
  if (effect === "write") return "edit";
  return "other";
}

export function toolTitle(name: string, args: Record<string, unknown>, cwd: string): string {
  if (name === "terminal" && typeof args.command === "string") return `terminal : ${args.command}`;
  for (const key of ["path", "pattern", "query", "url", "goal"]) {
    const v = args[key];
    if (typeof v === "string" && v) {
      const host = key === "path" ? hostPathOf(v, cwd) : null;
      const shown = host ? host.slice(cwd.replace(/[\\/]+$/, "").length + 1) || v : v;
      return `${name} ${shown.length > 120 ? `${shown.slice(0, 120)}…` : shown}`;
    }
  }
  return name;
}

/** Contenu ACP → texte du tour + pièces jointes (LOKKAL.md §7.6). Les fichiers cités restent des chemins : le noyau les lit
 * dans le dossier de la session. */
export function promptToRequest(blocks: ContentBlock[], cwd: string): { text: string; attachments: ChatAttachment[] } {
  const parts: string[] = [];
  const attachments: ChatAttachment[] = [];
  let images = 0;
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "image") {
      images += 1;
      attachments.push({ data: b.data, media_type: b.mimeType, name: `image-${images}.${(b.mimeType.split("/")[1] ?? "png").replace("jpeg", "jpg")}` });
    } else if (b.type === "resource_link") {
      const rel = relFromUri(b.uri, cwd);
      if (rel && /^image\//.test(b.mimeType ?? "")) {
        images += 1;
        attachments.push({ path: rel });
      } else parts.push(rel ? `@${rel}` : b.uri);
    } else if (b.type === "resource") {
      const r = b.resource;
      const label = relFromUri(r.uri, cwd) ?? r.uri;
      if (typeof r.text === "string") parts.push(`\n${label} :\n\`\`\`\n${r.text}\n\`\`\`\n`);
      else if (typeof r.blob === "string" && /^image\//.test(r.mimeType ?? "")) {
        images += 1;
        attachments.push({ data: r.blob, media_type: r.mimeType ?? undefined, name: label.split(/[\\/]/).pop() ?? "image" });
      } else parts.push(label);
    }
  }
  if (images > MAX_IMAGES) throw new RpcFailure(RPC.invalidParams, `${MAX_IMAGES} images au plus par message`);
  return { text: parts.join(" ").replace(/ \n/g, "\n").trim(), attachments };
}

/** `file:///…/src/a.py#L10:20` → `src/a.py#L10:20` s'il est sous `cwd`, sinon `null`. */
export function relFromUri(uri: string, cwd: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let path: string;
  let frag = "";
  try {
    const u = new URL(uri);
    path = decodeURIComponent(u.pathname);
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    frag = u.hash;
  } catch {
    return null;
  }
  const host = hostPathOf(path, cwd);
  if (!host) return null;
  return host.slice(cwd.replace(/[\\/]+$/, "").length + 1) + frag;
}

function diffContent(d: EditorDiff): Record<string, unknown> {
  return { type: "diff", path: d.path, oldText: d.oldText, newText: d.newText };
}

function textContent(text: string): Record<string, unknown> {
  return { type: "content", content: { type: "text", text } };
}

function apiFailure(err: unknown, cwd?: string): RpcFailure {
  if (err instanceof RpcFailure) return err;
  if (err instanceof NokkerApiError) {
    let msg = err.serverMessage;
    if (typeof err.body === "string") {
      try {
        const m = (JSON.parse(err.body) as { error?: { message?: string } }).error?.message;
        if (m) msg = m;
      } catch {
        // corps non JSON
      }
    }
    if (err.status === 401) return new RpcFailure(RPC.authRequired, "jeton local refusé par le noyau (nokker doctor)");
    if (err.status === 403 && cwd) return new RpcFailure(RPC.invalidParams, `dossier hors des racines déclarées de Lokkal : ${cwd} (${msg})`);
    if (err.status === 404) return new RpcFailure(RPC.resourceNotFound, msg);
    if (err.status === 400) return new RpcFailure(RPC.invalidParams, msg);
    return new RpcFailure(RPC.internalError, msg);
  }
  const m = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/.test(m)) return new RpcFailure(RPC.internalError, "noyau injoignable (Lokkal tourne-t-il ? nokker doctor)");
  return new RpcFailure(RPC.internalError, m);
}

interface AcpSession {
  core: EditorSession;
  /** Requêtes `session/request_permission` en cours, par carte. */
  permissionRequests: Map<string, JsonRpcId>;
  /** Appels d'outil synthétiques (carte sans appel connu). */
  announced: Set<string>;
  /** Cartes fortes montrées, par carte : l'appel qui porte le texte « où elle attend ». */
  strongCalls: Map<string, string>;
  cancelling: boolean;
}

export class AcpAgent {
  private client: NokkerClient | null = null;
  private hub: LocalEventHub | null = null;
  private sessions = new Map<string, AcpSession>();

  constructor(private readonly deps: AcpAgentDeps) {
    const p = deps.peer;
    p.onRequest("initialize", (params) => this.initialize(params));
    p.onRequest("authenticate", async () => ({}));
    p.onRequest("session/new", (params) => this.newSession(params));
    p.onRequest("session/load", (params) => this.loadSession(params));
    p.onRequest("session/list", (params) => this.listSessions(params));
    p.onRequest("session/prompt", (params) => this.prompt(params));
    p.onNotification("session/cancel", (params) => this.cancel(params));
  }

  dispose(): void {
    for (const s of this.sessions.values()) s.core.dispose();
    this.hub?.close();
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    this.deps.log?.(level, `acp : ${msg}`);
  }

  private async initialize(params: unknown): Promise<unknown> {
    const asked = (params as { protocolVersion?: unknown })?.protocolVersion;
    this.log("info", `initialize (client v${String(asked)})`);
    return {
      // L'agent répond par la version la plus récente qu'il parle ; le client se déconnecte s'il ne la parle pas.
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { list: {} },
      },
      authMethods: [],
      agentInfo: { name: "nokker", title: "Nokker", version: this.deps.version },
    };
  }

  private async ensureClient(): Promise<{ client: NokkerClient; hub: LocalEventHub }> {
    if (!this.client) {
      try {
        this.client = await this.deps.connect();
      } catch (err) {
        throw err instanceof RpcFailure ? err : new RpcFailure(RPC.authRequired, err instanceof Error ? err.message : String(err));
      }
      this.hub = new LocalEventHub(this.client, (err) => this.log("warn", `événements : ${String(err)}`));
    }
    return { client: this.client, hub: this.hub! };
  }

  private session(sessionId: unknown): AcpSession {
    const s = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
    if (!s) throw new RpcFailure(RPC.resourceNotFound, `session inconnue : ${String(sessionId)}`);
    return s;
  }

  private register(core: EditorSession): AcpSession {
    const s: AcpSession = { core, permissionRequests: new Map(), announced: new Set(), strongCalls: new Map(), cancelling: false };
    this.sessions.set(core.threadId, s);
    // Les commandes s'annoncent juste après la réponse à session/new|load.
    setTimeout(() => this.update(core.threadId, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS.map((c) => ({ ...c })) }), 0);
    return s;
  }

  private async newSession(params: unknown): Promise<unknown> {
    const { cwd, mcpServers } = (params ?? {}) as { cwd?: unknown; mcpServers?: unknown[] };
    if (typeof cwd !== "string" || !cwd) throw new RpcFailure(RPC.invalidParams, "cwd absent");
    if (Array.isArray(mcpServers) && mcpServers.length) this.log("info", `${mcpServers.length} serveur(s) MCP de l'éditeur ignorés (les connecteurs vivent dans le noyau)`);
    const { client, hub } = await this.ensureClient();
    try {
      const core = await EditorSession.open(client, hub, cwd, this.deps.fs);
      this.register(core);
      this.log("info", `session ${core.threadId} sur ${cwd}`);
      return { sessionId: core.threadId };
    } catch (err) {
      throw apiFailure(err, cwd);
    }
  }

  private async loadSession(params: unknown): Promise<unknown> {
    const { sessionId, cwd } = (params ?? {}) as { sessionId?: unknown; cwd?: unknown };
    if (typeof sessionId !== "string" || typeof cwd !== "string") throw new RpcFailure(RPC.invalidParams, "sessionId et cwd requis");
    const { client, hub } = await this.ensureClient();
    let known;
    try {
      known = (await client.listLocalSessions()).find((s) => s.thread_id === sessionId);
    } catch (err) {
      throw apiFailure(err);
    }
    if (!known) throw new RpcFailure(RPC.resourceNotFound, `session locale inconnue : ${sessionId}`);
    this.sessions.get(sessionId)?.core.dispose();
    const core = await EditorSession.open(client, hub, known.cwd, this.deps.fs, { threadId: sessionId });
    // L'historique est rejoué AVANT la réponse (ACP : session/load).
    for (const m of await core.history().catch(() => [])) {
      this.update(sessionId, {
        sessionUpdate: m.role === "user" ? "user_message_chunk" : "agent_message_chunk",
        content: { type: "text", text: m.content },
      });
    }
    this.register(core);
    return {};
  }

  private async listSessions(params: unknown): Promise<unknown> {
    const { cwd } = (params ?? {}) as { cwd?: unknown };
    const { client } = await this.ensureClient();
    try {
      const all = await client.listLocalSessions();
      return {
        sessions: all
          .filter((s) => typeof cwd !== "string" || !cwd || s.cwd === cwd)
          .map((s) => ({ sessionId: s.thread_id, cwd: s.cwd, ...(s.title ? { title: s.title } : {}), ...(s.last_turn_at ? { updatedAt: s.last_turn_at } : {}) })),
      };
    } catch (err) {
      throw apiFailure(err);
    }
  }

  private update(sessionId: string, update: Record<string, unknown>): void {
    this.deps.peer.notify("session/update", { sessionId, update });
  }

  private async prompt(params: unknown): Promise<unknown> {
    const { sessionId, prompt } = (params ?? {}) as { sessionId?: unknown; prompt?: unknown };
    const s = this.session(sessionId);
    const sid = s.core.threadId;
    if (!Array.isArray(prompt)) throw new RpcFailure(RPC.invalidParams, "prompt absent");
    const { text, attachments } = promptToRequest(prompt as ContentBlock[], s.core.cwd);
    const command = text.match(/^\/(cost|diff|plan|checkpoints)\b\s*(.*)$/s);
    if (command && attachments.length === 0) {
      await this.runCommand(s, command[1]!, command[2]!.trim());
      return { stopReason: "end_turn" };
    }
    if (!text && attachments.length === 0) return { stopReason: "end_turn" };
    s.cancelling = false;
    let cost: TurnCostEvent | null = null;
    try {
      const out = await s.core.prompt(
        text,
        {
          onText: (t) => this.update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } }),
          onToolStart: (t) => this.toolStart(sid, t),
          onToolEnd: (t) => this.toolEnd(sid, t),
          onApproval: (card) => void this.askPermission(s, card),
          onApprovalUpdate: (card) => this.strongUpdated(s, card),
          onApprovalClosed: (id) => this.permissionClosed(s, id),
          // Une ligne sous chaque tour : celui de la demande, puis chaque tour de suite (après une décision).
          onCost: (c) => {
            if (this.deps.costLine !== false && !s.cancelling) {
              this.update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n_${formatCostLine(c)}_\n\n` } });
            }
          },
          onNotice: (n) => this.update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n> ${n}\n\n` } }),
        },
        { attachments },
      );
      cost = out.cost;
      const { type: _t, ...costMeta } = (cost ?? { type: "" }) as TurnCostEvent;
      void _t;
      return { stopReason: out.stopReason, ...(cost ? { _meta: { nokker: { cost: costMeta } } } : {}) };
    } catch (err) {
      if (s.cancelling) return { stopReason: "cancelled" };
      throw apiFailure(err, s.core.cwd);
    }
  }

  private toolStart(sid: string, t: EditorToolCall): void {
    this.update(sid, {
      sessionUpdate: "tool_call",
      toolCallId: t.callId,
      title: `${t.depth ? "↳ " : ""}${toolTitle(t.name, t.args, this.sessions.get(sid)?.core.cwd ?? "")}`,
      kind: toolKind(t.name, t.effect),
      status: "in_progress",
      rawInput: t.args,
      ...(t.locations.length ? { locations: t.locations.map((path) => ({ path })) } : {}),
    });
  }

  private toolEnd(sid: string, t: EditorToolCall): void {
    const content: Record<string, unknown>[] = t.diffs.map(diffContent);
    if (t.preview && (t.diffs.length === 0 || t.status === "failed")) content.push(textContent(t.preview));
    this.update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: t.callId,
      status: t.status,
      ...(content.length ? { content } : {}),
      rawOutput: { preview: t.preview, ms: t.ms, effect: t.effect },
    });
  }

  private async askPermission(s: AcpSession, card: EditorApprovalCard): Promise<void> {
    const sid = s.core.threadId;
    const a = card.approval;
    let toolCallId = card.callId;
    if (!toolCallId) {
      toolCallId = `appr:${a.id}`;
      if (!s.announced.has(toolCallId)) {
        s.announced.add(toolCallId);
        this.update(sid, {
          sessionUpdate: "tool_call",
          toolCallId,
          title: toolTitle(a.tool_name, a.arguments, s.core.cwd),
          kind: toolKind(a.tool_name, a.effect),
          status: "pending",
          rawInput: a.arguments,
        });
      }
    }
    if (!card.choices) {
      // Carte forte : jamais décidée depuis l'éditeur ; le texte dit où elle attend.
      s.strongCalls.set(a.id, toolCallId);
      this.strongWhere(sid, toolCallId, card);
      return;
    }
    const options = card.choices.map((c, i) => ({
      optionId: `${c.id}:${i}`,
      name: c.rule ? `${c.label} : ${c.rule}` : c.label,
      kind: c.id === "reject" ? "reject_once" : c.id === "once" ? "allow_once" : "allow_always",
    }));
    const { id, promise } = this.deps.peer.request<PermissionOutcome>("session/request_permission", {
      sessionId: sid,
      toolCall: {
        toolCallId,
        title: toolTitle(a.tool_name, a.arguments, s.core.cwd),
        kind: toolKind(a.tool_name, a.effect),
        status: "pending",
        rawInput: a.arguments,
        content: [textContent(a.reason)],
      },
      options,
    });
    s.permissionRequests.set(a.id, id);
    let picked: LocalChoice | undefined;
    try {
      const res = await promise;
      if (res?.outcome?.outcome === "selected") {
        const optionId = res.outcome.optionId;
        picked = card.choices[Number(optionId.slice(optionId.lastIndexOf(":") + 1))];
        if (!picked || !optionId.startsWith(`${picked.id}:`)) picked = undefined;
      }
    } catch (err) {
      this.log("warn", `request_permission ${a.id} : ${String(err)}`);
    } finally {
      s.permissionRequests.delete(a.id);
    }
    if (s.cancelling) return; // le tour s'arrête : le noyau retire ses cartes
    // Pas de choix (annulé par l'éditeur, option inconnue) : refus, une seule fois.
    const choice = picked ?? card.choices.find((c) => c.id === "reject");
    if (!choice) return;
    try {
      await s.core.decide(a.id, choice);
    } catch (err) {
      this.log("warn", `décision ${a.id} : ${String(err)}`);
    }
  }

  private strongWhere(sid: string, toolCallId: string, card: EditorApprovalCard): void {
    this.update(sid, { sessionUpdate: "tool_call_update", toolCallId, status: "pending", content: [textContent(`${strongCardText(card)}\n${card.approval.reason}`)] });
  }

  /** Carte forte déposée chez nokker.ai après avoir été montrée : « au terminal » devient « attend ton téléphone ». */
  private strongUpdated(s: AcpSession, card: EditorApprovalCard): void {
    const toolCallId = s.strongCalls.get(card.approval.id);
    if (toolCallId && !card.choices) this.strongWhere(s.core.threadId, toolCallId, card);
  }

  private permissionClosed(s: AcpSession, approvalId: string): void {
    s.strongCalls.delete(approvalId);
    const reqId = s.permissionRequests.get(approvalId);
    if (reqId === undefined) return;
    s.permissionRequests.delete(approvalId);
    // Décidée ailleurs (terminal, téléphone) ou expirée : l'éditeur retire sa demande.
    this.deps.peer.notify("$/cancel_request", { requestId: reqId });
  }

  private async cancel(params: unknown): Promise<void> {
    const { sessionId } = (params ?? {}) as { sessionId?: unknown };
    const s = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
    if (!s) return;
    s.cancelling = true;
    await s.core.cancel();
  }

  private async runCommand(s: AcpSession, name: string, arg: string): Promise<void> {
    const sid = s.core.threadId;
    const say = (text: string): void => this.update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    const { client } = await this.ensureClient();
    try {
      if (name === "cost") {
        const c = await client.getLocalCost(sid);
        say(`Session : ${c.session ? `${formatCostLine(c.session)} (${c.session.turns} tour(s))` : "aucun tour"}\nJour (UTC ${c.day.date}) : ${formatCostLine(c.day)} (${c.day.turns} tour(s))`);
        return;
      }
      const tool = name === "diff" ? "checkpoint_diff" : name === "plan" ? "todo" : "checkpoint_list";
      const args = name === "diff" && arg ? { hash: arg } : {};
      const r = await client.callLocalTool(sid, tool, args);
      if (!r || !("content" in r)) {
        say("Action à approuver dans le fil.");
        return;
      }
      if (r.is_error) {
        say(r.content);
        return;
      }
      if (name === "diff") {
        const d = parseToolJson<CheckpointDiff>(r.content);
        const body = d?.diff ?? r.content;
        say(d?.message && !d.diff ? d.message : `${d?.stat ? `${d.stat}\n\n` : ""}\`\`\`diff\n${body}\n\`\`\``);
      } else if (name === "plan") {
        const t = parseToolJson<TodoResult>(r.content);
        const todos = (t?.todos ?? []).filter((x) => x.status !== "cancelled");
        if (!todos.length) {
          say("Aucun plan sur ce fil.");
          return;
        }
        this.update(sid, {
          sessionUpdate: "plan",
          entries: todos.map((x) => ({ content: x.content, priority: "medium", status: x.status === "cancelled" ? "completed" : x.status })),
        });
      } else {
        const raw = parseToolJson<CheckpointInfo[] | { checkpoints?: CheckpointInfo[] }>(r.content);
        const list = Array.isArray(raw) ? raw : (raw?.checkpoints ?? []);
        say(
          list.length
            ? list.map((c, i) => `${i + 1}. \`${c.short_hash}\` ${c.timestamp} — ${c.reason} (${c.files_changed} fichier(s))`).join("\n")
            : "Aucun point de retour sur ce fil.",
        );
      }
    } catch (err) {
      if (err instanceof NokkerApiError && err.status === 409) say("Un tour est en cours, réessayez après.");
      else if (err instanceof NokkerApiError && err.status === 404) say("Non disponible sur ce serveur.");
      else say(`Erreur : ${apiFailure(err).message}`);
    }
  }
}

export type { ContentBlock };
