import React, { useCallback, useEffect, useState } from "react";
import { BRAND } from "@nokker-apps/brand";
import { useNokker } from "./store.js";
import { StoreContext } from "./context.js";
import { Drawer } from "./components/Drawer.js";
import { Chat } from "./components/Chat.js";
import { BubbleLayer } from "./components/BubbleLayer.js";
import { CrewTab } from "./components/CrewTab.js";
import { MachineTab } from "./components/MachineTab.js";
import { TeamTab } from "./components/TeamTab.js";
import { IncidentsTab } from "./components/IncidentsTab.js";
import { PlanTab } from "./components/PlanTab.js";
import { AccountTab, DeletingScreen } from "./components/AccountTab.js";
import { ConnectorsTab, uiLang } from "./components/ConnectorsTab.js";
import { tr } from "./i18n/index.js";
import { t } from "./onboarding/i18n.js";
import { SoundToggle } from "./components/SoundToggle.js";
import { readJson, writeJson } from "./viewState.js";
import { Icon } from "./icons.js";
import { Welcome } from "./welcome/Welcome.js";
import { PacksTab } from "./packs/PacksTab.js";
import { HouseholdTab } from "./household/HouseholdTab.js";
import { CodeTab } from "./code/CodeTab.js";
import { h as hhText } from "./household/model.js";

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

type Tab = "chat" | "crew" | "incidents" | "plan" | "team" | "household" | "packs" | "code" | "connectors" | "account" | "machine";

