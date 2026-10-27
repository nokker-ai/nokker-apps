/**
 * État applicatif du client web, branché sur le SDK (BUBBLES.md) : fils, messages du fil courant, bulles
 * visibles (fil courant + notify sans fil + bulles partagées), agents (Crew), flux d'événements §6.
 */
import { deletionGranted } from "./account/lifecycle.js";
import { messageContent } from "./composer/images.js";
import { applyLiveInputEvent, formatCostLine, type LiveInputs } from "@nokker-apps/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NokkerApiError,
  applyBubbleEvent,
  type Agent,
  type AgentRun,
  type Approval,
  type Bubble,
  type NokkerClient,
  type NokkerEvent,
  type ShareRequest,
  type Thread,
  type ThreadMessage,
  type TransferMode,
} from "@nokker-apps/sdk";
import type { SignaturePrefs } from "@nokker-apps/brand";
import { SERVER_URL, createClient } from "./api.js";
import { t } from "./onboarding/i18n.js";
import { uiLang } from "./components/ConnectorsTab.js";
import { DeviceNotApprovedError, forgetDevice, isMockServer, restoreLogin, type AuthResult } from "./auth.js";
import { knock, loadSignaturePrefs, saveSignaturePrefs } from "./sound.js";
import { readJson, writeJson } from "./viewState.js";
import { shellLang, tr } from "./i18n/index.js";
import { loadAgents, loadMembers, loadOpenNotifications, type Member } from "./extensions.js";
import { applyChatChunk, parseTurnId } from "@nokker-apps/sdk";
import { cwdByThread, mergeLocalSessions } from "./lokkal/sessions.js";

export interface Toast {
  id: number;
  text: string;
  tone?: "ok" | "error";
}

/** `booting` : reprise de session ; `signed-out` : aucun appareil reconnu (écran de connexion) ; `error` : serveur
 * injoignable (réessayer) ; `device-refused` : appareil rangé mais refusé par le noyau (en attente, retiré : voir
 * `deviceStatus`) ; `ready` : connecté. */
export type Access = "booting" | "signed-out" | "error" | "device-refused" | "ready";

