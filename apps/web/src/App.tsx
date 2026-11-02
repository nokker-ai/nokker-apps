import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { isSessionThread } from "@nokker-apps/sdk";
import { BRAND } from "@nokker-apps/brand";
import { useNokker } from "./store.js";
import { StoreContext } from "./context.js";
import { Drawer } from "./components/Drawer.js";
import { Chat } from "./components/Chat.js";
import { BubbleLayer } from "./components/BubbleLayer.js";
import { DeletingScreen } from "./components/DeletingScreen.js";
import { FirstSteps } from "./onboarding/FirstSteps.js";
import { SessionModeBar, modeTarget } from "./modes/SessionModeBar.js";
import { ConnectorsTab, uiLang } from "./components/ConnectorsTab.js";
import { tr } from "./i18n/index.js";
import { t } from "./onboarding/i18n.js";
import { AccountMenu } from "./nav/AccountMenu.js";
import { LearningView } from "./learning/LearningView.js";
import { CommandPalette, type Command } from "./nav/CommandPalette.js";
import { navViews, type ViewId } from "./nav/views.js";
import { readJson, writeJson } from "./viewState.js";
import { Icon } from "./icons.js";
import { KnockIndicator } from "./knock/KnockIndicator.js";
import { PresenceMenu } from "./presence/PresenceMenu.js";
import { onKnock, playYes, stopKnock } from "./knock/controller.js";
import { Welcome } from "./welcome/Welcome.js";
import { h as hhText } from "./household/model.js";
import { anchorVia, showMeEnabled } from "./showme/model.js";
import { ShowMeOverlay } from "./showme/ShowMeOverlay.js";
import { pointLocally } from "./showme/local.js";
import { GuidePanel } from "./guide/GuidePanel.js";
import { guideEnabled, parseGuideCommand } from "./guide/model.js";

// Tabs other than chat and connectors load on first opening: the first screen does not download them.
const HouseView = lazy(() => import("./house/HouseView.js").then((m) => ({ default: m.HouseView })));
const CrewTab = lazy(() => import("./components/CrewTab.js").then((m) => ({ default: m.CrewTab })));
const MachineTab = lazy(() => import("./components/MachineTab.js").then((m) => ({ default: m.MachineTab })));
const TeamTab = lazy(() => import("./components/TeamTab.js").then((m) => ({ default: m.TeamTab })));
const IncidentsTab = lazy(() => import("./components/IncidentsTab.js").then((m) => ({ default: m.IncidentsTab })));
const PlanTab = lazy(() => import("./components/PlanTab.js").then((m) => ({ default: m.PlanTab })));
const PacksTab = lazy(() => import("./packs/PacksTab.js").then((m) => ({ default: m.PacksTab })));
const HouseholdTab = lazy(() => import("./household/HouseholdTab.js").then((m) => ({ default: m.HouseholdTab })));
const FolderView = lazy(() => import("./folder/FolderView.js").then((m) => ({ default: m.FolderView })));
const CodeTab = lazy(() => import("./code/CodeTab.js").then((m) => ({ default: m.CodeTab })));
const AccountTab = lazy(() => import("./components/AccountTab.js").then((m) => ({ default: m.AccountTab })));

function useMedia(q: string): boolean {
  const get = (): boolean => {
    try {
      return window.matchMedia(q).matches;
    } catch {
      return false;
    }
  };
  const [m, setM] = useState(get);
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(q);
    } catch {
      return;
    }
    const on = (): void => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

type Tab = ViewId;

const SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K";

/** Bureau Nokker : tiroir (vues de travail + sessions) + chat ; les bulles flottent au-dessus ; compte et réglages
 * derrière un menu ; tout est aussi dans la palette (Ctrl/⌘ K). Plus de rangée d'onglets en haut. */