/** Bureau Nokker : tiroir de sessions + chat ; les bulles flottent au-dessus ; Crew en onglet. */
export function App(): React.ReactElement {
  const store = useNokker();
  const narrow = useMedia("(max-width: 760px)");
  const [tab, setTab] = useState<Tab>(() => readJson<Tab>("tab", "chat"));
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [crewPulse, setCrewPulse] = useState(false);
  const [freshAgent, setFreshAgent] = useState<string | null>(null);
  const [arrangeTick, setArrangeTick] = useState(0);
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

  useEffect(() => writeJson("tab", tab), [tab]);

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

  // Barre d'onglets défilante (téléphone) : l'onglet actif, même restauré du stockage ou apparu après sa sonde, reste en
  // vue.
  useEffect(() => {
    document.querySelector(".tabs-main .tab-main.on")?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [tab, store.access, codeOn, packsOn, planOn, liveIncidents === null, teamInvites === null, householdInvites === null]);

  useEffect(() => {
    if (!store.crewPulse) return;
    setCrewPulse(true);
    setFreshAgent(store.agents.at(-1)?.id ?? null);
    const t = setTimeout(() => setCrewPulse(false), 2600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.crewPulse]);

  const onDropTarget = useCallback((id: string | null) => setDropTarget(id), []);

  if (store.accountGone) return <DeletingScreen lang={uiLang()} />;
  if (store.access !== "ready") {
    return <Welcome {...store} lang={uiLang()} />;
  }

  return (
    <StoreContext.Provider value={store}>
      <div className={`app ${narrow ? "narrow" : ""}`}>
        <a href="#nk-composer" className="skip">
          {tr("Skip to message")}
        </a>
        <Drawer
          threads={store.threads}
          unseen={store.unseen}
          currentId={store.current?.id ?? null}
          dropTargetId={dropTarget}
          onSelect={(id) => {
            store.selectThread(id);
            setTab("chat");
          }}
          onCreate={(t) => void store.createThread(t)}
          onDelete={(id) => void store.deleteThread(id)}
          codeSessions={store.codeSessions}
          roots={store.localRoots}
          onCreateCode={store.localRoots !== null ? async (cwd) => {
            await store.createCodeSession(cwd);
            setTab("chat");
          } : undefined}
        />
        <main className="main">
          <header className="topbar">
            <nav className="tabs-main" aria-label={tr("Tabs")}>
              <button type="button" className={`tab-main ${tab === "chat" ? "on" : ""}`} aria-current={tab === "chat" ? "page" : undefined} onClick={() => setTab("chat")}>
                Chat
              </button>
              <button
                type="button"
                data-crew-tab
                className={`tab-main ${tab === "crew" ? "on" : ""} ${crewPulse ? "pulse" : ""}`}
                aria-current={tab === "crew" ? "page" : undefined}
                onClick={() => setTab("crew")}
              >
                Crew<span className="tab-count">{store.agents.length}</span>
              </button>
              {liveIncidents !== null ? (
                <button type="button" className={`tab-main ${tab === "incidents" ? "on" : ""}`} aria-current={tab === "incidents" ? "page" : undefined} onClick={() => setTab("incidents")}>
                  Incidents
                  {liveIncidents ? (
                    <span className="tab-count" aria-label={tr("{0} live incident(s)", liveIncidents)}>
                      {liveIncidents}
                    </span>
                  ) : null}
                </button>
              ) : null}
              {planOn ? (
                <button type="button" className={`tab-main ${tab === "plan" ? "on" : ""}`} aria-current={tab === "plan" ? "page" : undefined} onClick={() => setTab("plan")}>
                  Plan
                </button>
              ) : null}
              {teamInvites !== null ? (
                <button type="button" className={`tab-main ${tab === "team" ? "on" : ""}`} aria-current={tab === "team" ? "page" : undefined} onClick={() => setTab("team")}>
                  {tr("Team")}
                  {teamInvites ? (
                    <span className="tab-count" aria-label={tr("{0} invitation(s)", teamInvites)}>
                      {teamInvites}
                    </span>
                  ) : null}
                </button>
              ) : null}
              {householdInvites !== null ? (
                <button type="button" className={`tab-main ${tab === "household" ? "on" : ""}`} aria-current={tab === "household" ? "page" : undefined} onClick={() => setTab("household")}>
                  {hhText(uiLang(), "tab")}
                  {householdInvites ? (
                    <span className="tab-count" aria-label={tr("{0} invitation(s)", householdInvites)}>
                      {householdInvites}
                    </span>
                  ) : null}
                </button>
              ) : null}
              {packsOn ? (
                <button type="button" className={`tab-main ${tab === "packs" ? "on" : ""}`} aria-current={tab === "packs" ? "page" : undefined} onClick={() => setTab("packs")}>
                  Packs
                </button>
              ) : null}
              {codeOn ? (
                <button type="button" className={`tab-main ${tab === "code" ? "on" : ""}`} aria-current={tab === "code" ? "page" : undefined} onClick={() => setTab("code")}>
                  Code
                </button>
              ) : null}
              <button type="button" className={`tab-main ${tab === "connectors" ? "on" : ""}`} aria-current={tab === "connectors" ? "page" : undefined} onClick={() => setTab("connectors")}>
                {t(uiLang(), "tabConnectors")}
              </button>
              <button type="button" className={`tab-main ${tab === "account" ? "on" : ""}`} aria-current={tab === "account" ? "page" : undefined} onClick={() => setTab("account")}>
                {t(uiLang(), "tabAccount")}
              </button>
              {store.authMode === "local" ? (
                <button type="button" className={`tab-main ${tab === "machine" ? "on" : ""}`} aria-current={tab === "machine" ? "page" : undefined} onClick={() => setTab("machine")}>
                  Machine
                </button>
              ) : null}
            </nav>
            <div className="topbar-session">
              <span className="fine">{tr("Session")}</span>
              <span className="topbar-title">{store.current?.title ?? "—"}</span>
              {store.current && store.codeSessions[store.current.id] ? (
                <span className="topbar-cwd mono" title={store.codeSessions[store.current.id]}>
                  {store.codeSessions[store.current.id]}
                </span>
              ) : null}
              {store.current?.working ? <span className="live-label">{tr("working")}</span> : null}
            </div>
            {store.mock ? <span className="demo-badge">{tr("Demo · fictitious values")}</span> : null}
            {tab === "chat" && !narrow && store.bubbles.length > 1 ? (
              <button type="button" className="arrange-btn" onClick={() => setArrangeTick((n) => n + 1)} aria-label={tr("Arrange the bubbles")}>
                <Icon name="crew" size={16} />
                {tr("Arrange")}
              </button>
            ) : null}
            <SoundToggle prefs={store.signature} onChange={store.setSignature} />
            <button
              type="button"
              className="theme-toggle"
              aria-label={theme === "dark" ? tr("Dark theme — switch to light") : tr("Light theme — switch to dark")}
              aria-pressed={theme === "dark"}
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
            </button>
            <span className={`conn ${store.ready ? "ok" : ""}`} role="status" title={store.status}>
              <span className="sr-only">{store.status}</span>
            </span>
          </header>

          {tab === "chat" ? (
            <div className="chat-area">
              {store.missingThread ? (
                <p className="missing-thread error" role="alert">
                  {tr("Thread {0} cannot be found: nothing will be sent. Choose a session in the list.", store.missingThread)}
                </p>
              ) : null}
              {narrow ? <BubbleLayer inline onDropTarget={onDropTarget} /> : null}
              <Chat
                title={store.current?.title ?? ""}
                messages={store.messages}
                streaming={store.streaming}
                live={store.live}
                sending={store.sending}
                onSend={(t, images) => void store.send(t, images)}
                threadId={store.current?.id ?? null}
                client={store.client}
                turnCosts={store.turnCosts}
                costTotals={store.costTotals}
                writing={[...store.liveInputs.values()].filter((w) => w.threadId === store.current?.id)}
                hookNotice={store.current ? (store.hookNotices[store.current.id] ?? null) : null}
                onTrustHooks={store.authMode === "local" && store.current ? () => void store.trustHooks(store.current!.id) : undefined}
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
          ) : store.ready && tab === "machine" && store.authMode === "local" ? (
            <MachineTab client={store.client} toast={store.toast} />
          ) : store.ready && tab === "account" ? (
            <AccountTab client={store.client} lang={uiLang()} onGone={store.markAccountGone} />
          ) : store.ready ? (
            <ConnectorsTab client={store.client} lang={uiLang()} />
          ) : null}
          {!store.ready ? <div className="boot fine">{store.status}</div> : null}
        </main>
        {tab === "chat" && !narrow ? <BubbleLayer inline={false} onDropTarget={onDropTarget} arrangeTick={arrangeTick} /> : null}
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
