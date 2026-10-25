import React, { useEffect, useRef, useState } from "react";
import { basename } from "node:path";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { BRAND } from "@nokker-apps/brand";
import {
  NokkerApiError,
  NokkerClient,
  applyBubbleEvent,
  summarizeState,
  type Approval,
  type ApprovalScope,
  type Bubble,
  type LocalSessionSummary,
  type NokkerEvent,
  type Thread,
  type TurnUsage,
  type CheckpointInfo,
  type CheckpointRestoreResult,
  type LocalToolName,
  type LocalToolResult,
  type SkillInfo,
  type TodoResult,
  type DelegateStatusResult,
  type ProjectMemoryList,
  type ProjectMemoryView,
  parseToolJson,
  subagentParent,
} from "@nokker-apps/sdk";
import { connect, login } from "../auth.js";
import { cliLog } from "../log.js";
import { CliSession } from "../session.js";
import {
  notLocalMessage,
  findMemoryEntry,
  formatMemory,
  formatMemoryView,
  formatSubagent,
  mergeSubagentViews,
  type ProjectSkillsState,
  parseCheckpointDiff,
  parseCheckpointList,
  applySubagentEvent,
  formatCheckpoints,
  formatProjectSkills,
  subagentStatusLabel,
  formatPlan,
  formatRestore,
  formatSkills,
  formatSubagents,
  renderDiff,
  resolveCheckpoint,
  type DiffLine,
  type SubagentState,
} from "../localtools.js";
import { applyToolEvent, type ToolLine } from "../toolview.js";
import { decisionSummary, resolveEffect } from "../approval-model.js";
import { ringBell } from "../bell.js";
import { helpText, parseSlashCommand } from "../commands.js";
import { t } from "../i18n/index.js";
import { ConfirmCard, type ConfirmRequest } from "./ConfirmCard.js";
import { formatCostTotals, turnCostLine } from "../cost.js";
import { Markdown } from "./Markdown.js";
import { ToolCallView } from "./ToolCallView.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { BubbleLine } from "./BubbleLine.js";
import { Header } from "./Header.js";
import { Footer } from "./Footer.js";

type FeedItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "system"; id: string; text: string }
  | { kind: "diff"; id: string; lines: DiffLine[]; omitted: number }
  | { kind: "tool"; id: string; call: ToolLine }
  | { kind: "sub"; id: string; childId: string; text: string };

let seq = 0;
const nextId = (): string => `f${seq++}`;

