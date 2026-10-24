/**
 * Types du contrat « bulles, fils et sessions qui se parlent » — `docs/BUBBLES.md`
 * (nokker 052b991, 18.10.2026) fait foi. Les champs sont en snake_case, EXACTEMENT comme sur le
 * fil (JSON du contrat) : pas de conversion camelCase côté SDK, pour que le même objet circule
 * tel quel entre noyau, mock, web, CLI et mobile.
 *
 * Écart assumé avec les types plus anciens de `types.ts` (CLIENT-API.md, camelCase) : les
 * événements `turn.*` historiques gardent leur forme camelCase tant que le noyau n'a pas tranché
 * (voir le rapport du chantier feat/bubbles) ; tout ce qui est nouveau suit BUBBLES.md.
 */

// ---------------------------------------------------------------------------
// §1 — Fil (« session » dans l'UI), permanent
// ---------------------------------------------------------------------------

export interface Thread {
  /** `th_` + 12 hex ; = la valeur de `X-Session-Id` de `/v1/chat/completions`. */
  id: string;
  title: string;
  owner: string;
  members: string[];
  created_at: string;
  updated_at: string;
  /** Le fil travaille (tour en cours) : le tiroir affiche le point vivant. */
  working: boolean;
  unread: number;
  bubble_count: number;
  last_snippet: string;
}

/**
 * Un message d'un fil = une moitié de TOUR (noyau, BUBBLES.md §8) : chaque tour donne un message `user` puis
 * un `assistant`, avec le même `index` (index du tour). `limit`/`before` comptent des tours. Les blocs de
 * contexte reçus (bulle, message de session) ne sont PAS des messages : le noyau les injecte dans l'entrée
 * du tour suivant (`[Contexte reçu]…[/Contexte]`, docs/CONTEXT-FORMAT.md).
 */
export interface ThreadMessage {
  /** Index du TOUR (partagé par le message user et le message assistant du tour). */
  index: number;
  role: "user" | "assistant";
  content: string;
  /** Message user : identité de l'émetteur et canal du tour (`web`, `telegram`, `session`…). */
  sender?: string | null;
  channel?: string;
  /** Absent côté noyau (P1) ; le mock le pose. */
  created_at?: string;
}

export interface ThreadView {
  thread: Thread;
  messages: ThreadMessage[];
  /** Bulles ouvertes du fil (y compris celles partagées avec lui, `shared: true`). */
  bubbles: Bubble[];
}

export interface CreateThreadRequest {
  title: string;
}

export interface PatchThreadRequest {
  title?: string;
  /** Propriétaire seulement (403 sinon), utilisateurs connus seulement (400 sinon). */
  members?: string[];
}

/** §4 — message d'une session à une autre. */
export interface SessionMessageRequest {
  from_thread: string;
  text: string;
  /** Lance un tour dans le fil destinataire ; sa réponse revient au fil `from_thread`. */
  ask?: boolean;
}

/** `{delivered, ask}` — HTTP 202 quand `ask` (un tour tourne en tâche de fond dans le fil destinataire). */
export interface SessionMessageResult {
  delivered: true;
  ask: boolean;
}

// ---------------------------------------------------------------------------
// §2 — Bulle
// ---------------------------------------------------------------------------

export const BUBBLE_KINDS = ["monitor", "search", "notify", "timer", "script", "media", "agent_draft", "approval"] as const;
export type BubbleKind = (typeof BUBBLE_KINDS)[number];

export const BUBBLE_STATUSES = ["idle", "working", "done", "failed"] as const;
export type BubbleStatus = (typeof BUBBLE_STATUSES)[number];

export interface BubbleAction {
  id: string;
  label: string;
  primary?: boolean;
}

export interface BubbleOrigin {
  thread_id: string;
  bubble_id: string;
  mode: TransferMode;
}

export interface BubbleSharing {
  members: string[];
  threads: string[];
}

/** §5 — aperçu d'une URL (rempli après coup dans une bulle `search` / `media`). */
export interface Preview {
  url: string;
  final_url: string;
  title: string;
  site_name: string;
  description: string;
  /** Chemin RELATIF au serveur Nokker (`/v1/previews/img/<sha256>`) : le client ne contacte jamais le site tiers. */
  image: string | null;
  favicon: string | null;
  excerpt: string;
  lang: string;
  kind: "article" | "video" | "repo" | "doc" | "other";
  embed?: { provider: string; id: string } | null;
  fetched_at: string;
}

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  site: string;
  preview?: Preview | null;
}

export interface SearchState {
  query: string;
  took_ms: number;
  engines: string[];
  results: SearchResult[];
  /** Vrai quand le lot d'aperçus est fini (réussi ou non) : plus de squelette de chargement. */
  previews_done?: boolean;
}

export interface MonitorState {
  target: string;
  metric: string;
  value: number;
  unit: string;
  max?: number;
  /** `[ts_ms, valeur]` */
  series?: [number, number][];
  items?: { label: string; value: string | number }[];
}

export interface TimerState {
  label: string;
  ends_at: string;
  started_at: string;
}

