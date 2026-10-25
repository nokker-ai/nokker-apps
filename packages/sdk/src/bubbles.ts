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
import type { BriefState, PlanSplitState } from "./ops.js";

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
  /** §9.5 : fil d'un passage d'agent ; absent pour un fil de session ordinaire. Rangé sous l'agent, pas dans la liste. */
  origin?: { kind: "agent"; agent_id: string; run_id: string };
}

/** Un fil de session ordinaire (à montrer dans la liste des sessions), pas un fil de passage d'agent. */
export const isSessionThread = (t: Pick<Thread, "origin">): boolean => t.origin?.kind !== "agent";

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
  /** LOKKAL §7.6 (X7) : images jointes au message user ; octets par `GET /v1/threads/{id}/images/{sha256}`. */
  images?: { sha256: string; media_type: string; size: number; name?: string | null }[];
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

export const BUBBLE_KINDS = ["monitor", "search", "notify", "timer", "script", "media", "artifact", "agent_draft", "approval", "handoff", "plan_split", "brief"] as const;
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

/** BUBBLES.md §10 — page HTML autonome écrite par une session (`page_create`). Jamais de HTML dans le state. */
export interface ArtifactState {
  /** `pg_` + 16 hex, jamais dérivé du chemin ; une page par (fil, chemin). */
  page_id: string;
  path: string;
  title: string;
  /** `text/html` seulement en v1. */
  mime: string;
  /** Version de la page (copie gardée par le noyau), distincte du `version` de la bulle. */
  version: number;
  size: number;
  /** Publique : choix explicite page par page ; privée sinon. */
  public: boolean;
  /** Dernière écriture de la page, en secondes epoch (`nokker/pages/store.py`). */
  updated_at: number;
  /** Écriture en direct (X22, BUBBLES.md §10.2) : le modèle écrit le fichier de la page. Pendant ce temps, le client
   * montre le texte des `tool.input.delta` de ce `call_id` (vue du code, sans l'exécuter) et ne recharge pas
   * l'aperçu ; la bulle se recale (`bubble.updated` sans `writing`, nouvelle `version` si l'outil a écrit). */
  writing?: ArtifactWriting;
}

export interface ArtifactWriting {
  call_id: string;
  turn_id: string;
  name: string;
  /** Début de l'écriture, en secondes epoch. */
  since: number;
}

/** `POST /v1/pages/{id}/link` (local) ou `pages-token` de nokker.ai (passerelle) — lien signé d'une page. */
export interface PageLink {
  url: string;
  expires_at: string;
  /** Adresse publique stable (`https://<nom>--pages.nokker.app/<page_id>`), présente seulement si la page est
   * publique — à copier et partager. Proposé à dev le 24.10 (§10.3). */
  public_url?: string;
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
  artifact: ArtifactState;
  agent_draft: AgentDraftState;
  approval: ApprovalBubbleState;
  handoff: HandoffState;
  plan_split: PlanSplitState;
  brief: BriefState;
}

/** X21 (LOKKAL §7.16) : relais d'une session web vers une machine Lokkal. Actions `accept`/`refuse` = décision de
 * l'utilisateur, jamais un tour ; montrées selon `state` (`proposed` : les deux ; `waiting` : « Annuler » = refuse). */
export interface HandoffState {
  handoff_id: string;
  state: "proposed" | "waiting" | "accepted" | "running" | "awaiting_approval" | "done" | "refused" | "expired" | "failed";
  need: { kind: "repo" | "host" | "connector" | "mcp" | (string & {}); name: string };
  machine_id: string;
  machine_name: string;
  /** `false` : la machine est éteinte, la demande attendra. */
  online: boolean;
  task: string;
  lokkal_thread: string | null;
  /** Réponse finale de la machine (caviardée par nokker.ai, ≤ 8 000 car.). */
  reply: string | null;
  error: string | null;
  pending_approvals: number;
  created_at: number;
  updated_at: number;
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

/** Couleur d'état côté client (deck Crew) : idle = bleu, armed = vert, running = orange, error = rouge. */
/** BUBBLES.md §9.5 (X14, contrat provisoire du 25.10) : paused = au repos/désarmé (bleu), armed = prêt (vert),
 * running = un passage en cours (orange), failed = dernier passage en échec (rouge). */
export type AgentStatus = "paused" | "armed" | "running" | "failed";

export type AgentTrigger =
  | { kind: "manual" }
  | { kind: "schedule"; cron: string; tz: string }
  | { kind: "once"; at: string }
  | { kind: "event"; event: string };

export type AgentRunStatus = "queued" | "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled" | "skipped";

export interface AgentBudget {
  max_calls: number;
  max_cost: number;
  currency: string;
}

/** Agent du Crew — §9.4, plus le moteur de §9.5 (champs facultatifs : un noyau P1 ne les envoie pas). */
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
  instructions?: string;
  trigger?: AgentTrigger;
  next_run_at?: string | null;
  last_run?: { run_id: string; status: AgentRunStatus; ended_at: string | null } | null;
  /** Noms du coffre (X4), jamais de valeur. */
  secrets?: string[];
  budget?: AgentBudget | null;
  /** Règles levées sans carte pendant un passage, `outil(motif)`. */
  auto_approve?: string[];
  placement?: { machine: "auto" | "web" | string } | null;
  /** X15 : ce que l'agent exige de sa machine, par noms. */
  needs?: { repos?: string[]; hosts?: string[]; connectors?: string[]; mcp?: string[]; gpu?: boolean } | null;
  /** X17 : projet d'équipe (`pj_…`), `null` hors projet. */
  project?: string | null;
  /** Carte forte d'armement en attente (règle d'écriture à approuver), sinon `null`. */
  arm_approval_id?: string | null;
}

