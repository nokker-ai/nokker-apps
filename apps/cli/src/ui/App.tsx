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
  parseToolJson,
} from "@nokker-apps/sdk";
import { connect, login } from "../auth.js";
import { cliLog } from "../log.js";
import { CliSession } from "../session.js";
import {
  NOT_LOCAL_MESSAGE,
  parseCheckpointDiff,
  parseCheckpointList,
  applySubagentEvent,
  formatCheckpoints,
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
import { HELP_TEXT, parseSlashCommand } from "../commands.js";
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
  const [status, setStatus] = useState("connexion…");
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
  /** `/rollback` : cartes de restauration dont on attend le `tool.result` (approval_id -> point visé). */
  const restoreWaitRef = useRef<Map<string, string>>(new Map());
  const restoreDoneRef = useRef<Map<string, { content: string; is_error: boolean }>>(new Map());
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

  const localCardOpen = pendingApproval !== null && pendingLocal;

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
      if (done || !quiet) pushSystem(done ? "⏹ annulation demandée…" : "Aucun tour en cours.");
    } catch (err) {
      pushSystem(`Annulation impossible : ${String(err)}`);
    }
  }

  useEffect(() => {
    let sub: { close(): void } | undefined;
    (async () => {
      const client = new NokkerClient({ baseUrl, userAgent: BRAND.userAgent });
      clientRef.current = client;
      setStatus("connexion…");

      let conn;
      try {
        conn = await connect(client, baseUrl, `cli-${process.platform}`, {
          onPending: (d) => {
            pendingDeviceRef.current = { id: d.id, user: d.user };
            pushSystem(
              `Appareil en attente de confirmation — code ${d.code || "(voir l'hôte)"}. Confirme-le sur l'hôte ou tape /confirm <code TOTP>.`,
            );
            setStatus("appareil en attente");
          },
        });
      } catch (err) {
        setStatus("échec de connexion");
        cliLog("error", `connexion impossible : ${String(err)}`);
        pushSystem(`Connexion impossible à ${baseUrl} : ${String(err)} — \`nokker doctor\` dit ce qui répond.`);
        return;
      }
      setStatus(conn.mode === "local" ? "connecté (jeton local)" : `connecté (${conn.user})`);

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
          cliLog("warn", `flux d'événements coupé : ${String(err)}`);
          pushSystem(`(événements) coupés : ${String(err).replace(/^Error: /, "")} — reconnexion automatique…`);
        },
        onReconnected: () => {
          eventsDownRef.current = false;
          pushSystem("(événements) reconnecté — relance /approvals ou /bubbles si l'état a bougé.");
        },
      });

      try {
        const opened = await session.openLocal(cwd);
        setFolder(basename(cwd) || cwd);
        setThreadLabel(session.threadId);
        if (opened.messages.length) setFeed(feedFromMessages(opened.messages));
        pushSystem(`Session de code sur ${cwd} (${opened.resumed ? "reprise" : "nouvelle"}). /help pour les commandes.`);
      } catch (err) {
        if (err instanceof NokkerApiError && err.status === 403) {
          pushSystem(`Dossier hors des racines déclarées par le serveur : ${cwd}. Fil ordinaire ouvert à la place.`);
        } else if (err instanceof NokkerApiError && (err.status === 404 || err.status === 405)) {
          pushSystem("Ce serveur ne propose pas de session de code locale — fil ordinaire.");
        } else {
          pushSystem(`Session locale impossible : ${String(err)} — fil ordinaire.`);
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
          pushSystem(`Approbation ${event.approval_id} : ${event.decision} par ${event.by} (${event.via}).`);
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
              restoreDoneRef.current.set(event.approval_id, { content: event.content ?? event.preview ?? "", is_error: event.is_error === true });
              showRestoreResult(event.approval_id);
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
        if (event.thread_id !== session.threadId) return;
        subagentsRef.current = applySubagentEvent(subagentsRef.current, event);
        setFeed((f) => [...f, { kind: "sub", id: `sub:${event.child_id}`, childId: event.child_id, text: `↳ sous-agent ${event.child_id} : ${event.goal}` }]);
        return;
      case "subagent.progress":
        subagentsRef.current = applySubagentEvent(subagentsRef.current, event);
        setFeed((f) => f.map((it) => (it.kind === "sub" && it.childId === event.child_id ? { ...it, text: `↳ sous-agent ${event.child_id} : ${event.tool} (${event.ms} ms)` } : it)));
        return;
      case "subagent.finished":
        subagentsRef.current = applySubagentEvent(subagentsRef.current, event);
        setFeed((f) =>
          f.map((it) =>
            it.kind === "sub" && it.childId === event.child_id
              ? { ...it, text: `↳ sous-agent ${event.child_id} terminé (${event.status}) — ${event.commits} commit(s), arbre ${event.dirty ? "modifié" : "propre"}` }
              : it,
          ),
        );
        return;
      case "turn.delta":
        // Le texte de NOTRE propre fil arrive déjà via le flux direct de /v1/chat/completions —
        // on ignore ici pour ne pas le doubler ; un autre fil/canal reste visible (multi-canal).
        // turn.delta est UNIQUE par tour côté noyau (réponse complète) : on l'affiche d'un bloc.
        if (event.thread_id !== session.threadId) pushSystem(`[autre fil ${event.thread_id}] ${event.text}`);
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
          if (event.cancelled) pushSystem("⏹ tour annulé.");
        }
        return;
      case "thread.updated":
        if (event.thread.id === session.threadId) setThreadLabel(event.thread.title || session.threadId);
        return;
      case "bubble.created":
        setBubbles((b) => applyBubbleEvent(b, event, session.threadId));
        ringBell(sound);
        if (event.bubble.kind === "notify") {
          pushSystem(`(bulle) notify de « ${event.bubble.state.from_title} » — ${event.bubble.state.text} — /goto ${event.bubble.state.from_thread}`);
        }
        return;
      case "bubble.updated":
      case "bubble.closed":
        setBubbles((b) => applyBubbleEvent(b, event, session.threadId));
        return;
      case "bubble.transferred":
        pushSystem(`Bulle ${event.mode === "copy" ? "copiée" : "déplacée"} (${event.from_thread} → ${event.to_thread}).`);
        return;
      case "session.message":
        // Déjà couvert par la bulle `notify` associée (bubble.created ci-dessus) — pas de doublon.
        return;
      case "agent.created":
        pushSystem(`Nouvel agent créé : ${event.agent.name} (onglet Crew).`);
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
    if (!local) pushSystem(`Carte d'approbation reçue pour le fil ${card.thread_id} (niveau ${card.strength}).`);
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
      pushSystem(`connexion en cours — « ${text.length > 40 ? `${text.slice(0, 39)}…` : text} » partira dès que la session sera prête.`);
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
      pushSystem("Pas encore connecté.");
      return;
    }
    if (sending) {
      pushSystem("Un tour est déjà en cours — Échap (ou /cancel) pour l'annuler.");
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
      pushSystem(`Erreur d'envoi : ${String(err)}`);
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
        pushSystem(HELP_TEXT);
        return;

      case "renamedNew":
        pushSystem("/new n'existe plus ici (celui du noyau pose une frontière d'épisode) — utilise /thread [titre] pour un nouveau fil.");
        return;

      case "thread": {
        if (!session) return;
        const title = cmd.title ?? "Sans titre";
        try {
          const thread = await session.createNamedThread(title);
          setFeed([]);
          setBubbles([]);
          setFolder(null);
          setThreadLabel(thread.title);
          setLastUsage(null);
          pushSystem(`Nouveau fil « ${thread.title} » (${thread.id}).`);
        } catch (err) {
          pushSystem(`Erreur /thread : ${String(err)}`);
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
          pushSystem(parsed.message ?? "Aucune différence depuis ce point de retour.");
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
          pushSystem(list.length ? `Point de retour introuvable : ${cmd.target} (/checkpoints)` : "Aucun point de retour.");
          return;
        }
        const label = `${cp.short_hash} (${cp.reason})`;
        try {
          const r = await session.callTool("checkpoint_restore", { hash: cp.hash, safe: true });
          if ("approval_id" in r) {
            // La carte arrive par approval.requested ; le résumé, par le tool.result portant cet approval_id.
            restoreWaitRef.current.set(r.approval_id, label);
            showRestoreResult(r.approval_id);
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
        if (skills) pushSystem(formatSkills(skills));
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
        pushSystem(formatSubagents(subagentsRef.current));
        return;
      }

      case "cost": {
        if (!session) return;
        try {
          pushSystem(formatCostTotals(await session.getCost()));
        } catch (err) {
          if (err instanceof NokkerApiError && [404, 405].includes(err.status)) pushSystem("/cost : non disponible sur ce serveur (noyau local seulement)");
          else pushSystem(toolCallError("/cost", err));
        }
        return;
      }

      case "cancel":
        await cancelCurrent();
        return;

      case "out": {
        if (lastToolRef.current) toggleExpanded(lastToolRef.current);
        else pushSystem("Aucun appel d'outil à déplier.");
        return;
      }

      case "confirm": {
        const client = clientRef.current;
        const dev = pendingDeviceRef.current;
        if (!client || !dev) {
          pushSystem("Aucun appareil en attente de confirmation.");
          return;
        }
        if (!cmd.totp) {
          pushSystem("Usage : /confirm <code TOTP>");
          return;
        }
        try {
          await client.confirmDevice(dev.id, { totp: cmd.totp, user: dev.user });
          pushSystem("Appareil confirmé.");
        } catch (err) {
          pushSystem(`Confirmation refusée : ${String(err)}`);
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
          pushSystem(`Erreur /sessions : ${String(err)}`);
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
          pushSystem(`Erreur /bubbles : ${String(err)}`);
        }
        setMode("bubbles");
        return;
      }

      case "bubble": {
        if (!session) return;
        if (!cmd.id) {
          pushSystem("Usage : /bubble <id|titre>");
          return;
        }
        const local = resolveBubbleLocal(cmd.id);
        try {
          const b = local ?? (await session.getBubble(cmd.id));
          pushSystem(`◇ ${b.title} [${b.kind}/${b.status}] (${b.id}) — ${summarizeState(b)}`);
        } catch {
          pushSystem(`Bulle introuvable : ${cmd.id}`);
        }
        return;
      }

      case "send": {
        if (!session) return;
        if (!cmd.bubble || !cmd.session) {
          pushSystem("Usage : /send <bulle> <session> [--copy]");
          return;
        }
        const bubble = resolveBubbleLocal(cmd.bubble);
        if (!bubble) {
          pushSystem(`Bulle introuvable ici : ${cmd.bubble} (essaie /bubbles pour la liste).`);
          return;
        }
        const target = await resolveThreadId(cmd.session);
        if (!target) {
          pushSystem(`Session introuvable : ${cmd.session}`);
          return;
        }
        try {
          const transferMode = cmd.copy ? "copy" : "move";
          await session.transferBubble(bubble.id, target.id, transferMode);
          pushSystem(`Bulle « ${bubble.title} » ${cmd.copy ? "copiée" : "déplacée"} vers « ${target.title} ».`);
        } catch (err) {
          pushSystem(`Erreur /send : ${String(err)}`);
        }
        return;
      }

      case "ask": {
        if (!session) return;
        if (!cmd.session || !cmd.text) {
          pushSystem("Usage : /ask <session> <texte>");
          return;
        }
        const target = await resolveThreadId(cmd.session);
        if (!target) {
          pushSystem(`Session introuvable : ${cmd.session}`);
          return;
        }
        try {
          await session.sendAsk(target.id, cmd.text);
          pushSystem(`Question transmise à « ${target.title} » — sa réponse arrivera ici par une notification.`);
        } catch (err) {
          pushSystem(`Erreur /ask : ${String(err)}`);
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
        pushSystem("Re-connexion…");
        const token = await login(client, `cli-${process.platform}`, {
          onPending: (d) => {
            pendingDeviceRef.current = { id: d.id, user: d.user };
            pushSystem(`Appareil en attente — code ${d.code}. /confirm <code TOTP> ou confirmation sur l'hôte.`);
          },
        });
        session?.setUser(token.user);
        setStatus(`connecté (${token.user})`);
        pushSystem("Connecté.");
        return;
      }

      case "tools":
        setToolsExpanded((v) => !v);
        return;

      case "unknown":
        pushSystem(`Commande inconnue : /${cmd.name} — /help pour la liste.`);
        return;
    }
  }

  /** Les commandes d'outils du noyau n'existent que dans une session de code (dossier). */
  function localOnly(session: CliSession): boolean {
    if (session.cwd) return true;
    pushSystem(NOT_LOCAL_MESSAGE);
    return false;
  }

  async function callTool(session: CliSession, name: LocalToolName, args: Record<string, unknown> = {}): Promise<LocalToolResult | null> {
    try {
      const r = await session.callTool(name, args);
      if ("approval_id" in r) {
        pushSystem(`${name} : en attente d'approbation (${r.approval_id}).`);
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
    if (err instanceof NokkerApiError && err.status === 409) return "un tour est en cours, réessayez après";
    return `Erreur ${label} : ${err instanceof NokkerApiError ? err.serverMessage : String(err)}`;
  }

  async function listCheckpoints(session: CliSession): Promise<CheckpointInfo[] | null> {
    const r = await callTool(session, "checkpoint_list");
    const list = r ? parseCheckpointList(r.content) : undefined;
    if (r && !list) pushSystem("Réponse checkpoint_list illisible.");
    return list ?? null;
  }

  /** `/diff [hash|n]` : `undefined` = erreur déjà affichée, `""` = dernier point. */
  async function resolveCheckpointArg(session: CliSession, arg: string | null): Promise<string | undefined> {
    if (arg === null) return "";
    const list = await listCheckpoints(session);
    if (!list) return undefined;
    const cp = resolveCheckpoint(list, arg);
    if (!cp) {
      pushSystem(`Point de retour introuvable : ${arg} (/checkpoints)`);
      return undefined;
    }
    return cp.hash;
  }

  function showRestore(content: string, isError: boolean, label: string): void {
    const r = parseToolJson<CheckpointRestoreResult>(content);
    if (isError || !r) pushSystem(`✗ Retour à ${label} : ${isError ? content : "réponse illisible"}`);
    else pushSystem(formatRestore(r, label));
  }

  /** Résumé du retour une fois le tool.result reçu (dans un sens ou l'autre de l'arrivée de l'approval_id). */
  function showRestoreResult(approvalId: string): void {
    const label = restoreWaitRef.current.get(approvalId);
    const done = restoreDoneRef.current.get(approvalId);
    if (label === undefined || !done) return;
    restoreWaitRef.current.delete(approvalId);
    restoreDoneRef.current.delete(approvalId);
    showRestore(done.content, done.is_error, label);
  }

  async function gotoThread(session: CliSession, query: string): Promise<void> {
    const target = await resolveThreadId(query);
    if (!target) {
      pushSystem(`Session introuvable : ${query}`);
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
      pushSystem(`Basculé sur « ${view.thread.title} » (${view.thread.id}).`);
      setMode("chat");
    } catch (err) {
      pushSystem(`Erreur de bascule : ${String(err)}`);
    }
  }

  const session = sessionRef.current;
  submitRef.current = onSubmit;

  return (
    <Box flexDirection="column">
      <Header threadLabel={threadLabel} folder={folder} status={status} />

      {mode === "threads" ? (
        <Box flexDirection="column" borderStyle="single" paddingX={1}>
          <Text bold>Fils :</Text>
          {threads.length === 0 ? <Text dimColor>(aucun)</Text> : null}
          {threads.map((t) => (
            <Text key={t.id}>
              {t.working ? "● " : "○ "}
              {t.id} — {t.title} ({t.bubble_count} bulle(s))
            </Text>
          ))}
          <Text dimColor>/sessions &lt;requête&gt; ou /goto &lt;requête&gt; pour basculer · /new [titre] pour repartir</Text>
        </Box>
      ) : null}

      {mode === "sessions" ? (
        <Box flexDirection="column" borderStyle="single" paddingX={1}>
          <Text bold>Sessions de code :</Text>
          {localSessions.length === 0 ? <Text dimColor>(aucune)</Text> : null}
          {localSessions.map((l) => (
            <Text key={l.thread_id}>
              {l.thread_id === sessionRef.current?.threadId ? "● " : "○ "}
              {l.title ?? basename(l.cwd)} — {l.cwd} ({l.thread_id}){l.last_turn_at ? ` · dernier tour ${l.last_turn_at}` : ""}
            </Text>
          ))}
          <Text dimColor>/sessions &lt;dossier&gt; pour basculer · /threads pour tous les fils</Text>
        </Box>
      ) : null}

      {mode === "approvals" ? (
        <Box flexDirection="column" borderStyle="single" paddingX={1}>
          <Text bold>Approbations :</Text>
          {approvalsList.length === 0 ? <Text dimColor>(aucune)</Text> : null}
          {approvalsList.map((a) => (
            <Text key={a.id}>
              {a.id} — {a.tool_name} [{a.effect}/{a.strength}] {a.status}
            </Text>
          ))}
        </Box>
      ) : null}

      {mode === "bubbles" ? (
        <Box flexDirection="column" borderStyle="single" paddingX={1}>
          <Text bold>Bulles de ce fil :</Text>
          {bubbles.length === 0 ? <Text dimColor>(aucune)</Text> : null}
          {bubbles.map((b) => (
            <BubbleLine key={b.id} bubble={b} spinnerFrame={spinnerFrame} />
          ))}
          <Text dimColor>/bubble &lt;id|titre&gt; pour le détail · /send &lt;bulle&gt; &lt;session&gt; [--copy]</Text>
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
                  {item.omitted > 0 ? <Text dimColor>… {item.omitted} ligne(s) de plus non affichée(s) (300 premières lignes)</Text> : null}
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

      {sending && !pendingApproval ? <Text dimColor>… tour en cours (Échap pour annuler)</Text> : null}

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
      const queued = r.continuation === "queued" ? " — en file, après le tour en cours" : "";
      pushSystem(`${decisionSummary(a, decision === "approve" ? "approved" : "rejected", scope, rule)}${queued}`);
      pendingRef.current = null;
      pendingLocalRef.current = false;
      setPendingApproval(null);
    } catch (err) {
      summarizedRef.current.delete(a.id);
      setApprovalMessage(`Échec : ${err instanceof NokkerApiError ? err.serverMessage : String(err)}`);
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
      setApprovalMessage(`Échec : ${String(err)}`);
    } finally {
      setApprovalBusy(false);
    }
  }
}