export interface ScriptState {
  command: string;
  host?: string;
  /** ≤ 40 lignes */
  log_tail: string[];
  exit_code?: number | null;
}

export interface MediaState {
  url: string;
  mime: string;
  poster?: string | null;
  preview?: Preview | null;
}

export interface NotifyState {
  from_thread: string;
  from_title: string;
  /** Fil qui a reçu le message (§8). */
  to_thread?: string;
  /** ≤ 280 caractères côté noyau. */
  text: string;
  approval_id?: string | null;
  /** Actions directes, `[]` par défaut ; l'action implicite `goto` (« Aller à la session ») est toujours
   * acceptée par `POST …/actions/goto` → `{closed: true, goto: from_thread}`. Toute action ferme la notify. */
  actions: BubbleAction[];
}

export interface AgentDraftState {
  name: string;
  role: string;
  model: string;
  tools: string[];
  /** Avancement du remplissage de la carte, 0..1. */
  fill: number;
}

export interface ApprovalBubbleState {
  approval_id: string;
}

export interface BubbleStateByKind {
  monitor: MonitorState;
  search: SearchState;
  notify: NotifyState;
  timer: TimerState;
  script: ScriptState;
  media: MediaState;
  agent_draft: AgentDraftState;
  approval: ApprovalBubbleState;
}

export interface BubbleBase<K extends BubbleKind = BubbleKind> {
  /** `bu_` + 12 hex */
  id: string;
  /** `null` pour une bulle `notify` née d'un message entre sessions (§4) : affichée dans le fil courant. */
  thread_id: string | null;
  kind: K;
  title: string;
  status: BubbleStatus;
  state: BubbleStateByKind[K];
  actions: BubbleAction[];
  origin: BubbleOrigin | null;
  shared_with: BubbleSharing;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  version: number;
  /** Posé par `GET /v1/threads/{id}/bubbles` quand la bulle est vue par partage (lecture seule). */
  shared?: boolean;
}

/** Union discriminée par `kind` : `if (b.kind === "search") b.state.results…` est typé. */
export type Bubble = { [K in BubbleKind]: BubbleBase<K> }[BubbleKind];

export interface CreateBubbleRequest<K extends BubbleKind = BubbleKind> {
  kind: K;
  title: string;
  state: BubbleStateByKind[K];
  status?: BubbleStatus;
  actions?: BubbleAction[];
}

export interface PatchBubbleRequest {
  title?: string;
  /** Fusionné champ par champ dans `state` (les champs absents sont conservés). */
  state?: Record<string, unknown>;
  status?: BubbleStatus;
  /** 409 si la version courante diffère. */
  if_version?: number;
}

// ---------------------------------------------------------------------------
// §3 — Transfert
// ---------------------------------------------------------------------------

export type TransferMode = "move" | "copy";

export interface TransferRequest {
  to_thread: string;
  mode: TransferMode;
}

/** Réponse de `POST /v1/bubbles/{id}/transfer` (noyau §8) : les champs de `bubble.transferred` + la bulle
 * d'arrivée (même id en `move`, nouvel id en `copy`). */
export interface TransferResult {
  bubble_id: string;
  new_bubble_id: string;
  from_thread: string;
  to_thread: string;
  mode: TransferMode;
  bubble: Bubble;
}

export interface ShareRequest {
  /** Utilisateurs connus seulement (400 sinon). */
  members?: string[];
  /** Fils dont l'appelant est membre seulement (403 sinon). */
  threads?: string[];
}

/**
 * Réponse de `POST /v1/bubbles/{id}/actions/{action_id}` (noyau §8) :
 *  - bulle `notify` : `{closed: true, goto}` (200) — `goto` = fil source pour l'action `goto`, sinon `null` ;
 *  - toute autre bulle : `{accepted: true, thread_id}` (202) — l'action devient un TOUR du fil de la bulle
 *    (« [Action « libellé » demandée sur la bulle …] »), jamais exécutée en direct ; ses effets (approbation,
 *    agent créé, bulle mise à jour) arrivent par les événements.
 */
export type BubbleActionResult =
  | { closed: true; goto: string | null }
  | { accepted: true; thread_id: string }
  /** `agent_draft` → `activate` (§9.4) : exécutée en direct (200), la bulle est fermée, `agent.created` publié. */
  | { activated: true; agent: Agent };

// ---------------------------------------------------------------------------
// Agents (onglet Crew) — `agent.created` est au contrat (§2, §6) ; la LISTE ne l'est pas encore.
// ---------------------------------------------------------------------------

/** Couleur d'état côté client (deck SOKKAN) : idle = bleu, armed = vert, running = orange, error = rouge. */
export type AgentStatus = "idle" | "armed" | "running" | "error";

/** Agent du Crew — forme du noyau (BUBBLES.md §9.4). `status` vaut toujours `armed` en P1 (pas d'exécution
 * réelle d'agent) ; les autres états servent au deck (et à la démo du mock). */
export interface Agent {
  id: string;
  name: string;
  role: string;
  model: string;
  tools: string[];
  status: AgentStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** Mock seulement (démo du deck) : dernier lancement. Absent côté noyau P1. */
  last_run?: string | null;
}