export interface NokkerStore {
  client: NokkerClient;
  status: string;
  ready: boolean;
  access: Access;
  /** Relance la reprise de session (après une connexion par code, ou pour réessayer après une erreur). */
  retryAccess(): void;
  /** `device-refused` : statut de l'appareil donné par le noyau (`pending`, `revoked`…). */
  deviceStatus: string | null;
  /** Oublie l'appareil rangé (refusé) et repart de l'écran de connexion. */
  forgetDeviceAndRetry(): void;
  mock: boolean;
  authMode: AuthResult["mode"] | null;
  /** Lokkal local (jeton local) : décision d'une carte d'une session locale (`/v1/local/approvals/{id}/decide`). */
  decideLocal(approval: Approval, decision: "approve" | "reject", scope?: "once" | "session"): Promise<void>;
  /** Signe un défi avec l'appareil de ce navigateur (approbations à distance, page `/approve/…`). */
  signDecision: AuthResult["signDecision"] | null;
  /** Vrai dès que la carte de suppression du compte est accordée depuis ce navigateur : le compte est suspendu (toute
   * requête suivante répond 403), l'app affiche l'écran fixe « suppression en cours ». */
  accountGone: boolean;
  /** Bascule l'app entière sur l'écran fixe (carte accordée vue depuis Mon compte, ou un 403 pendant l'attente). */
  markAccountGone(): void;
  threads: Thread[];
  current: Thread | null;
  messages: ThreadMessage[];
  streaming: string | null;
  /** Réponse d'un tour lancé ailleurs (ask, action de bulle → 202), reçue par `turn.delta` sur /v1/events et
   * affichée tant que `GET /v1/threads/{id}` ne la porte pas encore. */
  live: { turn_id: string; text: string } | null;
  /** Fils qui ont répondu pendant qu'on était ailleurs (compteur client : `unread` vaut 0 côté noyau P1). */
  unseen: Record<string, number>;
  members: Member[];
  sending: boolean;
  bubbles: Bubble[];
  agents: Agent[];
  /** Dernier passage reçu par événement, par agent (`agent.run`, §9.5) : le popout le fusionne à sa liste. */
  agentRuns: Record<string, AgentRun>;
  /** X2 : ligne de coût par tour (`turn_id` → « 12,4 k jetons · 0,03 € »), reçue par `turn.cost` (LOKKAL §7.8). */
  turnCosts: Record<string, string>;
  /** X22 : ce que le modèle est en train d'écrire, par `call_id` (BUBBLES §6) ; clos au `tool.result` ou au `turn.done`. */
  liveInputs: LiveInputs;
  /** X3 : hooks du dépôt pas encore de confiance, par fil (`hook.untrusted`). */
  hookNotices: Record<string, { sha256: string; count: number; notice: string }>;
  /** Cartes fortes déposées chez nokker.ai (`approval.forwarded`) : elles attendent le téléphone, pas le terminal. */
  forwardedApprovals: ReadonlySet<string>;
  /** X18 : change à chaque `incident.updated` / `plan.*` — les onglets Incidents et Plan relisent. */
  opsTick: number;
  trustHooks(threadId: string): Promise<void>;
  /** X2 : totaux de la session courante et du jour (GET /v1/local/cost), `null` si la route n'est pas disponible. */
  costTotals: { session: string | null; day: string } | null;
  crewPulse: number;
  focusBubble: string | null;
  toasts: Toast[];
  signature: SignaturePrefs;
  /** Bulles d'agent en train de « voler » vers l'onglet Crew (animation de sortie dédiée). */
  flying: Set<string>;
  setSignature(p: SignaturePrefs): void;
  selectThread(id: string): void;
  /** Relit la liste des fils (un fil né ailleurs, par exemple celui d'une session de code §7.28). */
  refreshThreads(): Promise<void>;
  /** Événements des sessions de code (§7.28 : `subagent.*`, `skill.untrusted`) pour l'onglet Code ; rend le désabonnement. */
  onCodeEvent(fn: (e: NokkerEvent) => void): () => void;
  createThread(title: string): Promise<void>;
  /** Web servi par Lokkal (auth `local` ou `gateway`) : `thread_id` → dossier des sessions de code ; `{}` ailleurs. */
  codeSessions: Record<string, string>;
  /** Racines où une session de code peut s'ouvrir ; `null` hors Lokkal (pas de « + session de code »). */
  localRoots: string[] | null;
  /** Ouvre une session de code sur `cwd` puis bascule sur son fil ; lève l'erreur du noyau (403 : hors racine). */
  createCodeSession(cwd: string): Promise<void>;
  /** Fil demandé par l'URL (`#/t/<id>`) et introuvable : rien n'est envoyé ailleurs, l'écran le dit. */
  missingThread: string | null;
  deleteThread(id: string): Promise<void>;
  /** `images` : `data:` des images jointes (X7) ; le message part alors en parties texte + image. */
  send(text: string, images?: string[]): Promise<void>;
  closeBubble(b: Bubble): Promise<void>;
  transfer(b: Bubble, toThread: string, mode: TransferMode): Promise<void>;
  share(b: Bubble, req: ShareRequest): Promise<void>;
  runAction(b: Bubble, actionId: string): Promise<void>;
  gotoFromNotify(b: Bubble): void;
  getApproval(id: string): Promise<Approval>;
  /** Identité vérifiée de la session (réponse de `POST /v1/sessions`). */
  user: string | null;
  /** Avec `totp` : `totp_user` = l'identité de la session (APPROVALS.md §3.5). */
  decide(approval: Approval, decision: "approve" | "reject", totp?: string): Promise<void>;
  toast(text: string, tone?: Toast["tone"]): void;
}

function errText(err: unknown): string {
  if (err instanceof NokkerApiError) {
    const m = (err.body as { error?: { message?: string } } | undefined)?.error?.message;
    return m ? `${m} (${err.status})` : err.message;
  }
  return String(err instanceof Error ? err.message : err);
}

