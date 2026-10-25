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
import { AccountTab } from "./components/AccountTab.js";
import { ConnectorsTab, uiLang } from "./components/ConnectorsTab.js";
import { t } from "./onboarding/i18n.js";
import { SoundToggle } from "./components/SoundToggle.js";
import { readJson, writeJson } from "./viewState.js";
import { Icon } from "./icons.js";
import { Welcome } from "./welcome/Welcome.js";

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

type Tab = "chat" | "crew" | "incidents" | "plan" | "team" | "connectors" | "account" | "machine";

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

  useEffect(() => {
    if (!store.crewPulse) return;
    setCrewPulse(true);
    setFreshAgent(store.agents.at(-1)?.id ?? null);
    const t = setTimeout(() => setCrewPulse(false), 2600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.crewPulse]);

  const onDropTarget = useCallback((id: string | null) => setDropTarget(id), []);

  if (store.access !== "ready") {
    return <Welcome {...store} lang={uiLang()} />;
  }

  return (
    <StoreContext.Provider value={store}>
      <div className={`app ${narrow ? "narrow" : ""}`}>
        <a href="#nk-composer" className="skip">
          Aller au message
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
        />
        <main className="main">
          <header className="topbar">
            <nav className="tabs-main" aria-label="Onglets">
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
                    <span className="tab-count" aria-label={`${liveIncidents} incident(s) vivant(s)`}>
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
                  Équipe
                  {teamInvites ? (
                    <span className="tab-count" aria-label={`${teamInvites} invitation(s)`}>
                      {teamInvites}
                    </span>
                  ) : null}
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
              <span className="fine">Session</span>
              <span className="topbar-title">{store.current?.title ?? "—"}</span>
              {store.current?.working ? <span className="live-label">travaille</span> : null}
            </div>
            {store.mock ? <span className="demo-badge">Démo · valeurs fictives</span> : null}
            {tab === "chat" && !narrow && store.bubbles.length > 1 ? (
              <button type="button" className="arrange-btn" onClick={() => setArrangeTick((n) => n + 1)} aria-label="Ranger les bulles">
                <Icon name="crew" size={16} />
                Ranger
              </button>
            ) : null}
            <SoundToggle prefs={store.signature} onChange={store.setSignature} />
            <button
              type="button"
              className="theme-toggle"
              aria-label={theme === "dark" ? "Thème sombre — passer au clair" : "Thème clair — passer au sombre"}
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
          ) : store.ready && tab === "machine" && store.authMode === "local" ? (
            <MachineTab client={store.client} toast={store.toast} />
          ) : store.ready && tab === "account" ? (
            <AccountTab client={store.client} lang={uiLang()} />
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