export interface CreateAgentRequest {
  name: string;
  role: string;
  model?: string;
  tools?: string[];
}

/** `GET /v1/users` (§9.2) : utilisateurs connus de la config — seules cibles valides d'un partage. */
export interface KnownUser {
  id: string;
  name: string;
  /** 2 lettres majuscules (ex. "AL"). */
  initials: string;
}

// ---------------------------------------------------------------------------
// §6 — Événements ajoutés à /v1/events
// ---------------------------------------------------------------------------

export interface ThreadUpdatedEvent {
  type: "thread.updated";
  thread: Thread;
}

export interface ThreadDeletedEvent {
  type: "thread.deleted";
  thread_id: string;
}

export interface BubbleCreatedEvent {
  type: "bubble.created";
  bubble: Bubble;
}

export interface BubbleUpdatedEvent {
  type: "bubble.updated";
  bubble: Bubble;
}

export interface BubbleClosedEvent {
  type: "bubble.closed";
  bubble_id: string;
  thread_id: string | null;
}

export interface BubbleTransferredEvent {
  type: "bubble.transferred";
  bubble_id: string;
  new_bubble_id: string;
  from_thread: string;
  to_thread: string;
  mode: TransferMode;
}

export interface SessionMessageEvent {
  type: "session.message";
  from_thread: string;
  to_thread: string;
  text: string;
}

export interface AgentCreatedEvent {
  type: "agent.created";
  agent: Agent;
}

export type BubbleEvent =
  | ThreadUpdatedEvent
  | ThreadDeletedEvent
  | BubbleCreatedEvent
  | BubbleUpdatedEvent
  | BubbleClosedEvent
  | BubbleTransferredEvent
  | SessionMessageEvent
  | AgentCreatedEvent;

export const BUBBLE_EVENT_TYPES = [
  "thread.updated",
  "thread.deleted",
  "bubble.created",
  "bubble.updated",
  "bubble.closed",
  "bubble.transferred",
  "session.message",
  "agent.created",
] as const satisfies readonly BubbleEvent["type"][];

// ---------------------------------------------------------------------------
// Petits utilitaires purs (partagés web / CLI / mobile)
// ---------------------------------------------------------------------------

/** Applique un événement de bulle à une liste locale (fil courant), sans muter l'entrée. Les
 * bulles `notify` sans fil (`thread_id: null`) sont gardées : elles s'affichent dans le fil courant. */
export function applyBubbleEvent(list: Bubble[], event: BubbleEvent, currentThread: string | null): Bubble[] {
  const visible = (b: Bubble): boolean =>
    b.closed_at === null &&
    (b.thread_id === null || b.thread_id === currentThread || (currentThread !== null && b.shared_with.threads.includes(currentThread)));
  switch (event.type) {
    case "bubble.created":
    case "bubble.updated": {
      const b = event.bubble;
      const rest = list.filter((x) => x.id !== b.id);
      if (!visible(b)) return rest;
      const idx = list.findIndex((x) => x.id === b.id);
      if (idx === -1) return [...rest, b];
      const out = list.slice();
      out[idx] = b;
      return out;
    }
    case "bubble.closed":
      return list.filter((x) => x.id !== event.bubble_id);
    default:
      return list;
  }
}

/** Contexte compact injecté dans le fil d'arrivée (§3) — reproduction du rendu noyau
 * `render_for_context`, utile au mock et aux tests : borné à 600 caractères de résumé. */
export function renderBubbleForContext(bubble: Bubble, fromTitle: string): string {
  const head = `[Bulle reçue de « ${fromTitle} » — ${bubble.kind} « ${bubble.title} »]`;
  return `${head} ${summarizeState(bubble).slice(0, 600)}`;
}

export function summarizeState(bubble: Bubble): string {
  switch (bubble.kind) {
    case "monitor": {
      const s = bubble.state;
      const items = (s.items ?? []).map((i) => `${i.label} ${i.value}`).join(", ");
      return `${s.target} ${s.metric} = ${s.value}${s.unit}${s.max !== undefined ? ` / ${s.max}${s.unit}` : ""}${items ? ` ; ${items}` : ""}`;
    }
    case "search":
      return `« ${bubble.state.query} » : ${bubble.state.results.map((r) => `${r.title} (${r.site})`).join(" · ")}`;
    case "timer":
      return `${bubble.state.label}, fin ${bubble.state.ends_at}`;
    case "script":
      return `${bubble.state.command}${bubble.state.host ? ` sur ${bubble.state.host}` : ""} : ${bubble.state.log_tail.slice(-3).join(" | ")}`;
    case "media":
      return `${bubble.state.mime} ${bubble.state.url}`;
    case "notify":
      return `${bubble.state.from_title} : ${bubble.state.text}`;
    case "agent_draft":
      return `${bubble.state.name} (${bubble.state.role}, ${bubble.state.model}) outils ${bubble.state.tools.join(", ")}`;
    case "approval":
      return `approbation ${bubble.state.approval_id}`;
  }
}