export function App({ baseUrl, sound = false, cwd }: { baseUrl: string; sound?: boolean; cwd: string }): React.ReactElement {
  const { exit } = useApp();
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState(() => t("connecting…"));
  const [sending, setSending] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<Approval | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalMessage, setApprovalMessage] = useState<string | null>(null);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [mode, setMode] = useState<"chat" | "threads" | "sessions" | "approvals" | "bubbles">("chat");
  const [folder, setFolder] = useState<string | null>(null);
  const [localSessions, setLocalSessions] = useState<LocalSessionSummary[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [threads, setThreads] = useState<Thread[]>([]);
  const [approvalsList, setApprovalsList] = useState<Approval[]>([]);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [threadLabel, setThreadLabel] = useState("…");
  const [lastUsage, setLastUsage] = useState<TurnUsage | null>(null);
  const [lastCost, setLastCost] = useState<number | null>(null);
  /** Carte de confirmation (oubli d'une note, confiance aux skills du dépôt). */
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);
  const confirmRef = useRef<ConfirmRequest | null>(null);

  const clientRef = useRef<NokkerClient | undefined>(undefined);
  const sessionRef = useRef<CliSession | undefined>(undefined);
  const pendingRef = useRef<Approval | null>(null);
  /** La carte affichée est-elle celle d'une session locale (routes locales) ? */
  const pendingLocalRef = useRef(false);
  const [pendingLocal, setPendingLocal] = useState(false);
  /** Le flux d'événements est coupé : une seule ligne affichée, pas une par tentative. */
  const eventsDownRef = useRef(false);
  /** Session prête (connectée, ouverte, abonnée) ; avant, la saisie est mise en attente et envoyée ensuite, une seule fois. */
  const readyRef = useRef(false);
  const queuedRef = useRef<string[]>([]);
  const submitRef = useRef<(v: string) => Promise<void>>(async () => {});
  const toolLinesRef = useRef<ToolLine[]>([]);
  /** Sous-agents du fil connus par les événements `subagent.*`. */
  const subagentsRef = useRef<Map<string, SubagentState>>(new Map());
  /** Appels directs (`/rollback`, `/memory forget`) arrêtés sur une carte : approval_id -> suite, appelée avec le
   * `tool.result` qui porte cet approval_id (dans un sens ou l'autre de l'arrivée). */
  const directWaitRef = useRef<Map<string, (content: string, isError: boolean) => void>>(new Map());
  const directDoneRef = useRef<Map<string, { content: string; is_error: boolean }>>(new Map());
  /** Skills du dépôt : état connu (ouverture, `skill.untrusted`) et empreintes déjà proposées (une carte par version). */
  const skillsRef = useRef<ProjectSkillsState>("off");
  const skillsAskedRef = useRef<Set<string>>(new Set());
  /** Cartes dont NOUS avons déjà écrit le résumé (évite le doublon avec `approval.decided`). */
  const summarizedRef = useRef<Set<string>>(new Set());
  const pendingDeviceRef = useRef<{ id: string; user: string } | null>(null);
  const inputRef = useRef("");
  const swallowRef = useRef(false);
  const lastToolRef = useRef<string | null>(null);
  /** `turn_id` du dernier `turn.cost` reçu pour ce fil (le `turn.done` qui suit ne réaffiche pas les jetons au pied). */
  const costTurnRef = useRef<string | null>(null);
  /** Résolu à la première connexion `/v1/events` : un tour ne part pas avant (sinon ses premiers événements sont perdus). */
  const connectedRef = useRef<() => void>(() => {});
  const connectedPromise = useRef<Promise<void>>(new Promise<void>((r) => (connectedRef.current = r)));

  function pushSystem(text: string): void {
    setFeed((f) => [...f, { kind: "system", id: nextId(), text }]);
  }

  // Spinner des bulles `working` (BUBBLES.md §7, glow simulé) — un seul minuteur partagé, actif
  // seulement s'il y a quelque chose à animer (pas de minuteur qui tourne pour rien en arrière-plan).
  useEffect(() => {
    if (!bubbles.some((b) => b.status === "working")) return;
    const t = setInterval(() => setSpinnerFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, [bubbles]);

  const localCardOpen = (pendingApproval !== null && pendingLocal) || confirm !== null;

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      const a = pendingRef.current;
      if (a && pendingLocalRef.current) {
        // Ctrl+C sur une carte = refus + annulation du tour.
        void (async () => {
          await decideLocal("reject", "once"); // d'abord le refus (sinon l'annulation le devance et il échoue en 409)
          await cancelCurrent(true);
        })();
        return;
      }
      exit();
      return;
    }
    // Échap ne décide jamais une carte ; hors carte, il annule le tour (côté noyau, pas seulement l'affichage).
    if (key.escape && sending && !localCardOpen) {
      void cancelCurrent();
      return;
    }
    // `o` sur un champ vide : déplie l'aperçu du dernier appel d'outil (le caractère est avalé).
    if (_input === "o" && !key.ctrl && !key.meta && inputRef.current === "" && !localCardOpen && lastToolRef.current) {
      swallowRef.current = true;
      setTimeout(() => (swallowRef.current = false), 0);
      setInput("");
      toggleExpanded(lastToolRef.current);
    }
  });

  function toggleExpanded(id: string): void {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function cancelCurrent(quiet = false): Promise<void> {
    const session = sessionRef.current;
    if (!session) return;
    try {
      const done = await session.cancel();
      if (done || !quiet) pushSystem(done ? t("⏹ cancellation requested…") : t("No turn in progress."));
    } catch (err) {
      pushSystem(t("Cannot cancel: {0}", String(err)));
    }
  }

  useEffect(() => {
    let sub: { close(): void } | undefined;
    (async () => {
      const client = new NokkerClient({ baseUrl, userAgent: BRAND.userAgent });
      clientRef.current = client;
      setStatus(t("connecting…"));

      let conn;
      try {
        conn = await connect(client, baseUrl, `cli-${process.platform}`, {
          onPending: (d) => {
            pendingDeviceRef.current = { id: d.id, user: d.user };
            pushSystem(t("Device waiting for confirmation — code {0}. Confirm it on the host or type /confirm <TOTP code>.", d.code || t("(see the host)")));
            setStatus(t("device pending"));
          },
        });
      } catch (err) {
        setStatus(t("connection failed"));
        cliLog("error", `connection failed: ${String(err)}`);
        pushSystem(t("Cannot connect to {0}: {1} — `nokker doctor` tells what answers.", baseUrl, String(err)));
        return;
      }
      setStatus(conn.mode === "local" ? t("connected (local token)") : t("connected ({0})", conn.user));

      const session = new CliSession(client, conn.identity, undefined, conn.user);
      sessionRef.current = session;

      // Abonné AVANT d'ouvrir la session et d'accepter une saisie : un événement émis tôt (outil, carte) ne doit
      // jamais être manqué. Les événements sont filtrés sur `session.threadId`, posé juste après.
      sub = session.subscribeEvents({
        onConnected: () => connectedRef.current(),
        onEvent: (event: NokkerEvent) => handleEvent(event, session),
        onError: (err) => {
          // Une seule ligne par coupure : les tentatives suivantes (backoff) restent silencieuses.
          if (eventsDownRef.current) return;
          eventsDownRef.current = true;
          cliLog("warn", `event stream down: ${String(err)}`);
          pushSystem(t("(events) down: {0} — reconnecting automatically…", String(err).replace(/^Error: /, "")));
        },
        onReconnected: () => {
          eventsDownRef.current = false;
          pushSystem(t("(events) reconnected — run /approvals or /bubbles again if the state moved."));
        },
      });

      try {
        const opened = await session.openLocal(cwd);
        setFolder(basename(cwd) || cwd);
        setThreadLabel(session.threadId);
        if (opened.messages.length) setFeed(feedFromMessages(opened.messages));
        pushSystem(opened.resumed ? t("Code session on {0} (resumed). /help for the commands.", cwd) : t("Code session on {0} (new). /help for the commands.", cwd));
        skillsRef.current = opened.skills;
        if (typeof opened.skills === "object" && opened.skills.project === "untrusted") askTrust(opened.skills);
        else if (typeof opened.skills === "object" && opened.skills.project === "invalid" && opened.skills.notice) pushSystem(opened.skills.notice);
      } catch (err) {
        if (err instanceof NokkerApiError && err.status === 403) {
          pushSystem(t("Folder outside the roots declared by the server: {0}. Plain thread opened instead.", cwd));
        } else if (err instanceof NokkerApiError && (err.status === 404 || err.status === 405)) {
          pushSystem(t("This server offers no local code session — plain thread."));
        } else {
          pushSystem(t("Local session impossible: {0} — plain thread.", String(err)));
        }
        setThreadLabel(session.threadId);
      }

      try {
        const initial = await session.listBubbles();
        setBubbles(initial.filter((b) => b.closed_at === null));
      } catch {
        // Fil tout neuf, pas encore connu du serveur — pas de bulle, ce n'est pas une erreur.
      }

      // Session prête : on envoie ce qui a été tapé pendant la connexion (une fois chacun, dans l'ordre).
      readyRef.current = true;
      const queued = queuedRef.current;
      queuedRef.current = [];
      for (const line of queued) await submitRef.current(line);
    })();

    return () => sub?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Lignes d'outil (X22 compris) : applique l'événement au modèle pur, puis recopie dans le fil — ligne mise à jour en
   * place, ajoutée si nouvelle, retirée si le modèle l'a retirée (proposition abandonnée, jamais appelée). */
  function applyToolFeed(event: NokkerEvent): void {
    const before = toolLinesRef.current;
    const after = applyToolEvent(before, event);
    if (after === before) return;
    toolLinesRef.current = after;
    const fidOf = (l: ToolLine): string => `tool:${l.callId}`;
    const was = new Set(before.map(fidOf));
    const now = new Map(after.map((l) => [fidOf(l), l]));
    for (const l of after) if (!was.has(fidOf(l))) lastToolRef.current = fidOf(l);
    setFeed((f) => {
      const shown = new Set<string>();
      const next = f.flatMap<FeedItem>((it) => {
        if (it.kind !== "tool") return [it];
        shown.add(it.id);
        const l = now.get(it.id);
        if (l) return [{ ...it, call: l }];
        return was.has(it.id) ? [] : [it];
      });
      for (const [fid, l] of now) if (!shown.has(fid) && !was.has(fid)) next.push({ kind: "tool", id: fid, call: l });
      return next;
    });
  }

  function handleEvent(event: NokkerEvent, session: CliSession): void {
    switch (event.type) {
      case "approval.requested":
        void onApprovalRequested(event.approval, session);
        return;
      case "approval.decided":
        if (pendingRef.current?.id === event.approval_id) {
          pendingRef.current = null;
          pendingLocalRef.current = false;
          setPendingApproval(null);
        }
        if (!summarizedRef.current.has(event.approval_id)) {
          pushSystem(t("Approval {0}: {1} by {2} ({3}).", event.approval_id, event.decision, event.by, event.via));
        }
        applyToolFeed(event); // l'appel qui attendait la carte : « exécution… », ou fermé s'il est refusé
        return;
      case "tool.input.delta":
      case "tool.call":
      case "tool.result": {
        if (event.thread_id !== session.threadId) return;
        if (event.type === "tool.result") {
          if (!event.call_id) {
            // Appel direct : apparié par approval_id, pas de ligne d'outil.
            if (event.approval_id) {
              directDoneRef.current.set(event.approval_id, { content: event.content ?? event.preview ?? "", is_error: event.is_error === true });
              settleDirect(event.approval_id);
            }
            return;
          }
          if (event.approval_id) {
            // Sortie de l'exécuteur après la carte (LOKKAL.md §7.4.9) : la vraie sortie de l'outil approuvé, dépliée.
            const fid = `tool:${event.call_id}`;
            lastToolRef.current = fid;
            setExpanded((cur) => (cur.has(fid) ? cur : new Set(cur).add(fid)));
          }
        }
        applyToolFeed(event);
        return;
      }
      case "subagent.started":
      case "subagent.progress":
      case "subagent.finished":
        // Sous-agents de CE fil (premier plan et fond) : `parent_thread_id` (le seul champ commun aux trois).
        if (subagentParent(event) !== session.threadId) return;
        onSubagentEvent(event);
        return;
      case "skill.untrusted":
        if (event.thread_id !== session.threadId) return;
        skillsRef.current = { enabled: true, project: "untrusted", root: event.root, sha256: event.sha256, count: event.count, notice: event.notice };
        askTrust(skillsRef.current);
        return;
      case "memory.noted":
        if (event.thread_id !== session.threadId) return;
        pushSystem(t("Noted in the project memory: {0} [{1}] — /memory to review or forget it.", event.title, event.kind));
        return;
      case "memory.forgotten":
        if (event.thread_id !== session.threadId) return;
        pushSystem(t("Forgotten from the project memory: {0}.", event.name));
        return;
      case "turn.delta":
        // Le texte de NOTRE propre fil arrive déjà via le flux direct de /v1/chat/completions —
        // on ignore ici pour ne pas le doubler ; un autre fil/canal reste visible (multi-canal).
        // turn.delta est UNIQUE par tour côté noyau (réponse complète) : on l'affiche d'un bloc.
        if (event.thread_id !== session.threadId) pushSystem(t("[other thread {0}] {1}", event.thread_id, event.text));
        return;
      case "turn.cost":
        // Publié juste avant `turn.done` (LOKKAL.md §7.6) : une ligne discrète sous le tour, au lieu du pied.
        if (event.thread_id === session.threadId) {
          costTurnRef.current = event.turn_id;
          const line = turnCostLine(event);
          if (line) pushSystem(line);
        }
        return;
      case "turn.done":
        if (event.thread_id === session.threadId) {
          applyToolFeed(event); // replie les blocs d'écriture encore ouverts de ce tour
          // Noyau sans `turn.cost` : le pied de tour reste le seul affichage des jetons.
          const hasCostLine = costTurnRef.current === event.turn_id;
          setLastUsage(hasCostLine ? null : event.usage);
          setLastCost(hasCostLine ? null : (event.cost_chf ?? null));
          if (event.cancelled) pushSystem(t("⏹ turn cancelled."));
        }
        return;
      case "thread.updated":
        if (event.thread.id === session.threadId) setThreadLabel(event.thread.title || session.threadId);
        return;
      case "bubble.created":
        setBubbles((b) => applyBubbleEvent(b, event, session.threadId));
        ringBell(sound);
        if (event.bubble.kind === "notify") {
          pushSystem(t("(bubble) notify from “{0}” — {1} — /goto {2}", event.bubble.state.from_title, event.bubble.state.text, event.bubble.state.from_thread));
        }
        return;
      case "bubble.updated":
      case "bubble.closed":
        setBubbles((b) => applyBubbleEvent(b, event, session.threadId));
        return;
      case "bubble.transferred":
        pushSystem(event.mode === "copy" ? t("Bubble copied ({0} → {1}).", event.from_thread, event.to_thread) : t("Bubble moved ({0} → {1}).", event.from_thread, event.to_thread));
        return;
      case "session.message":
        // Déjà couvert par la bulle `notify` associée (bubble.created ci-dessus) — pas de doublon.
        return;
      case "agent.created":
        pushSystem(t("New agent created: {0} (Crew tab).", event.agent.name));
        return;
      default:
        return;
    }
  }

  /** Une carte arrive : si son fil est celui de la session locale (ou d'un `<fil>/sa-…`), elle passe par les routes locales
   * et on la relit par GET /v1/local/approvals (`suggested_rules` calculées par le noyau, absentes de l'événement). */
  async function onApprovalRequested(approval: Approval, session: CliSession): Promise<void> {
    const mine = session.isLocalThread(approval.thread_id);
    let card = approval;
    let local = mine;
    if (session.cwd) {
      try {
        const hit = (await session.listLocalApprovals()).find((a) => a.id === approval.id);
        if (hit) {
          card = hit;
          local = true;
        }
      } catch {
        // noyau sans routes locales : on s'en tient au fil
      }
    }
    if (local && !mine) return; // carte locale d'un autre dossier : pas la nôtre
    const effect = resolveEffect(card, toolLinesRef.current);
    if (effect !== card.effect) card = { ...card, effect };
    pendingRef.current = card;
    pendingLocalRef.current = local;
    setPendingLocal(local);
    setPendingApproval(card);
    setApprovalMessage(null);
    ringBell(sound);
    if (!local) pushSystem(t("Approval card received for thread {0} (level {1}).", card.thread_id, card.strength));
  }

  async function resolveThreadId(token: string): Promise<{ id: string; title: string } | null> {
    const client = clientRef.current;
    if (!client || !token) return null;
    if (/^th_/.test(token)) {
      try {
        const view = await client.getThread(token);
        return { id: view.thread.id, title: view.thread.title };
      } catch {
        return null;
      }
    }
    const locals = await client.listLocalSessions().catch(() => [] as LocalSessionSummary[]);
    const n0 = token.toLowerCase();
    const loc = locals.find((l) => (l.title ?? basename(l.cwd)).toLowerCase() === n0 || l.cwd.toLowerCase().endsWith(n0)) ?? locals.find((l) => l.cwd.toLowerCase().includes(n0));
    if (loc) return { id: loc.thread_id, title: loc.title ?? basename(loc.cwd) };
    const list = await client.listThreads();
    const n = token.toLowerCase();
    const found = list.find((t) => t.title.toLowerCase() === n) ?? list.find((t) => t.title.toLowerCase().includes(n));
    return found ? { id: found.id, title: found.title } : null;
  }

  function resolveBubbleLocal(token: string): Bubble | undefined {
    if (!token) return undefined;
    const direct = bubbles.find((b) => b.id === token);
    if (direct) return direct;
    const n = token.toLowerCase();
    return bubbles.find((b) => b.title.toLowerCase().includes(n));
  }

  function feedFromMessages(messages: { role: "user" | "assistant"; content: string }[]): FeedItem[] {
    return messages.map((m) => ({ kind: m.role, id: nextId(), text: m.content }));
  }

  async function onSubmit(value: string): Promise<void> {
    const text = value.trim();
    setInput("");
    inputRef.current = "";
    if (!text) return;

    // Pendant la connexion, /confirm (appareil en attente), /quit et /help marchent tout de suite.
    if (!readyRef.current && /^\/(confirm|quit|exit|help)\b/.test(text)) {
      await runCommand(text);
      return;
    }

    if (!readyRef.current) {
      // Connexion en cours : pas de perte, la ligne part dès que la session est ouverte.
      queuedRef.current.push(text);
      pushSystem(t("connecting — “{0}” will be sent as soon as the session is ready.", text.length > 40 ? `${text.slice(0, 39)}…` : text));
      return;
    }

    if (text.startsWith("/")) {
      await runCommand(text);
      return;
    }
    await sendTurn(text);
  }

  async function sendTurn(text: string): Promise<void> {
    const session = sessionRef.current;
    if (!session) {
      pushSystem(t("Not connected yet."));
      return;
    }
    if (sending) {
      pushSystem(t("A turn is already in progress — Esc (or /cancel) to cancel it."));
      return;
    }
    setFeed((f) => [...f, { kind: "user", id: nextId(), text }]);
    setSending(true);
    await Promise.race([connectedPromise.current, new Promise((r) => setTimeout(r, 3000))]);
    const assistantId = nextId();
    let created = false;
    try {
      await session.sendMessage(text, (_chunk, full) => {
        // L'élément « réponse » naît au premier texte : les appels d'outils s'affichent AVANT la réponse.
        if (!created) {
          if (!full) return;
          created = true;
          setFeed((f) => [...f, { kind: "assistant", id: assistantId, text: full }]);
          return;
        }
        setFeed((f) => f.map((it) => (it.id === assistantId && it.kind === "assistant" ? { ...it, text: full } : it)));
      });
    } catch (err) {
      pushSystem(t("Send error: {0}", String(err)));
    } finally {
      setSending(false);
    }
  }

  async function runCommand(cmdLine: string): Promise<void> {
    const session = sessionRef.current;
    const cmd = parseSlashCommand(cmdLine);
    switch (cmd.kind) {
      case "empty":
        return;

      case "quit":
        exit();
        return;

      case "help":
        pushSystem(helpText());
        return;

      case "renamedNew":
        pushSystem(t("/new no longer exists here (the core's /new marks an episode boundary) — use /thread [title] for a new thread."));
        return;

      case "thread": {
        if (!session) return;
        const title = cmd.title ?? t("Untitled");
        try {
          const thread = await session.createNamedThread(title);
          setFeed([]);
          setBubbles([]);
          setFolder(null);
          setThreadLabel(thread.title);
          setLastUsage(null);
          pushSystem(t("New thread “{0}” ({1}).", thread.title, thread.id));
        } catch (err) {
          pushSystem(t("Error {0}: {1}", "/thread", String(err)));
        }
        setMode("chat");
        return;
      }

      case "diff": {
        if (!session || !localOnly(session)) return;
        const hash = await resolveCheckpointArg(session, cmd.hash);
        if (hash === undefined) return;
        const r = await callTool(session, "checkpoint_diff", hash ? { hash } : {});
        if (!r) return;
        const parsed = parseCheckpointDiff(r.content);
        if (!parsed.diff.trim()) {
          pushSystem(parsed.message ?? t("No difference since this checkpoint."));
          return;
        }
        if (parsed.stat) pushSystem(parsed.stat);
        const d = renderDiff(parsed.diff);
        setFeed((f) => [...f, { kind: "diff", id: nextId(), lines: d.lines, omitted: d.omitted }]);
        return;
      }

      case "checkpoints": {
        if (!session || !localOnly(session)) return;
        const list = await listCheckpoints(session);
        if (list) pushSystem(formatCheckpoints(list));
        return;
      }

      case "rollback": {
        if (!session || !localOnly(session)) return;
        const list = await listCheckpoints(session);
        if (!list) return;
        const cp = resolveCheckpoint(list, cmd.target);
        if (!cp) {
          pushSystem(list.length ? t("Checkpoint not found: {0} (/checkpoints)", cmd.target ?? "") : t("No checkpoints."));
          return;
        }
        const label = `${cp.short_hash} (${cp.reason})`;
        try {
          const r = await session.callTool("checkpoint_restore", { hash: cp.hash, safe: true });
          if ("approval_id" in r) {
            // La carte arrive par approval.requested ; le résumé, par le tool.result portant cet approval_id.
            waitDirect(r.approval_id, (content, isError) => showRestore(content, isError, label));
          } else {
            showRestore(r.content, r.is_error, label);
          }
        } catch (err) {
          pushSystem(toolCallError("/rollback", err));
        }
        return;
      }

      case "skills": {
        if (!session || !localOnly(session)) return;
        if (cmd.name) {
          const r = await callTool(session, "skill_view", { name: cmd.name });
          if (r) setFeed((f) => [...f, { kind: "assistant", id: nextId(), text: r.content }]);
          return;
        }
        const r = await callTool(session, "skill_list");
        const skills = r ? parseToolJson<{ skills: SkillInfo[] }>(r.content)?.skills : undefined;
        if (skills) pushSystem(formatSkills(skills, skillsRef.current));
        return;
      }

      case "skillsTrust": {
        if (!session || !localOnly(session)) return;
        const st = skillsRef.current;
        if (typeof st === "object" && st.project === "untrusted") {
          skillsAskedRef.current.delete(st.sha256 ?? "");
          askTrust(st);
        } else pushSystem(formatProjectSkills(st));
        return;
      }

      case "memory": {
        if (!session || !localOnly(session)) return;
        await runMemory(session, cmd.action, cmd.name);
        return;
      }

      case "plan": {
        if (!session || !localOnly(session)) return;
        const r = await callTool(session, "todo");
        const todos = r ? parseToolJson<TodoResult>(r.content)?.todos : undefined;
        if (todos) pushSystem(formatPlan(todos));
        return;
      }

      case "agents": {
        if (!session || !localOnly(session)) return;
        await runAgents(session, cmd.action, cmd.id);
        return;
      }

      case "cost": {
        if (!session) return;
        try {
          pushSystem(formatCostTotals(await session.getCost()));
        } catch (err) {
          if (err instanceof NokkerApiError && [404, 405].includes(err.status)) pushSystem(t("/cost: not available on this server (local core only)"));
          else pushSystem(toolCallError("/cost", err));
        }
        return;
      }

      case "cancel":
        await cancelCurrent();
        return;

      case "out": {
        if (lastToolRef.current) toggleExpanded(lastToolRef.current);
        else pushSystem(t("No tool call to expand."));
        return;
      }

      case "confirm": {
        const client = clientRef.current;
        const dev = pendingDeviceRef.current;
        if (!client || !dev) {
          pushSystem(t("No device waiting for confirmation."));
          return;
        }
        if (!cmd.totp) {
          pushSystem(t("Usage: {0}", "/confirm <TOTP>"));
          return;
        }
        try {
          await client.confirmDevice(dev.id, { totp: cmd.totp, user: dev.user });
          pushSystem(t("Device confirmed."));
        } catch (err) {
          pushSystem(t("Confirmation refused: {0}", String(err)));
        }
        return;
      }

      case "threads": {
        if (!session) return;
        const list = await session.listThreads();
        setThreads(list);
        setMode("threads");
        return;
      }

      case "sessions": {
        if (!session) return;
        if (cmd.query) {
          await gotoThread(session, cmd.query);
          return;
        }
        try {
          setLocalSessions(await session.listLocalSessions());
          setMode("sessions");
        } catch (err) {
          pushSystem(t("Error {0}: {1}", "/sessions", String(err)));
        }
        return;
      }

      case "goto": {
        if (!session) return;
        await gotoThread(session, cmd.query);
        return;
      }

      case "bubbles": {
        if (!session) return;
        try {
          const list = await session.listBubbles();
          setBubbles(list.filter((b) => b.closed_at === null));
        } catch (err) {
          pushSystem(t("Error {0}: {1}", "/bubbles", String(err)));
        }
        setMode("bubbles");
        return;
      }

      case "bubble": {
        if (!session) return;
        if (!cmd.id) {
          pushSystem(t("Usage: {0}", "/bubble <id|title>"));
          return;
        }
        const local = resolveBubbleLocal(cmd.id);
        try {
          const b = local ?? (await session.getBubble(cmd.id));
          pushSystem(`◇ ${b.title} [${b.kind}/${b.status}] (${b.id}) — ${summarizeState(b)}`);
        } catch {
          pushSystem(t("Bubble not found: {0}", cmd.id));
        }
        return;
      }

      case "send": {
        if (!session) return;
        if (!cmd.bubble || !cmd.session) {
          pushSystem(t("Usage: {0}", "/send <bubble> <session> [--copy]"));
          return;
        }
        const bubble = resolveBubbleLocal(cmd.bubble);
        if (!bubble) {
          pushSystem(t("Bubble not found here: {0} (try /bubbles for the list).", cmd.bubble));
          return;
        }
        const target = await resolveThreadId(cmd.session);
        if (!target) {
          pushSystem(t("Session not found: {0}", cmd.session));
          return;
        }
        try {
          const transferMode = cmd.copy ? "copy" : "move";
          await session.transferBubble(bubble.id, target.id, transferMode);
          pushSystem(cmd.copy ? t("Bubble “{0}” copied to “{1}”.", bubble.title, target.title) : t("Bubble “{0}” moved to “{1}”.", bubble.title, target.title));
        } catch (err) {
          pushSystem(t("Error {0}: {1}", "/send", String(err)));
        }
        return;
      }

      case "ask": {
        if (!session) return;
        if (!cmd.session || !cmd.text) {
          pushSystem(t("Usage: {0}", "/ask <session> <text>"));
          return;
        }
        const target = await resolveThreadId(cmd.session);
        if (!target) {
          pushSystem(t("Session not found: {0}", cmd.session));
          return;
        }
        try {
          await session.sendAsk(target.id, cmd.text);
          pushSystem(t("Question sent to “{0}” — its answer will arrive here as a notification.", target.title));
        } catch (err) {
          pushSystem(t("Error {0}: {1}", "/ask", String(err)));
        }
        return;
      }

      case "approvals": {
        if (!session) return;
        const list = await session.listApprovals();
        setApprovalsList(list);
        setMode("approvals");
        return;
      }

      case "login": {
        const client = clientRef.current;
        if (!client) return;
        pushSystem(t("Signing in again…"));
        const token = await login(client, `cli-${process.platform}`, {
          onPending: (d) => {
            pendingDeviceRef.current = { id: d.id, user: d.user };
            pushSystem(t("Device pending — code {0}. /confirm <TOTP code> or confirm on the host.", d.code));
          },
        });
        session?.setUser(token.user);
        setStatus(t("connected ({0})", token.user));
        pushSystem(t("Connected."));
        return;
      }

      case "tools":
        setToolsExpanded((v) => !v);
        return;

      case "unknown":
        pushSystem(t("Unknown command: /{0} — /help for the list.", cmd.name));
        return;
    }
  }

  /** Les commandes d'outils du noyau n'existent que dans une session de code (dossier). */
  function localOnly(session: CliSession): boolean {
    if (session.cwd) return true;
    pushSystem(notLocalMessage());
    return false;
  }

  async function callTool(session: CliSession, name: LocalToolName, args: Record<string, unknown> = {}): Promise<LocalToolResult | null> {
    try {
      const r = await session.callTool(name, args);
      if ("approval_id" in r) {
        pushSystem(t("{0}: waiting for approval ({1}).", name, r.approval_id));
        return null;
      }
      if (r.is_error) {
        pushSystem(`✗ ${name} : ${r.content}`);
        return null;
      }
      return r;
    } catch (err) {
      pushSystem(toolCallError(name, err));
      return null;
    }
  }

  function toolCallError(label: string, err: unknown): string {
    if (err instanceof NokkerApiError && err.status === 409) return t("a turn is in progress, try again afterwards");
    return t("Error {0}: {1}", label, err instanceof NokkerApiError ? err.serverMessage : String(err));
  }

  async function listCheckpoints(session: CliSession): Promise<CheckpointInfo[] | null> {
    const r = await callTool(session, "checkpoint_list");
    const list = r ? parseCheckpointList(r.content) : undefined;
    if (r && !list) pushSystem(t("Unreadable checkpoint_list answer."));
    return list ?? null;
  }

  /** `/diff [hash|n]` : `undefined` = erreur déjà affichée, `""` = dernier point. */
  async function resolveCheckpointArg(session: CliSession, arg: string | null): Promise<string | undefined> {
    if (arg === null) return "";
    const list = await listCheckpoints(session);
    if (!list) return undefined;
    const cp = resolveCheckpoint(list, arg);
    if (!cp) {
      pushSystem(t("Checkpoint not found: {0} (/checkpoints)", arg));
      return undefined;
    }
    return cp.hash;
  }

  function showRestore(content: string, isError: boolean, label: string): void {
    const r = parseToolJson<CheckpointRestoreResult>(content);
    if (isError || !r) pushSystem(t("✗ Rollback to {0}: {1}", label, isError ? content : t("unreadable answer")));
    else pushSystem(formatRestore(r, label));
  }

  /** Suite d'un appel direct arrêté sur une carte, jouée au `tool.result` qui porte son approval_id. */
  function waitDirect(approvalId: string, then: (content: string, isError: boolean) => void): void {
    directWaitRef.current.set(approvalId, then);
    settleDirect(approvalId);
  }

  function settleDirect(approvalId: string): void {
    const then = directWaitRef.current.get(approvalId);
    const done = directDoneRef.current.get(approvalId);
    if (then === undefined || !done) return;
    directWaitRef.current.delete(approvalId);
    directDoneRef.current.delete(approvalId);
    then(done.content, done.is_error);
  }

  // -- Sous-agents (/agents, LOKKAL.md §7.22) ------------------------------------------------------------

  function onSubagentEvent(event: Extract<NokkerEvent, { type: "subagent.started" | "subagent.progress" | "subagent.finished" }>): void {
    subagentsRef.current = applySubagentEvent(subagentsRef.current, event);
    const a = subagentsRef.current.get(event.child_id);
    const bg = a?.background ? ` ${t("(background)")}` : "";
    if (event.type === "subagent.started") {
      setFeed((f) => [...f, { kind: "sub", id: `sub:${event.child_id}`, childId: event.child_id, text: t("↳ sub-agent {0}{1}: {2}", event.child_id, bg, event.goal) }]);
      return;
    }
    const text =
      event.type === "subagent.progress"
        ? t("↳ sub-agent {0}{1}: {2} ({3} ms)", event.child_id, bg, event.tool, event.ms)
        : t("↳ sub-agent {0}{1} {2} — {3} commit(s), tree {4}", event.child_id, bg, subagentStatusLabel(a?.status ?? event.status), event.commits, event.dirty ? t("modified") : t("clean"));
    setFeed((f) => {
      const has = f.some((it) => it.kind === "sub" && it.childId === event.child_id);
      return has ? f.map((it) => (it.kind === "sub" && it.childId === event.child_id ? { ...it, text } : it)) : [...f, { kind: "sub", id: `sub:${event.child_id}`, childId: event.child_id, text }];
    });
    if (event.type === "subagent.finished" && a?.background) pushSystem(t("Background sub-agent {0} finished ({1}) — /agents {0} for its result.", event.child_id, subagentStatusLabel(a.status)));
  }

  /** Relit `delegate_status` (enfants de fond) ; rend une note quand l'état ne vient que des événements. */
  async function refreshSubagents(session: CliSession): Promise<string | null> {
    try {
      const r = await session.callTool("delegate_status");
      if ("approval_id" in r) return null;
      const st = r.is_error ? null : parseToolJson<DelegateStatusResult>(r.content);
      if (st) subagentsRef.current = mergeSubagentViews(subagentsRef.current, st.children);
      return null;
    } catch (err) {
      if (err instanceof NokkerApiError && err.status === 409) return t("(a turn is in progress: state taken from the live events)");
      if (err instanceof NokkerApiError && [403, 404].includes(err.status)) return t("(this core has no background sub-agents: state taken from the live events)");
      return t("(delegate_status unavailable: {0})", err instanceof NokkerApiError ? err.serverMessage : String(err));
    }
  }

  function findSubagent(id: string): SubagentState | null {
    const all = [...subagentsRef.current.values()];
    return all.find((a) => a.childId === id) ?? (all.filter((a) => a.childId.startsWith(id)).length === 1 ? all.find((a) => a.childId.startsWith(id))! : null);
  }

  async function runAgents(session: CliSession, action: "list" | "view" | "cancel", id: string | null): Promise<void> {
    if (action === "cancel") {
      if (!id) {
        pushSystem(t("Usage: {0}", "/agents cancel <id|all>"));
        return;
      }
      if (id === "all") {
        try {
          const r = await session.cancelAllSubagents();
          pushSystem(t("Stopped {0} sub-agent(s) (their worktrees are kept); the turn in progress, if any, is cancelled too.", r.subagents_cancelled ?? 0));
        } catch (err) {
          pushSystem(toolCallError("/agents cancel", err));
        }
        return;
      }
      await refreshSubagents(session);
      const a = findSubagent(id);
      if (!a) {
        pushSystem(t("Sub-agent not found: {0} (/agents)", id));
        return;
      }
      try {
        const r = await session.cancelSubagent(a.childId);
        const out = "approval_id" in r ? null : parseToolJson<{ cancelled: string[]; unknown?: string[] }>(r.content);
        if ("approval_id" in r || r.is_error || !out) pushSystem(t("Error {0}: {1}", "/agents cancel", "approval_id" in r ? r.approval_id : r.content));
        else if (out.cancelled.includes(a.childId)) pushSystem(t("Sub-agent {0}: stop requested (its worktree is kept).", a.childId));
        else pushSystem(t("Sub-agent {0} was not running.", a.childId));
      } catch (err) {
        if (err instanceof NokkerApiError && err.status === 403) {
          pushSystem(t("This core cannot stop a single sub-agent from the terminal yet. /agents cancel all stops every sub-agent of this thread (and the turn in progress)."));
        } else pushSystem(toolCallError("/agents cancel", err));
      }
      return;
    }
    const note = await refreshSubagents(session);
    if (action === "view" && id) {
      const a = findSubagent(id);
      pushSystem(a ? formatSubagent(a) : t("Sub-agent not found: {0} (/agents)", id));
      return;
    }
    pushSystem(formatSubagents(subagentsRef.current, Date.now(), note));
  }

  // -- Mémoire de projet (/memory, LOKKAL.md §7.11.7) ------------------------------------------------------

  async function memoryCall(session: CliSession, args: Record<string, unknown>): Promise<LocalToolResult | null> {
    try {
      const r = await session.callTool("memory", args);
      if ("approval_id" in r) {
        pushSystem(t("{0}: waiting for approval ({1}).", "memory", r.approval_id));
        return null;
      }
      return r;
    } catch (err) {
      if (err instanceof NokkerApiError && err.status === 403) pushSystem(t("Project memory is not available on this core (local.project_memory is off)."));
      else pushSystem(toolCallError("/memory", err));
      return null;
    }
  }

  async function memoryList(session: CliSession): Promise<ProjectMemoryList | null> {
    const r = await memoryCall(session, { action: "list" });
    if (!r) return null;
    const list = r.is_error ? null : parseToolJson<ProjectMemoryList>(r.content);
    if (!list) pushSystem(r.is_error ? `✗ memory: ${r.content}` : t("Unreadable memory answer."));
    return list;
  }

  async function runMemory(session: CliSession, action: "list" | "view" | "forget", name: string | null): Promise<void> {
    if (action === "list") {
      const [list, status] = await Promise.all([memoryList(session), session.memoryStatus()]);
      if (list) pushSystem(formatMemory(list, status));
      return;
    }
    if (!name) {
      pushSystem(t("Usage: {0}", "/memory forget <note>"));
      return;
    }
    const list = await memoryList(session);
    if (!list) return;
    const hit = findMemoryEntry(list, name);
    if (!hit) {
      pushSystem(t("Note not found: {0} (/memory for the list)", name));
      return;
    }
    if (action === "view") {
      const r = await memoryCall(session, { action: "view", name: hit.name });
      const v = r && !r.is_error ? parseToolJson<ProjectMemoryView>(r.content) : null;
      if (v) pushSystem(formatMemoryView(v));
      else if (r) pushSystem(`✗ memory: ${r.content}`);
      return;
    }
    if (!hit.learned) {
      pushSystem(t("{0} comes from an instruction file: edit the file, the memory follows.", hit.name));
      return;
    }
    openConfirm({ kind: "forget", name: hit.name, title: hit.title });
  }

  function forgetDone(content: string, isError: boolean, title: string): void {
    const out = isError ? null : parseToolJson<{ forgotten: string }>(content);
    if (out?.forgotten) pushSystem(t("✓ Forgotten: {0} ({1}).", title, out.forgotten));
    else pushSystem(t("✗ Not forgotten: {0}", content));
  }

  // -- Cartes de confirmation (oubli, confiance aux skills du dépôt) ---------------------------------------

  function openConfirm(req: ConfirmRequest): void {
    confirmRef.current = req;
    setConfirmMessage(null);
    setConfirm(req);
  }

  function closeConfirm(): void {
    confirmRef.current = null;
    setConfirm(null);
    setConfirmMessage(null);
  }

  /** Carte « faire confiance aux skills de ce dépôt » : une fois par empreinte (un arbre changé redemande). */
  function askTrust(st: ProjectSkillsState): void {
    if (typeof st !== "object" || st.project !== "untrusted" || !st.sha256) return;
    if (skillsAskedRef.current.has(st.sha256)) return;
    skillsAskedRef.current.add(st.sha256);
    openConfirm({ kind: "trust", skills: st });
  }

  async function answerConfirm(yes: boolean): Promise<void> {
    const req = confirmRef.current;
    const session = sessionRef.current;
    if (!req || !session) return;
    if (!yes) {
      closeConfirm();
      pushSystem(req.kind === "forget" ? t("Kept: {0}.", req.title) : t("Repository skills left untrusted (ignored). /skills trust to decide later."));
      return;
    }
    setConfirmBusy(true);
    try {
      if (req.kind === "forget") {
        const r = await session.callTool("memory", { action: "forget", name: req.name });
        closeConfirm();
        // Mode `default` : l'oubli (WRITE) passe par une carte ; son résultat arrive par le tool.result de la carte.
        if ("approval_id" in r) waitDirect(r.approval_id, (content, isError) => forgetDone(content, isError, req.title));
        else forgetDone(r.content, r.is_error, req.title);
      } else {
        const r = await session.trustSkills(req.skills.sha256 ?? "");
        closeConfirm();
        skillsRef.current = { ...req.skills, project: "trusted", notice: null };
        pushSystem(t("✓ Repository skills trusted ({0}, fingerprint {1}…). /skills to list them.", r.root, r.sha256.slice(0, 12)));
      }
    } catch (err) {
      if (err instanceof NokkerApiError && err.status === 409) {
        // Empreinte périmée : l'arbre a changé ; le noyau publie un nouveau `skill.untrusted` (nouvelle carte).
        closeConfirm();
        pushSystem(t("The skills changed since they were read: review them again (/skills trust)."));
      } else setConfirmMessage(t("Failed: {0}", err instanceof NokkerApiError ? err.serverMessage : String(err)));
    } finally {
      setConfirmBusy(false);
    }
  }

  async function gotoThread(session: CliSession, query: string): Promise<void> {
    const target = await resolveThreadId(query);
    if (!target) {
      pushSystem(t("Session not found: {0}", query));
      return;
    }
    try {
      const view = await session.switchThread(target.id);
      setFeed(feedFromMessages(view.messages));
      setBubbles(view.bubbles.filter((b) => b.closed_at === null));
      const ls = (await session.listLocalSessions().catch(() => [] as LocalSessionSummary[])).find((l) => l.thread_id === view.thread.id);
      session.cwd = ls?.cwd ?? null;
      setFolder(ls ? basename(ls.cwd) : null);
      setThreadLabel(view.thread.title || view.thread.id);
      setLastUsage(null);
      setLastCost(null);
      pushSystem(t("Switched to “{0}” ({1}).", view.thread.title, view.thread.id));
      setMode("chat");
    } catch (err) {
      pushSystem(t("Switch error: {0}", String(err)));
    }
  }

  const session = sessionRef.current;
  submitRef.current = onSubmit;

  return (
    <Box flexDirection="column">
      <Header threadLabel={threadLabel} folder={folder} status={status} />

      {mode === "threads" ? (
        <Box flexDirection="column" borderStyle="single" paddingX={1}>
          <Text bold>{t("Threads:")}</Text>
          {threads.length === 0 ? <Text dimColor>{t("(no threads)")}</Text> : null}
          {threads.map((th) => (
            <Text key={th.id}>
              {th.working ? "● " : "○ "}
              {th.id} — {th.title} ({t("{0} bubble(s)", th.bubble_count)})
            </Text>
          ))}
          <Text dimColor>{t("/sessions <query> or /goto <query> to switch · /thread [title] to start over")}</Text>
        </Box>
      ) : null}

      {mode === "sessions" ? (
        <Box flexDirection="column" borderStyle="single" paddingX={1}>
          <Text bold>{t("Code sessions:")}</Text>
          {localSessions.length === 0 ? <Text dimColor>{t("(none)")}</Text> : null}
          {localSessions.map((l) => (
            <Text key={l.thread_id}>
              {l.thread_id === sessionRef.current?.threadId ? "● " : "○ "}
              {l.title ?? basename(l.cwd)} — {l.cwd} ({l.thread_id}){l.last_turn_at ? ` · ${t("last turn {0}", l.last_turn_at)}` : ""}
              {l.working ? ` · ${t("working")}` : ""}
              {l.pending_approvals ? ` · ${t("{0} card(s) pending", l.pending_approvals)}` : ""}
            </Text>
          ))}
          <Text dimColor>{t("/sessions <folder> to switch · /threads for all threads")}</Text>
        </Box>
      ) : null}

      {mode === "approvals" ? (
        <Box flexDirection="column" borderStyle="single" paddingX={1}>
          <Text bold>{t("Approvals:")}</Text>
          {approvalsList.length === 0 ? <Text dimColor>{t("(none)")}</Text> : null}
          {approvalsList.map((a) => (
            <Text key={a.id}>
              {a.id} — {a.tool_name} [{a.effect}/{a.strength}] {a.status}
            </Text>
          ))}
        </Box>
      ) : null}

      {mode === "bubbles" ? (
        <Box flexDirection="column" borderStyle="single" paddingX={1}>
          <Text bold>{t("Bubbles of this thread:")}</Text>
          {bubbles.length === 0 ? <Text dimColor>{t("(none)")}</Text> : null}
          {bubbles.map((b) => (
            <BubbleLine key={b.id} bubble={b} spinnerFrame={spinnerFrame} />
          ))}
          <Text dimColor>{t("/bubble <id|title> for details · /send <bubble> <session> [--copy]")}</Text>
        </Box>
      ) : null}

      {mode === "chat" ? (
        <Box flexDirection="column">
          {feed.map((item) => {
            if (item.kind === "user") return <Text key={item.id}>› {item.text}</Text>;
            if (item.kind === "system") return <Text key={item.id} dimColor>· {item.text}</Text>;
            if (item.kind === "diff")
              return (
                <Box key={item.id} flexDirection="column">
                  {item.lines.map((l, i) => (
                    <Text key={i} color={l.kind === "add" ? "green" : l.kind === "del" ? "red" : l.kind === "hunk" ? "cyan" : undefined} dimColor={l.kind === "meta"} bold={l.kind === "meta"}>
                      {l.text}
                    </Text>
                  ))}
                  {item.omitted > 0 ? <Text dimColor>{t("… {0} more line(s) not shown (first 300 lines)", item.omitted)}</Text> : null}
                </Box>
              );
            if (item.kind === "tool") return <ToolCallView key={item.id} call={item.call} expanded={toolsExpanded || expanded.has(item.id)} />;
            if (item.kind === "sub") return <Text key={item.id} dimColor>{"      "}{item.text}</Text>;
            return (
              <Box key={item.id} flexDirection="column">
                <Markdown text={item.text} />
              </Box>
            );
          })}
        </Box>
      ) : null}

      {mode === "chat" && bubbles.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {bubbles.map((b) => (
            <BubbleLine key={b.id} bubble={b} spinnerFrame={spinnerFrame} />
          ))}
        </Box>
      ) : null}

      {pendingApproval ? (
        <ApprovalCard
          approval={pendingApproval}
          local={pendingLocal}
          busy={approvalBusy}
          message={approvalMessage}
          onApproveByPhone={() => void decide("approve", "phone")}
          onRejectByPhone={() => void decide("reject", "phone")}
          onApproveTotp={(code) => void decide("approve", "totp", code)}
          onRejectTotp={(code) => void decide("reject", "totp", code)}
          onLocalDecision={(decision, scope, rule) => void decideLocal(decision, scope, rule)}
          onExpired={() => void expireLocal()}
        />
      ) : null}

      {confirm && !pendingApproval ? <ConfirmCard request={confirm} busy={confirmBusy} message={confirmMessage} onAnswer={(yes) => void answerConfirm(yes)} /> : null}

      {sending && !pendingApproval ? <Text dimColor>{t("… turn in progress (Esc to cancel)")}</Text> : null}

      {mode === "chat" ? <Footer usage={lastUsage} costChf={lastCost} /> : null}

      <Box>
        <Text color="green">{"> "}</Text>
        <TextInput
          value={input}
          focus={!localCardOpen}
          onChange={(v) => {
            if (swallowRef.current && v === "o") return;
            // Un terminal (ou un pilote de pty) peut livrer « /sessions\r » d'un seul bloc : Ink le traite alors comme du
            // texte collé et le retour chariot n'est plus une touche Entrée. On le reconnaît ici.
            const nl = v.search(/[\r\n]/);
            if (nl >= 0) {
              const rest = v.slice(nl + 1).replace(/[\r\n]+/g, "");
              inputRef.current = rest;
              setInput(rest);
              void onSubmit(v.slice(0, nl));
              return;
            }
            inputRef.current = v;
            setInput(v);
          }}
          onSubmit={onSubmit}
        />
      </Box>
    </Box>
  );

  async function decideLocal(decision: "approve" | "reject", scope: ApprovalScope, rule?: string): Promise<void> {
    const a = pendingRef.current;
    const session = sessionRef.current;
    if (!a || !session) return;
    summarizedRef.current.add(a.id);
    setApprovalBusy(true);
    setApprovalMessage(null);
    try {
      const r = await session.decideLocal(a.id, decision, scope, rule);
      const queued = r.continuation === "queued" ? t(" — queued, after the turn in progress") : "";
      pushSystem(`${decisionSummary(a, decision === "approve" ? "approved" : "rejected", scope, rule)}${queued}`);
      pendingRef.current = null;
      pendingLocalRef.current = false;
      setPendingApproval(null);
    } catch (err) {
      summarizedRef.current.delete(a.id);
      setApprovalMessage(t("Failed: {0}", err instanceof NokkerApiError ? err.serverMessage : String(err)));
    } finally {
      setApprovalBusy(false);
    }
  }

  /** Compte à rebours écoulé : refus affiché « expirée » (non compté comme une décision de l'utilisateur). */
  async function expireLocal(): Promise<void> {
    const a = pendingRef.current;
    const session = sessionRef.current;
    if (!a || !session) return;
    summarizedRef.current.add(a.id);
    pushSystem(decisionSummary(a, "expired"));
    pendingRef.current = null;
    pendingLocalRef.current = false;
    setPendingApproval(null);
    try {
      await session.decideLocal(a.id, "reject", "once");
    } catch {
      // déjà expirée côté serveur : sans importance
    }
  }

  async function decide(decision: "approve" | "reject", via: "phone" | "totp", totp?: string): Promise<void> {
    if (!session || !pendingApproval) return;
    setApprovalBusy(true);
    setApprovalMessage(null);
    try {
      if (via === "phone") {
        await session.decideByDevice(pendingApproval, decision);
      } else {
        await session.decideByTotp(pendingApproval, decision, totp ?? "");
      }
      // La carte se ferme via l'événement `approval.decided` reçu en retour (voir handleEvent).
    } catch (err) {
      setApprovalMessage(t("Failed: {0}", String(err)));
    } finally {
      setApprovalBusy(false);
    }
  }
}