export interface AgentRun {
  run_id: string;
  agent_id: string;
  trigger: AgentTrigger["kind"];
  scheduled_for: string | null;
  started_at: string | null;
  ended_at: string | null;
  status: AgentRunStatus;
  thread_id: string | null;
  cost: { tokens_in: number; tokens_out: number; amount: number; currency: string; calls?: number; amounts?: Record<string, number> } | null;
  summary: string | null;
  /** Échéance manquée rattrapée. */
  catch_up?: boolean;
  /** Événement déclencheur (`alert:…`, `webhook:…`, `mail:…`), sinon `null`. */
  event?: string | null;
}

export interface AgentRunPage {
  runs: AgentRun[];
  next_before: string | null;
}

export interface CreateAgentRequest {
  name: string;
  role: string;
  model?: string;
  tools?: string[];
  instructions?: string;
  trigger?: AgentTrigger;
  secrets?: string[];
  budget?: AgentBudget | null;
  auto_approve?: string[];
}

export type PatchAgentRequest = Partial<CreateAgentRequest>;

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

/** §9.5 : tout changement d'un agent (status, next_run_at, last_run…). */
export interface AgentUpdatedEvent {
  type: "agent.updated";
  agent: Agent;
}

export interface AgentDeletedEvent {
  type: "agent.deleted";
  id: string;
}

/** §9.5 : chaque changement d'état d'un passage. */
export interface AgentRunEvent {
  type: "agent.run";
  agent_id: string;
  run: AgentRun;
}

export type BubbleEvent =
  | ThreadUpdatedEvent
  | ThreadDeletedEvent
  | BubbleCreatedEvent
  | BubbleUpdatedEvent
  | BubbleClosedEvent
  | BubbleTransferredEvent
  | SessionMessageEvent
  | AgentCreatedEvent
  | AgentUpdatedEvent
  | AgentDeletedEvent
  | AgentRunEvent;

export const BUBBLE_EVENT_TYPES = [
  "thread.updated",
  "thread.deleted",
  "bubble.created",
  "bubble.updated",
  "bubble.closed",
  "bubble.transferred",
  "session.message",
  "agent.created",
  "agent.updated",
  "agent.deleted",
  "agent.run",
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
    case "artifact":
      return `page « ${bubble.state.title} » ${bubble.state.path} (v${bubble.state.version})`;
    case "notify":
      return `${bubble.state.from_title} : ${bubble.state.text}`;
    case "agent_draft":
      return `${bubble.state.name} (${bubble.state.role}, ${bubble.state.model}) outils ${bubble.state.tools.join(", ")}`;
    case "approval":
      return `approbation ${bubble.state.approval_id}`;
    case "plan_split":
      return `découpage proposé de « ${bubble.state.card_title} » : ${bubble.state.children.map((c) => c.title).join(" · ")} (${bubble.state.state})`;
    case "brief":
      return `brief du ${bubble.state.date.slice(0, 10)} : ${bubble.state.text.slice(0, 300)}`;
    case "handoff":
      return `relais vers « ${bubble.state.machine_name} » (${bubble.state.need.kind} « ${bubble.state.need.name} ») : ${bubble.state.state}${bubble.state.reply ? ` — ${bubble.state.reply}` : ""}`;
    default:
      return `bulle « ${(bubble as { kind: string }).kind} »`;
  }
}