export function App(): React.ReactElement {
  const store = useNokker();
  const narrow = useMedia("(max-width: 760px)");
  // `/journey` : « Ce que Nokker a appris » ouvert d'emblée (lien direct, docs/LEARNING.md).
  const journey = typeof location !== "undefined" && location.pathname === "/journey";
  const [wanted, setTab] = useState<Tab>(() => (journey ? "learning" : readJson<Tab>("tab", "chat")));
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [crewPulse, setCrewPulse] = useState(false);
  const [freshAgent, setFreshAgent] = useState<string | null>(null);
  const [arrangeTick, setArrangeTick] = useState(0);
  // Téléphone : les sessions sont dans un tiroir fermé par défaut ; le chat garde toute la largeur.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const fabRef = useRef<HTMLButtonElement>(null);
  const closeDrawer = useCallback((refocus = false) => {
    setDrawerOpen(false);
    if (refocus) fabRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);
  useEffect(() => {
    if (!drawerOpen) return;
    // Focus sur la session courante (une liste de sélecteurs rendrait le premier du document : le « + »).
    for (const q of ["#nk-drawer .session-row.current", "#nk-drawer .session-row", "#nk-drawer button"]) {
      const el = document.querySelector<HTMLElement>(q);
      if (el) {
        el.focus();
        break;
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeDrawer(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, closeDrawer]);
  // Thème : CLAIR par défaut (choix produit), sombre seulement sur réglage explicite (mémorisé).
  const [theme, setTheme] = useState<"light" | "dark">(() => readJson<"light" | "dark">("theme", "light"));
  useEffect(() => {
    if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    writeJson("theme", theme);
  }, [theme]);

  useEffect(() => {
    document.title = store.current ? `${store.current.title} · ${BRAND.productName}` : BRAND.productName;
  }, [store.current]);

  useEffect(() => writeJson("tab", wanted), [wanted]);

  // X17 : l'onglet Équipe n'existe que si nokker.ai sert les projets (drapeau `team` ; sinon 404 comme avant).
  const [teamInvites, setTeamInvites] = useState<number | null>(null);
  useEffect(() => {
    if (!store.ready || store.authMode === "local") return;
    let live = true;
    store.client.listProjects().then(
      (r) => live && setTeamInvites(r.invitations),
      () => live && setTeamInvites(null),
    );
    return () => {
      live = false;
    };
  }, [store.ready, store.authMode, store.client]);

  // Apprentissage (lots 16, 18, 19, 25) : la vue n'existe que si un des drapeaux du noyau la sert (sinon 404 partout) ;
  // la pastille = notes de mémoire et règles suggérées qui attendent. Relu au démarrage, toutes les 2 min et après une
  // décision prise dans la vue.
  const [learning, setLearning] = useState<number | null>(null);
  const [learningTick, setLearningTick] = useState(0);
  useEffect(() => {
    if (!store.ready) return;
    let live = true;
    const probe = (): void => {
      void Promise.allSettled([store.client.listPendingMemory(), store.client.listApprovalSuggestions(), store.client.getLearningJournal(1)]).then(([p, s, j]) => {
        if (!live) return;
        if (p.status === "rejected" && s.status === "rejected" && j.status === "rejected") return setLearning(null);
        setLearning((p.status === "fulfilled" ? p.value.notes.length : 0) + (s.status === "fulfilled" ? s.value.suggestions.length : 0));
      });
    };
    probe();
    const t = setInterval(probe, 120_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [store.ready, store.client, learningTick]);

  // X23 : l'onglet Foyer n'existe que si nokker.ai sert les foyers (drapeau `household` ; sinon 404). Le nombre affiché =
  // invitations reçues quand on n'a pas encore de foyer.
  const [householdInvites, setHouseholdInvites] = useState<number | null>(null);
  useEffect(() => {
    if (!store.ready || store.authMode === "local") return;
    let live = true;
    store.client.listReceivedHouseholdInvitations().then(
      (r) => live && setHouseholdInvites(r.invitations.length),
      () => live && setHouseholdInvites(null),
    );
    return () => {
      live = false;
    };
  }, [store.ready, store.authMode, store.client]);

  // « Maison » (HOUSE-ROOM §6, flags house_room + household): the view exists only if GET /v1/house answers.
  const [houseOn, setHouseOn] = useState(false);
  useEffect(() => {
    if (!store.ready || store.authMode === "local") return;
    let live = true;
    store.client.getHouse().then(
      () => live && setHouseOn(true),
      () => live && setHouseOn(false),
    );
    return () => {
      live = false;
    };
  }, [store.ready, store.authMode, store.client]);

  // X18 : Incidents (drapeau `operate`) et Plan (drapeau `plan`) n'existent que si leurs routes répondent.
  const [liveIncidents, setLiveIncidents] = useState<number | null>(null);
  const [planOn, setPlanOn] = useState(false);
  useEffect(() => {
    if (!store.ready) return;
    let live = true;
    store.client.listIncidents({ state: "live" }).then(
      (r) => live && setLiveIncidents(r.incidents.length),
      () => live && setLiveIncidents(null),
    );
    store.client.listPlanCards({ roots: true }).then(
      () => live && setPlanOn(true),
      () => live && setPlanOn(false),
    );
    return () => {
      live = false;
    };
  }, [store.ready, store.client]);

  // §7.30 : Packs si nokker.ai les sert (drapeau `packs_web`), ou dans Lokkal (jeton local).
  const [packsOn, setPacksOn] = useState(false);
  useEffect(() => {
    if (!store.ready) return;
    let live = true;
    (store.authMode === "local" ? store.client.listLocalPacks() : store.client.listPacks()).then(
      () => live && setPacksOn(true),
      () => live && setPacksOn(false),
    );
    return () => {
      live = false;
    };
  }, [store.ready, store.authMode, store.client]);

  // Mode dossier (FOLDER-MODE §6) : sur la machine Lokkal seulement, si le noyau sert GET /v1/local/folder/runs.
  const [folderOn, setFolderOn] = useState(false);
  useEffect(() => {
    if (!store.ready || store.authMode !== "local") return;
    let live = true;
    store.client.listFolderRuns().then(
      () => live && setFolderOn(true),
      () => live && setFolderOn(false),
    );
    return () => {
      live = false;
    };
  }, [store.ready, store.authMode, store.client]);

  // §7.28 : Code si le noyau sert les sessions de code d'un compte (drapeau `code.enabled` ; sinon 404, onglet absent).
  const [codeOn, setCodeOn] = useState(false);
  useEffect(() => {
    if (!store.ready || store.authMode === "local") return;
    let live = true;
    store.client.listCodeSessions().then(
      () => live && setCodeOn(true),
      () => live && setCodeOn(false),
    );
    return () => {
      live = false;
    };
  }, [store.ready, store.authMode, store.client]);

  useEffect(() => {
    if (!store.crewPulse) return;
    setCrewPulse(true);
    setFreshAgent(store.agents.at(-1)?.id ?? null);
    const t = setTimeout(() => setCrewPulse(false), 2600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.crewPulse]);

  const onDropTarget = useCallback((id: string | null) => setDropTarget(id), []);

  const lang = uiLang();
  const views = navViews(
    {
      agents: store.agents.length,
      liveIncidents,
      plan: planOn,
      teamInvites,
      householdInvites,
      packs: packsOn,
      code: codeOn,
      local: store.authMode === "local",
      learning,
      house: houseOn,
      folder: folderOn,
    },
    {
      team: tr("Team"),
      household: hhText(lang, "tab"),
      connectors: t(lang, "tabConnectors"),
      account: t(lang, "tabAccount"),
      incidents: (n) => tr("{0} live incident(s)", n),
      invitations: (n) => tr("{0} invitation(s)", n),
      learning: tr("Learning"),
      waiting: (n) => tr("{0} waiting for you", n),
      house: tr("Home"),
      folder: tr("Folder"),
    },
  );
  // Une vue mémorisée dont le drapeau n'est pas (ou pas encore) servi : le chat, jusqu'à ce que sa sonde réponde.
  const tab: Tab = wanted === "chat" || views.some((v) => v.id === wanted) ? wanted : "chat";
  const viewInfo = views.find((v) => v.id === tab);
  const openView = useCallback(
    (v: Tab) => {
      setTab(v);
      closeDrawer();
    },
    [closeDrawer],
  );

  // « Toc toc toc » (réglage Frapper pour appeler) : « oui ? » joué ici, compositeur du fil courant, toast discret.
  // Rien n'est envoyé au noyau : le web ne fait qu'appeler, il n'approuve jamais une carte.
  // Seulement dans l'app principale : jamais sur l'accueil ni sur l'écran « suppression en cours » (le micro y est
  // libéré). /invite, /setup et les autres pages ne montent pas App : rien n'y écoute.
  const { toast } = store;
  const shell = !store.accountGone && store.access === "ready";
  useEffect(() => {
    if (!shell) {
      stopKnock();
      return;
    }
    return onKnock(() => {
      playYes();
      openView("chat");
      toast(tr("Knock knock knock"));
      requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById("nk-composer")?.focus()));
    });
  }, [shell, openView, toast]);

  // Le Guide (docs/GUIDE.md) : drapeau web VITE_NOKKER_GUIDE=1 ET `GET /v1/guide` 200 ; sinon aucune requête, aucune entrée.
  const [guideOn, setGuideOn] = useState(false);
  const [guide, setGuide] = useState<{ q: string; n: number } | null>(null);
  useEffect(() => {
    if (!guideEnabled() || !store.ready) return;
    let live = true;
    store.client.getGuide().then(
      () => live && setGuideOn(true),
      () => live && setGuideOn(false),
    );
    return () => {
      live = false;
    };
  }, [store.ready, store.client]);
  const openGuide = useCallback((q = "") => setGuide((g) => ({ q, n: (g?.n ?? 0) + 1 })), []);
  const guideCommand = useCallback(
    (text: string): boolean => {
      const c = guideOn ? parseGuideCommand(text) : null;
      if (!c) return false;
      openGuide(c.question);
      return true;
    },
    [guideOn, openGuide],
  );

  // Palette de commandes : Ctrl/⌘ K partout (même depuis le champ du message).
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const unreadElsewhere = store.threads.filter((x) => isSessionThread(x) && x.id !== store.current?.id).reduce((n, x) => n + (x.unread || (store.unseen[x.id] ?? 0)), 0);

  const commands: Command[] = [
    { id: "v-chat", group: tr("Go to"), label: tr("Chat"), icon: "chat", hint: store.current?.title, run: () => openView("chat") },
    ...views.map((v) => ({ id: `v-${v.id}`, group: tr("Go to"), label: v.label, keywords: v.id, icon: v.icon, run: () => openView(v.id) })),
    ...store.threads.filter(isSessionThread).map((x) => ({
      id: `s-${x.id}`,
      group: tr("Sessions"),
      label: x.title,
      keywords: store.codeSessions[x.id] ?? "",
      icon: store.codeSessions[x.id] ? ("folder" as const) : ("chat" as const),
      hint: x.working ? tr("working") : undefined,
      run: () => {
        store.selectThread(x.id);
        openView("chat");
      },
    })),
    ...(guideOn ? [{ id: "a-guide", group: tr("Go to"), label: tr("Discover"), keywords: "guide discover", icon: "bot" as const, run: () => openGuide() }] : []),
    { id: "a-theme", group: tr("Actions"), label: theme === "dark" ? tr("Switch to the light theme") : tr("Switch to the dark theme"), keywords: "theme dark light", icon: theme === "dark" ? "sun" : "moon", run: () => setTheme((m) => (m === "dark" ? "light" : "dark")) },
    {
      id: "a-sound",
      group: tr("Actions"),
      label: store.signature.sound ? tr("Turn the bubble sound off") : tr("Turn the bubble sound on"),
      keywords: "sound knock",
      icon: store.signature.sound ? "soundOff" : "soundOn",
      run: () => store.setSignature({ ...store.signature, sound: !store.signature.sound }),
    },
    ...(tab === "chat" && !narrow && store.bubbles.length > 1 ? [{ id: "a-arrange", group: tr("Actions"), label: tr("Arrange the bubbles"), icon: "crew" as const, run: () => setArrangeTick((n) => n + 1) }] : []),
  ];

  if (store.accountGone) return <DeletingScreen lang={uiLang()} />;
  const modeAt = store.ready ? modeTarget(store.current?.id, store.current ? store.codeSessions[store.current.id] : undefined, store.authMode === "local") : null;
  if (store.access !== "ready") {
    return <Welcome {...store} lang={uiLang()} />;
  }

  return (
    <StoreContext.Provider value={store}>
      <div className={`app ${narrow ? "narrow" : ""} ${narrow && drawerOpen ? "drawer-open" : ""}`}>
        <a href="#nk-composer" className="skip">
          {tr("Skip to message")}
        </a>
        <Drawer
          id="nk-drawer"
          closed={narrow && !drawerOpen}
          threads={store.threads}
          unseen={store.unseen}
          currentId={store.current?.id ?? null}
          dropTargetId={dropTarget}
          places={views.filter((v) => v.group === "work")}
          view={tab}
          onOpenView={openView}
          crewPulse={crewPulse}
          crewTarget={!narrow}
          onSelect={(id) => {
            store.selectThread(id);
            setTab("chat");
            closeDrawer();
          }}
          onCreate={(t) => {
            void store.createThread(t);
            closeDrawer();
          }}
          onDelete={(id) => void store.deleteThread(id)}
          codeSessions={store.codeSessions}
          roots={store.localRoots}
          onCreateCode={store.localRoots !== null ? async (cwd) => {
            await store.createCodeSession(cwd);
            setTab("chat");
            closeDrawer();
          } : undefined}
        />
        {narrow && drawerOpen ? <button type="button" className="drawer-scrim" aria-label={tr("Close the session list")} onClick={() => closeDrawer(true)} /> : null}
        {narrow ? (
          <button
            ref={fabRef}
            type="button"
            className={`drawer-fab ${crewPulse ? "pulse" : ""}`}
            data-crew-tab
            {...anchorVia(["sessions", "new_session"])}
            aria-controls="nk-drawer"
            aria-expanded={drawerOpen}
            aria-label={unreadElsewhere ? tr("Sessions, {0} unread", unreadElsewhere) : tr("Sessions")}
            onClick={() => setDrawerOpen((o) => !o)}
          >
            <Icon name="menu" size={20} />
            {unreadElsewhere ? (
              <span className="drawer-fab-count" aria-hidden="true">
                {unreadElsewhere > 99 ? "99+" : unreadElsewhere}
              </span>
            ) : null}
          </button>
        ) : null}
        <main className="main">
          <header className={`topbar ${tab === "chat" && store.current?.working ? "working" : ""}`}>
            {tab !== "chat" ? (
              <button type="button" className="back-chat" onClick={() => openView("chat")} aria-label={tr("Back to the chat: {0}", store.current?.title ?? tr("Chat"))} title={tr("Back to the chat: {0}", store.current?.title ?? tr("Chat"))}>
                <Icon name="back" size={18} />
                <span className="back-chat-label">{store.current?.title ?? tr("Chat")}</span>
              </button>
            ) : null}
            <div className="topbar-session">
              {tab === "chat" ? (
                <>
                  <h1 className="topbar-title">{store.current?.title ?? "—"}</h1>
                  {store.current && store.codeSessions[store.current.id] ? (
                    <span className="topbar-cwd mono" title={store.codeSessions[store.current.id]}>
                      {store.codeSessions[store.current.id]}
                    </span>
                  ) : null}
                  {store.current?.working ? <span className="live-label">{tr("working")}</span> : null}
                </>
              ) : (
                <h1 className="topbar-title topbar-view">{viewInfo?.label ?? ""}</h1>
              )}
            </div>
            {store.mock ? (
              <span className="demo-badge" title={tr("Demo · fictitious values")}>
                <span className="demo-long">{tr("Demo · fictitious values")}</span>
                <span className="demo-short">{tr("Demo")}</span>
              </span>
            ) : null}
            <PresenceMenu
              client={store.client}
              ready={store.ready && store.authMode !== "local"}
              onEvent={store.onCodeEvent}
              onOpen={(d) => {
                if (d.view === "chat") store.selectThread(d.thread);
                openView(d.view);
              }}
            />
            <KnockIndicator />
            <button type="button" className="palette-btn" onClick={() => setPalette(true)} aria-label={tr("Search and commands ({0})", SHORTCUT)} aria-haspopup="dialog">
              <Icon name="search" size={18} />
              <kbd className="kbd" aria-hidden="true">
                {SHORTCUT}
              </kbd>
            </button>
            <AccountMenu
              views={views}
              current={tab}
              onOpen={openView}
              theme={theme}
              onTheme={() => setTheme((m) => (m === "dark" ? "light" : "dark"))}
              sound={store.signature}
              onSound={store.setSignature}
              status={store.status}
              ready={store.ready}
              onPalette={() => setPalette(true)}
              shortcut={SHORTCUT}
              onArrange={tab === "chat" && !narrow && store.bubbles.length > 1 ? () => setArrangeTick((n) => n + 1) : undefined}
              {...(guideOn ? { onGuide: () => openGuide() } : {})}
            />
            <span className="sr-only" role="status">
              {store.status}
            </span>
          </header>

          <Suspense fallback={<div className="boot fine">{tr("loading…")}</div>}>
          <div className={`view view-${tab}`} key={tab}>
          {tab === "chat" ? (
            <div className="chat-area">
              {store.missingThread ? (
                <p className="missing-thread error" role="alert">
                  {tr("Thread {0} cannot be found: nothing will be sent. Choose a session in the list.", store.missingThread)}
                </p>
              ) : null}
              {narrow ? <BubbleLayer inline onDropTarget={onDropTarget} /> : null}
              {modeAt ? <SessionModeBar key={modeAt.threadId} client={store.client} target={modeAt} onEvent={store.onCodeEvent} onSend={(t) => void store.send(t, [])} toast={store.toast} compact={narrow} /> : null}
              <Chat
                title={store.current?.title ?? ""}
                messages={store.messages}
                streaming={store.streaming}
                live={store.live}
                sending={store.sending}
                onSend={(t, images) => store.send(t, images)}
                {...(guideOn ? { onCommand: guideCommand } : {})}
                threadId={store.current?.id ?? null}
                client={store.client}
                turnCosts={store.turnCosts}
                costTotals={store.costTotals}
                writing={[...store.liveInputs.values()].filter((w) => w.threadId === store.current?.id)}
                hookNotice={store.current ? (store.hookNotices[store.current.id] ?? null) : null}
                onTrustHooks={store.authMode === "local" && store.current ? () => void store.trustHooks(store.current!.id) : undefined}
                empty={(fill) => (
                  <FirstSteps
                    client={store.client}
                    lang={uiLang()}
                    fill={fill}
                    onConnect={store.authMode === "device-key" || store.authMode === "passkey" ? () => setTab("account") : undefined}
                  />
                )}
              />
            </div>
          ) : tab === "crew" ? (
            <CrewTab
              agents={store.agents}
              freshId={freshAgent}
              client={store.client}
              agentRuns={store.agentRuns}
              toast={store.toast}
              onOpenThread={(id) => {
                store.selectThread(id);
                setTab("chat");
              }}
            />
          ) : store.ready && tab === "incidents" && liveIncidents !== null ? (
            <IncidentsTab
              client={store.client}
              tick={store.opsTick}
              toast={store.toast}
              onLive={setLiveIncidents}
              onOpenThread={(id) => {
                store.selectThread(id);
                setTab("chat");
              }}
            />
          ) : store.ready && tab === "plan" && planOn ? (
            <PlanTab client={store.client} tick={store.opsTick} toast={store.toast} currentThread={store.current ? { id: store.current.id, title: store.current.title } : null} />
          ) : store.ready && tab === "team" && teamInvites !== null ? (
            <TeamTab client={store.client} toast={store.toast} onInvitations={setTeamInvites} />
          ) : store.ready && tab === "household" && householdInvites !== null ? (
            <HouseholdTab client={store.client} lang={uiLang()} toast={store.toast} signDecision={store.signDecision ?? null} onReceived={setHouseholdInvites} />
          ) : store.ready && tab === "packs" && packsOn ? (
            <PacksTab
              client={store.client}
              local={store.authMode === "local"}
              currentThread={store.current ? { id: store.current.id, title: store.current.title } : null}
              toast={store.toast}
              onOpenThread={(id) => {
                store.selectThread(id);
                setTab("chat");
              }}
            />
          ) : store.ready && tab === "code" && codeOn ? (
            <CodeTab
              client={store.client}
              lang={uiLang()}
              toast={store.toast}
              decide={store.decide}
              onCodeEvent={store.onCodeEvent}
              onOpenThread={(id) =>
                void store
                  .refreshThreads()
                  .catch(() => undefined)
                  .then(() => {
                    store.selectThread(id);
                    setTab("chat");
                  })
              }
            />
          ) : store.ready && tab === "folder" && folderOn && store.authMode === "local" ? (
            <FolderView client={store.client} />
          ) : store.ready && tab === "machine" && store.authMode === "local" ? (
            <MachineTab client={store.client} toast={store.toast} />
          ) : store.ready && tab === "house" && houseOn ? (
            <HouseView client={store.client} onEvent={store.onCodeEvent} toast={store.toast} />
          ) : store.ready && tab === "learning" && learning !== null ? (
            <LearningView
              client={store.client}
              lang={lang}
              initial={journey ? "journal" : "pending"}
              onOpenThread={(id) => {
                store.selectThread(id);
                openView("chat");
              }}
              onChanged={() => setLearningTick((n) => n + 1)}
            />
          ) : store.ready && tab === "account" ? (
            <AccountTab
              client={store.client}
              lang={uiLang()}
              onGone={store.markAccountGone}
              onSignOut={store.authMode === "device-key" || store.authMode === "passkey" ? store.forgetDeviceAndRetry : undefined}
            />
          ) : store.ready && tab === "connectors" ? (
            <ConnectorsTab client={store.client} lang={uiLang()} />
          ) : null}
          </div>
          </Suspense>
          {!store.ready ? <div className="boot fine">{store.status}</div> : null}
        </main>
        {tab === "chat" && !narrow ? <BubbleLayer inline={false} onDropTarget={onDropTarget} arrangeTick={arrangeTick} /> : null}
        {palette ? (
          <CommandPalette
            commands={commands}
            onClose={() => setPalette(false)}
            create={(title) => {
              void store.createThread(title);
              openView("chat");
            }}
          />
        ) : null}
        {showMeEnabled() && tab === "chat" ? <ShowMeOverlay /> : null}
        {guideOn && guide ? (
          <GuidePanel
            key={guide.n}
            client={store.client}
            served={views.map((v) => v.id)}
            initialQuestion={guide.q}
            onClose={() => setGuide(null)}
            onOpenView={(screen) => {
              setGuide(null);
              openView(screen as Tab);
            }}
            onShowMe={(ui) => {
              setGuide(null);
              openView("chat");
              requestAnimationFrame(() => requestAnimationFrame(() => pointLocally(ui)));
            }}
          />
        ) : null}
        <div className="toasts" aria-live="polite">
          {store.toasts.map((t) => (
            <div key={t.id} className={`toast ${t.tone ?? ""}`}>
              {t.text}
            </div>
          ))}
        </div>
      </div>
    </StoreContext.Provider>
  );
}