function sortThreads(list: Thread[]): Thread[] {
  return [...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function parseHash(): { thread?: string; bubble?: string } {
  const m = window.location.hash.match(/^#\/t\/([^/]+)(?:\/b\/([^/]+))?/);
  return m ? { thread: m[1], bubble: m[2] } : {};
}

export function useNokker(): NokkerStore {
  const client = useMemo(() => createClient(), []);
  const [status, setStatus] = useState(() => tr("connecting…"));
  const [ready, setReady] = useState(false);
  const [access, setAccess] = useState<Access>("booting");
  const [deviceStatus, setDeviceStatus] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [mock, setMock] = useState(false);
  const [auth, setAuth] = useState<AuthResult | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [codeSessions, setCodeSessions] = useState<Record<string, string>>({});
  const [localRoots, setLocalRoots] = useState<string[] | null>(null);
  const [missingThread, setMissingThread] = useState<string | null>(null);
  const codeSessionsRef = useRef<Record<string, string>>({});
  codeSessionsRef.current = codeSessions;
  /** Auth `local` ou `gateway` : le web parle à une machine Lokkal (sessions de code possibles). */
  const lokkalRef = useRef<{ user: string } | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentRuns, setAgentRuns] = useState<Record<string, AgentRun>>({});
  const [turnCosts, setTurnCosts] = useState<Record<string, string>>({});
  const [liveInputs, setLiveInputs] = useState<LiveInputs>(() => new Map());
  const [hookNotices, setHookNotices] = useState<Record<string, { sha256: string; count: number; notice: string }>>({});
  const [forwardedApprovals, setForwardedApprovals] = useState<ReadonlySet<string>>(() => new Set());
  const [opsTick, setOpsTick] = useState(0);
  const [costTotals, setCostTotals] = useState<{ session: string | null; day: string } | null>(null);
  // X2 : totaux relus sur la route du noyau (aucun montant recalculé ici) ; absente (hébergé, mock ancien) = pas d'encart.
  const refreshCost = useCallback(
    async (threadId: string | null) => {
      try {
        const t = await client.getLocalCost(threadId ?? undefined);
        setCostTotals({ session: t.session ? formatCostLine(t.session, shellLang()) : null, day: formatCostLine(t.day, shellLang()) });
      } catch {
        setCostTotals(null);
      }
    },
    [client],
  );
  useEffect(() => {
    if (ready) void refreshCost(currentId);
  }, [ready, currentId, refreshCost]);
  const [members, setMembers] = useState<Member[]>([]);
  const [live, setLive] = useState<{ turn_id: string; text: string } | null>(null);
  const [unseen, setUnseen] = useState<Record<string, number>>({});
  /** Dernière réponse reçue par fil (`turn.delta` est unique par tour côté noyau P1). */
  const deltas = useRef(new Map<string, { turn_id: string; text: string }>());
  const [crewPulse, setCrewPulse] = useState(0);
  const [focusBubble, setFocusBubble] = useState<string | null>(parseHash().bubble ?? null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [signature, setSignatureState] = useState<SignaturePrefs>(() => loadSignaturePrefs());
  const [flying, setFlying] = useState<Set<string>>(() => new Set());

  const currentRef = useRef<string | null>(null);
  const sendingRef = useRef(false);
  const signatureRef = useRef(signature);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastSeq = useRef(0);
  currentRef.current = currentId;
  sendingRef.current = sending;
  signatureRef.current = signature;

  const toast = useCallback((text: string, tone?: Toast["tone"]) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-3), { id, text, ...(tone ? { tone } : {}) }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const setSignature = useCallback((p: SignaturePrefs) => {
    setSignatureState(p);
    saveSignaturePrefs(p);
  }, []);

  const loadThread = useCallback(
    async (id: string, withBubbles: boolean) => {
      let view: Awaited<ReturnType<NokkerClient["getThread"]>>;
      try {
        view = await client.getThread(id);
      } catch (err) {
        // Session de code sans tour : le hub ne la connaît pas encore, la conversation est vide.
        if (err instanceof NokkerApiError && err.status === 404 && codeSessionsRef.current[id]) {
          if (currentRef.current === id) {
            setMessages([]);
            setLive(null);
          }
          return;
        }
        throw err;
      }
      if (currentRef.current !== id) return;
      setMessages(view.messages);
      // Réponse reçue par événement mais pas encore servie par l'historique : on la garde affichée.
      const d = deltas.current.get(id);
      const idx = d ? parseTurnId(d.turn_id)?.index : undefined;
      const maxIdx = view.messages.reduce((m, x) => Math.max(m, x.index), -1);
      if (d && idx !== undefined && idx > maxIdx) setLive(d);
      else {
        deltas.current.delete(id);
        setLive(null);
      }
      // Fil ouvert par un lien et absent de la liste : il y entre.
      setThreads((list) => sortThreads(list.some((t) => t.id === id) ? list.map((t) => (t.id === id ? view.thread : t)) : [...list, view.thread]));
      if (withBubbles) {
        // Les notify sans fil suivent l'utilisateur d'un fil à l'autre.
        setBubbles((cur) => [...cur.filter((b) => b.thread_id === null && !b.closed_at), ...view.bubbles]);
      }
    },
    [client],
  );

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      const id = currentRef.current;
      if (id && !sendingRef.current) void loadThread(id, false).catch(() => undefined);
    }, 160);
  }, [loadThread]);

  /** Session supprimée (par nous ou par un autre client) : retirée du tiroir ; si c'était la courante, on bascule. */
  const dropThread = useCallback(
    (id: string) => {
      setThreads((list) => {
        const rest = list.filter((t) => t.id !== id);
        if (id === currentRef.current) {
          const next = rest[0] ?? null;
          currentRef.current = next?.id ?? null;
          setCurrentId(next?.id ?? null);
          setMessages([]);
          setStreaming(null);
          setLive(null);
          setBubbles((cur) => cur.filter((b) => b.thread_id === null));
          if (next) {
            writeJson("currentThread", next.id);
            void loadThread(next.id, true).catch(() => undefined);
          }
        }
        return rest;
      });
    },
    [loadThread],
  );

  const codeListeners = useRef(new Set<(e: NokkerEvent) => void>());
  const onCodeEvent = useCallback((fn: (e: NokkerEvent) => void) => {
    codeListeners.current.add(fn);
    return () => void codeListeners.current.delete(fn);
  }, []);

  const onEvent = useCallback(
    (e: NokkerEvent) => {
      if (e.type.startsWith("subagent.") || e.type === "skill.untrusted") for (const fn of codeListeners.current) fn(e);
      // X22 : accumulation pure (SDK) ; la même fonction clôt un bloc au tool.result ou au turn.done.
      if (e.type === "tool.input.delta" || e.type === "tool.result" || e.type === "turn.done") setLiveInputs((l) => applyLiveInputEvent(l, e));
      switch (e.type) {
        case "thread.updated":
          setThreads((list) => sortThreads(list.some((t) => t.id === e.thread.id) ? list.map((t) => (t.id === e.thread.id ? e.thread : t)) : [...list, e.thread]));
          if (e.thread.id === currentRef.current) scheduleRefresh();
          return;
        case "thread.deleted":
          dropThread(e.thread_id);
          return;
        case "bubble.created":
        case "bubble.updated":
        case "bubble.closed":
          setBubbles((list) => {
            const next = applyBubbleEvent(list, e, currentRef.current);
            if (e.type === "bubble.created" && next.some((b) => b.id === e.bubble.id) && !list.some((b) => b.id === e.bubble.id)) {
              knock(e.bubble.kind === "notify" ? "notification" : "bubble", signatureRef.current);
            }
            return next;
          });
          return;
        case "attachment.skipped":
          toast(
            e.count === 1
              ? tr("This turn's model cannot read images: yours was replaced by a note.")
              : tr("This turn's model cannot read images: the {0} images were replaced by a note.", e.count),
            "error",
          );
          return;
        case "incident.updated":
        case "plan.card.updated":
        case "plan.card.deleted":
        case "plan.proposal.updated":
          setOpsTick((n) => n + 1);
          return;
        case "approval.forwarded":
          setForwardedApprovals((cur) => (cur.has(e.approval_id) ? cur : new Set(cur).add(e.approval_id)));
          return;
        case "hook.untrusted":
          setHookNotices((h) => ({ ...h, [e.thread_id]: { sha256: e.sha256, count: e.count, notice: e.notice } }));
          return;
        case "memory.noted":
          // X1 : la mémoire du projet (ou de l'utilisateur) vient d'apprendre quelque chose : visible, jamais muet.
          toast(e.scope === "user" ? tr("Saved to memory (for you): {0}", e.title) : tr("Saved to memory: {0}", e.title), "ok");
          return;
        case "memory.forgotten":
          toast(tr("Forgotten: {0}", e.name), "ok");
          return;
        case "agent.updated":
          setAgents((a) => (a.some((x) => x.id === e.agent.id) ? a.map((x) => (x.id === e.agent.id ? e.agent : x)) : [...a, e.agent]));
          return;
        case "agent.deleted":
          setAgents((a) => a.filter((x) => x.id !== e.id));
          return;
        case "agent.run":
          setAgentRuns((r) => ({ ...r, [e.agent_id]: e.run }));
          return;
        case "agent.created":
          setAgents((a) => [...a.filter((x) => x.id !== e.agent.id), e.agent]);
          setCrewPulse((n) => n + 1);
          return;
        case "turn.delta":
          deltas.current.set(e.thread_id, { turn_id: e.turn_id, text: e.text });
          if (e.thread_id === currentRef.current) {
            // Notre propre tour arrive déjà par le flux de /v1/chat/completions.
            if (!sendingRef.current) setLive({ turn_id: e.turn_id, text: e.text });
          } else {
            setUnseen((u) => ({ ...u, [e.thread_id]: (u[e.thread_id] ?? 0) + 1 }));
          }
          return;
        case "turn.cost":
          setTurnCosts((c) => ({ ...c, [e.turn_id]: formatCostLine(e, shellLang()) }));
          if (e.thread_id === currentRef.current) void refreshCost(e.thread_id);
          return;
        case "turn.done":
          if (e.thread_id === currentRef.current) scheduleRefresh();
          return;
        case "session.message":
          if (e.to_thread === currentRef.current || e.from_thread === currentRef.current) scheduleRefresh();
          return;
        default:
          return;
      }
    },
    [scheduleRefresh, toast, refreshCost],
  );

  // Connexion, chargement initial, flux d'événements.
  useEffect(() => {
    let sub: { close(): void } | undefined;
    let cancelled = false;
    (async () => {
      try {
        const isMock = await isMockServer(SERVER_URL);
        if (cancelled) return;
        setMock(isMock);
        setAccess("booting");
        const a = await restoreLogin(client, isMock);
        if (cancelled) return;
        if (!a) {
          setAccess("signed-out");
          return;
        }
        if (cancelled) return;
        setAuth(a);
        let list = sortThreads(await client.listThreads());
        lokkalRef.current = a.mode === "local" || a.mode === "gateway" ? { user: a.user } : null;
        if (lokkalRef.current) {
          // Sessions de code : celles sans tour ne sont pas encore des fils du hub ; racines pour le « + ».
          try {
            const { sessions, roots } = await client.listLocalSessionsAndRoots();
            setCodeSessions(cwdByThread(sessions));
            codeSessionsRef.current = cwdByThread(sessions);
            setLocalRoots(roots);
            list = sortThreads(mergeLocalSessions(list, sessions, a.user, new Date().toISOString()));
          } catch {
            setLocalRoots([]);
          }
        }
        if (list.length === 0) {
          // Premier passage (vrai noyau, aucun fil) : sans fil courant, la saisie n'avait nulle part où envoyer.
          list = [await client.createThread(tr("General"))];
        }
        // Lien direct `#/t/<id>` : CE fil, chargé s'il manque à la liste ; introuvable, aucun autre fil n'est pris à
        // sa place (un message partirait au mauvais endroit).
        const linked = parseHash().thread;
        let first = list.find((t) => t.id === (linked ?? readJson<string | null>("currentThread", null))) ?? null;
        if (!first && linked) {
          try {
            first = (await client.getThread(linked)).thread;
            list = sortThreads([...list, first]);
          } catch {
            setMissingThread(linked);
          }
        } else if (!first) first = list[0] ?? null;
        setThreads(list);
        if (first) {
          currentRef.current = first.id;
          setCurrentId(first.id);
          await loadThread(first.id, true);
        }
        // Routes en cours d'ajout côté noyau (p1/bubbles-gaps) : points d'appel dans extensions.ts.
        setAgents(await loadAgents(client));
        setMembers(await loadMembers(client));
        const notes = await loadOpenNotifications(client);
        if (notes.length) setBubbles((cur) => [...cur.filter((b) => !notes.some((n) => n.id === b.id)), ...notes]);
        sub = client.subscribeEvents({
          onEvent,
          onReconnected: () => {
            setStatus(tr("connected"));
            void client.listThreads().then(async (l) => {
              let merged = l;
              if (lokkalRef.current) {
                const { sessions } = await client.listLocalSessionsAndRoots().catch(() => ({ sessions: [] }));
                if (sessions.length) setCodeSessions(cwdByThread(sessions));
                merged = mergeLocalSessions(l, sessions, lokkalRef.current.user, new Date().toISOString());
              }
              setThreads(sortThreads(merged));
            });
            if (currentRef.current) void loadThread(currentRef.current, true);
          },
          onError: () => setStatus(tr("reconnecting…")),
        });
        setStatus(tr("connected"));
        setAccess("ready");
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DeviceNotApprovedError) {
          setDeviceStatus(err.deviceStatus);
          setAccess("device-refused");
          return;
        }
        setStatus(tr("connection failed: {0}", errText(err)));
        setAccess("error");
      }
    })();
    return () => {
      cancelled = true;
      sub?.close();
    };
  }, [client, loadThread, onEvent, attempt]);

  const retryAccess = useCallback(() => setAttempt((n) => n + 1), []);
  const forgetDeviceAndRetry = useCallback(() => {
    void forgetDevice().then(() => {
      setDeviceStatus(null);
      setAttempt((n) => n + 1);
    });
  }, []);

  const selectThread = useCallback(
    (id: string) => {
      if (id === currentRef.current) return;
      currentRef.current = id;
      setCurrentId(id);
      setMissingThread(null);
      setMessages([]);
      setStreaming(null);
      setLive(null);
      setUnseen((u) => ({ ...u, [id]: 0 }));
      setBubbles((cur) => cur.filter((b) => b.thread_id === null));
      writeJson("currentThread", id);
      try {
        history.replaceState(null, "", `#/t/${id}`);
      } catch {
        /* pas d'historique (aperçu) */
      }
      void loadThread(id, true).catch((err) => {
        // Fil introuvable (lien, fil supprimé) : on ne reste sur aucun fil plutôt que d'en garder un autre.
        if (err instanceof NokkerApiError && (err.status === 404 || err.status === 403) && currentRef.current === id) {
          currentRef.current = null;
          setCurrentId(null);
          setMissingThread(id);
        } else toast(errText(err), "error");
      });
    },
    [loadThread, toast],
  );

  // Lien `#/t/<id>` suivi pendant que l'app est ouverte (autre onglet, notification) : on va sur CE fil.
  useEffect(() => {
    if (!ready) return;
    const onHash = (): void => {
      const id = parseHash().thread;
      if (id && id !== currentRef.current) selectThread(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [ready, selectThread]);

  const refreshThreads = useCallback(async () => setThreads(sortThreads(await client.listThreads())), [client]);

  const deleteThread = useCallback(
    async (id: string) => {
      try {
        await client.deleteThread(id);
        dropThread(id);
      } catch (err) {
        toast(errText(err), "error");
      }
    },
    [client, dropThread, toast],
  );

  const createCodeSession = useCallback(
    async (cwd: string) => {
      const s = await client.createLocalSession({ cwd });
      setCodeSessions((c) => ({ ...c, [s.thread_id]: s.cwd }));
      codeSessionsRef.current = { ...codeSessionsRef.current, [s.thread_id]: s.cwd };
      const user = lokkalRef.current?.user ?? "";
      setThreads((l) => sortThreads(mergeLocalSessions(l, [{ thread_id: s.thread_id, cwd: s.cwd, title: null }], user, new Date().toISOString())));
      selectThread(s.thread_id);
    },
    [client, selectThread],
  );

  const createThread = useCallback(
    async (title: string) => {
      try {
        const t = await client.createThread(title);
        setThreads((l) => sortThreads([...l.filter((x) => x.id !== t.id), t]));
        selectThread(t.id);
      } catch (err) {
        toast(errText(err), "error");
      }
    },
    [client, selectThread, toast],
  );

  const send = useCallback(
    async (text: string, images: string[] = []) => {
      const id = currentRef.current;
      if (!id || (!text.trim() && images.length === 0)) return;
      setSending(true);
      sendingRef.current = true;
      const shown = images.length ? `${text}${text ? "\n\n" : ""}_${images.length === 1 ? tr("1 image attached") : tr("{0} images attached", images.length)}_` : text;
      setMessages((m) => [...m, { index: (m.at(-1)?.index ?? -1) + 1, role: "user", content: shown }]);
      setStreaming("");
      try {
        // Jetons en direct (CLIENT-API.md §Streaming) : `nokker.reset` vide le texte en cours (l'appel a fini en
        // outils → l'animation de réflexion reprend), le chunk final `nokker.final` porte la réponse qui fait foi.
        let current = "";
        const content = messageContent(text, images.map((dataUrl) => ({ dataUrl })));
        await client.streamChatCompletion(id, [{ role: "user", content }], (chunk) => {
          const next = applyChatChunk(current, chunk);
          if (next !== current) {
            current = next;
            setStreaming(next);
          }
        });
      } catch (err) {
        toast(errText(err), "error");
      } finally {
        sendingRef.current = false;
        setSending(false);
        if (currentRef.current === id) {
          await loadThread(id, false).catch(() => undefined);
        }
        setStreaming(null);
      }
    },
    [client, loadThread, toast],
  );

  const guard = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        toast(errText(err), "error");
      }
    },
    [toast],
  );

  const closeBubble = useCallback((b: Bubble) => guard(() => client.closeBubble(b.id)), [client, guard]);

  const transfer = useCallback(
    (b: Bubble, to: string, mode: TransferMode) =>
      guard(async () => {
        await client.transferBubble(b.id, to, mode);
        const title = threads.find((t) => t.id === to)?.title ?? to;
        toast(mode === "copy" ? tr("Copy of “{0}” sent to {1}.", b.title, title) : tr("“{0}” moved to {1}.", b.title, title), "ok");
      }),
    [client, guard, threads, toast],
  );

  const share = useCallback((b: Bubble, req: ShareRequest) => guard(() => client.shareBubble(b.id, req)), [client, guard]);

  const runAction = useCallback(
    (b: Bubble, actionId: string) =>
      guard(async () => {
        if (b.kind === "agent_draft" && actionId === "activate") setFlying((s) => new Set(s).add(b.id));
        const res = await client.bubbleAction(b.id, actionId);
        // Une action d'une bulle non-notify devient un tour du fil (202) : ses effets arrivent par les événements.
        if ("accepted" in res && b.kind !== "agent_draft") toast(tr("Action “{0}” handed to Nina.", b.actions.find((a) => a.id === actionId)?.label ?? actionId), "ok");
      }),
    [client, guard, toast],
  );

  const gotoFromNotify = useCallback(
    (b: Bubble) => {
      if (b.kind !== "notify") return;
      // Action implicite `goto` (§8) : ferme la notify et renvoie le fil source.
      selectThread(b.state.from_thread);
      void client.bubbleAction(b.id, "goto").catch(() => undefined);
    },
    [client, selectThread],
  );

  const decideLocal = useCallback(
    async (approval: Approval, decision: "approve" | "reject", scope: "once" | "session" = "once") => {
      const r = await client.decideLocalApproval(approval.id, { decision, scope } as Parameters<typeof client.decideLocalApproval>[1]);
      // 202 : une suite tourne (continuation) ; refus : rien ne tourne après.
      if (decision === "approve" && (r as { continuation?: string }).continuation === "queued") toast(tr("Approved: the action will run after the current turn."), "ok");
    },
    [client, toast],
  );

  const trustHooks = useCallback(
    async (threadId: string) => {
      const n = hookNotices[threadId];
      if (!n) return;
      try {
        await client.trustProjectHooks(threadId, n.sha256);
        setHookNotices((h) => {
          const next = { ...h };
          delete next[threadId];
          return next;
        });
        toast(tr("Repository hooks approved for this folder."), "ok");
      } catch (err) {
        const st = err instanceof NokkerApiError ? err.status : 0;
        toast(
          st === 409
            ? tr("The hooks file changed since the session opened: reopen the session to read it again.")
            : st === 403
              ? tr("Trust can only be given on the machine itself.")
              : errText(err),
          "error",
        );
      }
    },
    [client, hookNotices, toast],
  );

  const getApproval = useCallback((id: string) => client.getApproval(id), [client]);

  const [accountGone, setAccountGone] = useState(false);
  const markAccountGone = useCallback(() => setAccountGone(true), []);
  const decide = useCallback(
    async (approval: Approval, decision: "approve" | "reject", totp?: string) => {
      if (totp !== undefined) {
        if (approval.strength === "strong") throw new Error("Niveau strong : signature d'appareil obligatoire, jamais de TOTP.");
        const totpUser = auth?.user;
        if (!totpUser) throw new Error(tr("Session without an identity: sign in again."));
        // Le défi reste obligatoire même sur ce chemin (anti-rejeu/anti-falsification, APPROVALS.md §2/§3.5).
        const { challenge } = await client.requestChallenge(approval.id);
        await client.decideApproval(approval.id, { decision, challenge, totp, totp_user: totpUser });
        return;
      }
      if (!auth?.signDecision) throw new Error(tr("No device enrolled in this browser: use the TOTP code."));
      const { challenge } = await client.requestChallenge(approval.id);
      const proof = await auth.signDecision(challenge, decision);
      try {
        const decided = await client.decideApproval(approval.id, {
          decision,
          device_id: proof.device_id,
          challenge,
          ...(proof.signature !== undefined ? { signature: proof.signature } : {}),
          ...(proof.webauthn ? { webauthn: proof.webauthn } : {}),
        } as Parameters<typeof client.decideApproval>[1]);
        if (deletionGranted(decided)) setAccountGone(true);
      } catch (err) {
        if (err instanceof NokkerApiError && err.status === 403 && (err.serverMessage === "strong_device_required" || (err.body as { error?: unknown } | undefined)?.error === "strong_device_required")) {
          throw new Error(t(uiLang(), "strongRequired"));
        }
        throw err;
      }
    },
    [auth, client],
  );

  // Nettoie la liste des bulles « en vol » une fois l'animation jouée.
  useEffect(() => {
    if (!flying.size) return;
    const t = setTimeout(() => setFlying(new Set()), 1600);
    return () => clearTimeout(t);
  }, [flying]);

  useEffect(() => {
    if (!focusBubble) return;
    const t = setTimeout(() => setFocusBubble(null), 2400);
    return () => clearTimeout(t);
  }, [focusBubble]);

  return {
    client,
    status,
    ready,
    access,
    retryAccess,
    deviceStatus,
    forgetDeviceAndRetry,
    mock,
    authMode: auth?.mode ?? null,
    signDecision: auth?.signDecision ?? null,
    accountGone,
    markAccountGone,
    decideLocal,
    user: auth?.user ?? null,
    threads,
    current: threads.find((t) => t.id === currentId) ?? null,
    messages,
    streaming,
    live,
    unseen,
    members,
    sending,
    bubbles,
    agents,
    agentRuns,
    turnCosts,
    liveInputs,
    hookNotices,
    forwardedApprovals,
    opsTick,
    trustHooks,
    costTotals,
    crewPulse,
    focusBubble,
    toasts,
    signature,
    flying,
    setSignature,
    selectThread,
    refreshThreads,
    onCodeEvent,
    createThread,
    codeSessions,
    localRoots,
    createCodeSession,
    missingThread,
    deleteThread,
    send,
    closeBubble,
    transfer,
    share,
    runAction,
    gotoFromNotify,
    getApproval,
    decide,
    toast,
  };
}
