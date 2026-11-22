import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { isSessionThread, type Thread } from "@nokker-apps/sdk";
import { BRAND } from "@nokker-apps/brand";
import { useNokker } from "./store.js";
import { StoreContext } from "./context.js";
import { Drawer, type UnifiedDrawer } from "./components/Drawer.js";
import { useOrigins } from "./sessions/useOrigins.js";
import { mirrorOf, parseThreadRoute, unifiedRows } from "./sessions/origins.js";
import { clearShare, onShareSignal, pendingShares, shareTitle, sharePrefill, type Prefill } from "./platform/share.js";
import { watchZoneEvents } from "./platform/zones.js";
import { answerRequest, declareCaps, pimPlugin } from "./platform/pim.js";
import { deviceName } from "./components/DeviceCard.js";
import { readStoredDeviceKey } from "./auth.js";
import { nokkerAccountUrl } from "./gateway/auth.js";
import type { DeviceRequestEvent } from "@nokker-apps/sdk";
import { Chat } from "./components/Chat.js";
import { BubbleLayer } from "./components/BubbleLayer.js";
import { DeletingScreen } from "./components/DeletingScreen.js";
import { TermsReaccept } from "./components/TermsReaccept.js";
import { FirstSteps } from "./onboarding/FirstSteps.js";
import { SessionModeBar, modeTarget } from "./modes/SessionModeBar.js";
import { ConnectorsTab, uiLang } from "./components/ConnectorsTab.js";
import { shellLang, tr } from "./i18n/index.js";
import { normLang, t, type Lang } from "./onboarding/i18n.js";
import { AccountMenu } from "./nav/AccountMenu.js";
import { LearningView } from "./learning/LearningView.js";
import { CommandPalette, type Command } from "./nav/CommandPalette.js";
import { navViews, type ViewId } from "./nav/views.js";
import { readJson, writeJson } from "./viewState.js";
import { ACCOUNT_PATHS, CONNECTORS_PATHS, cleanAccountUrl, readBillingReturn, type BillingReturn } from "./account/links.js";
import { capability, listedCapability, off } from "./capabilities.js";
import { Icon } from "./icons.js";
import { KnockIndicator } from "./knock/KnockIndicator.js";
import { PresenceMenu } from "./presence/PresenceMenu.js";
import { onKnock, playYes, stopKnock } from "./knock/controller.js";
import { KnockOrb } from "./voice/KnockOrb.js";
import { flashKnockOrb } from "./voice/orbState.js";
import { Welcome } from "./welcome/Welcome.js";
import { h as hhText } from "./household/model.js";
import { anchorVia, showMeEnabled } from "./showme/model.js";
import { ShowMeOverlay } from "./showme/ShowMeOverlay.js";
import { pointLocally } from "./showme/local.js";
import { GuidePanel } from "./guide/GuidePanel.js";
import { guideEnabled, parseGuideCommand } from "./guide/model.js";
import { PayPromptDock } from "./payments/PayPromptDock.js";
import { ThreeDSDock } from "./payments/ThreeDSDock.js";
import { createNav, type Nav } from "./nav/history.js";
import { exitNativeApp, onNativeBack } from "./platform/native.js";

// Tabs other than chat and connectors load on first opening: the first screen does not download them.
const HouseView = lazy(() => import("./house/HouseView.js").then((m) => ({ default: m.HouseView })));
const CrewTab = lazy(() => import("./components/CrewTab.js").then((m) => ({ default: m.CrewTab })));
const AccordDevices = lazy(() => import("./accord/AccordDevices.js").then((m) => ({ default: m.AccordDevices })));
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
/** Mots qui mènent aux vues de réglages dans la palette : le libellé traduit (catalogue) + les mots des autres langues. */
const settingsWords = (): string => `${tr("Settings")} ${tr("Preferences")} settings configuration einstellungen impostazioni`;
/** Sous-sections de Mon compte : ancre (id `acc-<ancre>` dans AccountTab) et clé de libellé. */
const ACCOUNT_SECTIONS: Array<[string, "accProfile" | "accConsent" | "accSub" | "accUsage" | "accDevices" | "accExport" | "accDelete" | "accSignOut"]> = [
  ["profile", "accProfile"],
  ["consent", "accConsent"],
  ["sub", "accSub"],
  ["usage", "accUsage"],
  ["devices", "accDevices"],
  ["export", "accExport"],
  ["signout", "accSignOut"],
  ["delete", "accDelete"],
];
/** La vue vient de s'ouvrir : on attend que l'ancre existe, puis on y défile. */
function scrollToAnchor(id: string, tries = 30): void {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ block: "start" });
  else if (tries > 0) setTimeout(() => scrollToAnchor(id, tries - 1), 100);
}

export function App(): React.ReactElement {
  const store = useNokker();
  const narrow = useMedia("(max-width: 760px)");
  // `/journey` : « Ce que Nokker a appris » ouvert d'emblée (lien direct, docs/LEARNING.md).
  const journey = typeof location !== "undefined" && location.pathname === "/journey";
  // Retour du KYC hébergé par Wise (PAY-AGENT §10.1, `?wise=kyc&status=…`) : on reprend sur Mon compte.
  // Retour de Stripe Checkout (`/account?billing=success|cancel`, nokker/billing) et liens `/account`, `/pricing` :
  // Mon compte, avec un message pour le retour de paiement ; l'adresse revient à « / » sans `billing`.
  const [billingReturn] = useState<BillingReturn | null>(() => readBillingReturn(window.location.search));
  const accountLink = typeof location !== "undefined" && ACCOUNT_PATHS.has(location.pathname);
  // Retour d'une connexion OAuth (`/account/connectors?oauth=…`) : l'onglet Connecteurs, adresse nettoyée.
  const connectorsLink = typeof location !== "undefined" && CONNECTORS_PATHS.has(location.pathname);
  useEffect(() => {
    if (!accountLink && !billingReturn && !connectorsLink) return;
    history.replaceState(history.state, "", cleanAccountUrl(location.search, location.hash));
  }, [accountLink, billingReturn, connectorsLink]);
  const [wanted, setTabState] = useState<Tab>(() =>
    journey ? "learning" : connectorsLink ? "connectors" : accountLink || billingReturn || new URLSearchParams(window.location.search).has("wise") ? "account" : readJson<Tab>("tab", "chat"),
  );
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [crewPulse, setCrewPulse] = useState(false);
  const [freshAgent, setFreshAgent] = useState<string | null>(null);
  const [arrangeTick, setArrangeTick] = useState(0);
  // Téléphone : les sessions sont dans un tiroir fermé par défaut ; le chat garde toute la largeur.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Historique (LOKKAL-PHONE §1.1 W2) : vues et tiroir sont des entrées ; le retour les referme dans l'ordre.
  const nav = useRef<Nav | null>(null);
  useEffect(() => {
    const n = createNav(window.history, wanted, (e) => {
      setTabState(e.tab as Tab);
      setDrawerOpen(e.drawer);
    });
    nav.current = n;
    const onPop = (ev: PopStateEvent): void => void n.onPop(ev.state);
    window.addEventListener("popstate", onPop);
    // Bouton retour d'Android dans l'app : l'historique d'abord, puis quitter.
    const off = onNativeBack((canGoBack) => {
      if (n.current().drawer || canGoBack) window.history.back();
      else exitNativeApp();
    });
    return () => {
      window.removeEventListener("popstate", onPop);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setTab = useCallback((v: Tab) => (nav.current ? nav.current.go(v) : setTabState(v)), []);
  const fabRef = useRef<HTMLButtonElement>(null);
  /** `then` : ce qui a été choisi dans le tiroir, appliqué une fois le tiroir refermé (son entrée d'historique comprise). */
  const closeDrawer = useCallback((refocus = false, then?: () => void) => {
    if (nav.current) nav.current.closeDrawer(then);
    else {
      setDrawerOpen(false);
      then?.();
    }
    if (refocus) fabRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!narrow) closeDrawer();
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
    const where = store.currentOrigin !== "cloud" ? origins.origins.find((o) => o.id === store.currentOrigin)?.name : null;
    document.title = store.current ? `${store.current.title}${where ? ` (${where})` : ""} · ${BRAND.productName}` : BRAND.productName;
  }, [store.current]);

  useEffect(() => writeJson("tab", wanted), [wanted]);

  // Conditions modifiées (core `terms_outdated`) : écran bloquant de réacceptation, comptes de nokker.ai seulement
  // (Lokkal n'a pas de conditions de compte). Un noyau d'avant (champ absent) ou une erreur : rien ne bloque.
  const [reaccept, setReaccept] = useState<Lang | null>(null);
  const [langTick, setLangTick] = useState(0);
  useEffect(() => {
    if (!store.ready || store.authMode === "local") return;
    let live = true;
    store.client.getAccount().then(
      (a) => {
        if (!live) return;
        setReaccept(a.terms_outdated === true ? normLang(a.terms_current?.lang ?? a.lang) : null);
        // La langue du compte l'emporte sur celle du navigateur (nouveau navigateur, reconnexion par code) : elle est
        // mémorisée comme à l'onboarding, et la coque se redessine une fois dans cette langue.
        const L = a.lang && a.lang_is_default !== true ? normLang(a.lang) : null; // la langue par défaut du noyau (« fr ») ne l'emporte jamais sur le navigateur
        if (L && L !== readJson<string>("lang", "")) {
          // Redessiner seulement si la langue AFFICHÉE change : à la première connexion la langue mémorisée est vide
          // alors que l'interface est déjà dans la bonne langue (navigateur), et un redessin inutile démontait la
          // couche des bulles sous ses propres minuteries.
          const shown = shellLang();
          writeJson("lang", L);
          if (L !== shown) {
            document.documentElement.lang = L;
            setLangTick((n) => n + 1);
          }
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [store.ready, store.authMode, store.client]);

  // X17 : l'onglet Équipe n'existe que si nokker.ai sert les projets (drapeau `team` ; sinon 404 comme avant).
  const [teamInvites, setTeamInvites] = useState<number | null>(null);
  useEffect(() => {
    if (!store.ready || store.authMode === "local") return;
    if (off("team")) return setTeamInvites(null);
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
    if (off("learning")) return setLearning(null);
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
    if (off("household")) return setHouseholdInvites(null);
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
    // `house` dit déjà si l'appelant est membre d'un foyer où la salle est allumée : plus de sonde.
    const known = capability("house");
    if (known !== null) return setHouseOn(known);
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
    // `operate` / `plan` : une capacité absente (noyau d'avant) garde la sonde ; connue et vraie, le compte reste lu.
    if (capability("operate") === false) setLiveIncidents(null);
    else
      store.client.listIncidents({ state: "live" }).then(
        (r) => live && setLiveIncidents(r.incidents.length),
        () => live && setLiveIncidents(null),
      );
    const plan = capability("plan");
    if (plan !== null) setPlanOn(plan);
    else
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
    // `packs` = routes /v1/packs* d'un compte us_ ; Lokkal lit /v1/local/packs, qu'aucune capacité ne décrit : sonde.
    const known = store.authMode === "local" ? null : capability("packs");
    if (known !== null) return setPacksOn(known);
    let live = true;
    (store.authMode === "local" ? store.client.listLocalPacks() : store.client.listPacks()).then(
      () => live && setPacksOn(true),
      () => live && setPacksOn(false),
    );
    return () => {
      live = false;
    };
  }, [store.ready, store.authMode, store.client]);

  // ACCORD (appareil Autoriser / Refuser) : sur la machine Lokkal seulement, si le noyau sert GET /v1/local/accord (drapeau éteint : 404).
  const [accordOn, setAccordOn] = useState(false);
  useEffect(() => {
    if (!store.ready || store.authMode !== "local") return;
    // Le noyau LISTE `accord` : on le croit, sans sonder (pas de 404 dans la console). Sinon (noyau plus ancien) : la sonde.
    const listed = listedCapability("accord");
    if (listed !== null) return setAccordOn(listed);
    let live = true;
    store.client.getLocalAccord().then(
      () => live && setAccordOn(true),
      () => live && setAccordOn(false),
    );
    return () => {
      live = false;
    };
  }, [store.ready, store.authMode, store.client]);

  // Mode dossier (FOLDER-MODE §6) : sur la machine Lokkal seulement, si le noyau sert GET /v1/local/folder/runs.
  const [folderOn, setFolderOn] = useState(false);
  useEffect(() => {
    if (!store.ready || store.authMode !== "local") return;
    if (off("local")) return setFolderOn(false);
    const listed = listedCapability("folder"); // listé par le noyau : on le croit, sans sonder (pas de 404 en console)
    if (listed !== null) return setFolderOn(listed);
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
    const code = capability("code");
    if (code !== null) return setCodeOn(code);
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
      accord: accordOn,
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
      devices: tr("Devices"),
    },
  );
  // Une vue mémorisée dont le drapeau n'est pas (ou pas encore) servi : le chat, jusqu'à ce que sa sonde réponde.
  const tab: Tab = wanted === "chat" || views.some((v) => v.id === wanted) ? wanted : "chat";
  // Liste unique cloud + machines (LOKKAL-PHONE §1.2), sur app.nokker.ai et dans l'app ; le web d'une machine reste sa vue.
  const originsOn = store.ready && store.authMode !== "local" && store.authMode !== "gateway" && store.authMode !== "demo";
  const origins = useOrigins(store.client, originsOn);
  // Fil d'une machine : en ligne, ouvert DANS la page par le client de sa passerelle ; éteinte, la copie du miroir si elle
  // existe (lecture seule), sinon on le dit.
  const openRemote = (origin: string, id: string, fromLink = false): void => {
    const m = origins.machines.find((x) => x.machine_id === origin);
    if (!m) return;
    if (m.online) {
      const known = origins.live[origin]?.find((t) => t.id === id);
      const deck = m.threads?.find((t) => t.thread_id === id);
      const thread = known ?? ({ id, title: deck?.title ?? tr("Untitled session"), created_at: deck?.updated_at ?? "", updated_at: deck?.updated_at ?? "", bubble_count: 0 } as unknown as Thread);
      void origins.clientFor(m).then(
        (c) => {
          const go = (): void => {
            setTab("chat");
            store.selectRemote(origin, thread, c);
          };
          if (fromLink) go();
          else closeDrawer(false, go);
        },
        () => store.toast(tr("{0} did not answer.", m.name), "error"),
      );
      return;
    }
    const copy = `lokkal-${origin}-${id}`;
    if (m.mirror && store.threads.some((t) => t.id === copy)) {
      const go = (): void => {
        setTab("chat");
        store.selectThread(copy);
      };
      if (fromLink) go();
      else closeDrawer(false, go);
    } else store.toast(tr("{0} is offline: only the title and state of this session are known here.", m.name));
  };
  // Copie en miroir d'un fil Lokkal (lecture seule) : pas de composeur ; « Continuer dans le cloud » ouvre un nouveau fil
  // cloud amorcé par la copie (côté serveur, `seed_from`).
  const [continuing, setContinuing] = useState(false);
  const mirror = store.current && store.currentOrigin === "cloud" ? mirrorOf(store.current.id) : null;
  const mirrorMachine = mirror ? origins.machines.find((m) => m.machine_id === mirror.machine) : undefined;
  const readOnly = mirror
    ? {
        text: mirrorMachine && !mirrorMachine.online ? tr("{0} is offline: this is a read-only copy.", mirrorMachine.name) : tr("Read-only copy of a session on {0}.", mirrorMachine?.name ?? tr("a machine")),
        action: {
          label: tr("Continue in the cloud"),
          busy: continuing,
          run: () => {
            setContinuing(true);
            store.client.continueInCloud({ machine_id: mirror.machine, thread_id: mirror.thread }).then(
              async (r) => {
                await store.refreshThreads().catch(() => undefined);
                store.selectThread(r.thread_id);
                setContinuing(false);
              },
              () => {
                setContinuing(false);
                store.toast(tr("The session could not be continued in the cloud. Try again."), "error");
              },
            );
          },
        },
      }
    : null;
  // « Partager vers Nokker » (app native) : chaque partage déposé par l'extension devient un nouveau fil, avec la pièce
  // dans le composeur (la personne envoie). Repris à l'ouverture, au réveil et sur `nokker://share/<id>`.
  const [prefills, setPrefills] = useState<Record<string, Prefill>>({});
  const sharing = useRef(false);
  useEffect(() => {
    if (!store.ready) return;
    const take = async (): Promise<void> => {
      if (sharing.current) return;
      sharing.current = true;
      try {
        for (const b of await pendingShares()) {
          const t = await store.createThread(shareTitle(b, tr("Shared")));
          if (!t) break; // échec dit par un toast ; le partage reste dans la boîte
          const p = sharePrefill(b, (name) => tr("Shared document: {0}", name));
          setPrefills((cur) => ({ ...cur, [t.id]: p }));
          await clearShare(b.id);
        }
      } finally {
        sharing.current = false;
      }
    };
    void take();
    return onShareSignal(() => void take());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.ready]);
  // Zones (app native) : la file des arrivées et départs part au noyau dès que la session est prête, au retour au premier
  // plan et à chaque transition.
  useEffect(() => (store.ready && store.authMode !== "local" ? watchZoneEvents(store.client) : undefined), [store.ready, store.authMode, store.client]);
  // Données du téléphone à la demande (P8, app native) : capacités déclarées au lancement, réponse à chaque
  // `device.request` du noyau, et une ligne qui dit ce qui a été lu (on coupe dans Mon compte → Cet appareil).
  useEffect(() => {
    const plugin = pimPlugin();
    if (!plugin || !store.ready || store.authMode === "local") return;
    let deviceId: string | null = null;
    void readStoredDeviceKey().then((k) => {
      deviceId = k?.deviceId ?? null;
      if (deviceId) void declareCaps(store.client, plugin, deviceId, deviceName()).catch(() => undefined);
    });
    const onReq = (ev: Event): void => {
      const e = (ev as CustomEvent<DeviceRequestEvent>).detail;
      if (!deviceId || Date.parse(e.expires_at) < Date.now()) return;
      void answerRequest(store.client, plugin, deviceId, e).then(
        (a) => {
          if (a.error || a.op !== "calendar.list") return;
          store.toast(a.count === 1 ? tr("Phone calendar read: 1 event (turn it off in My account → This device).") : tr("Phone calendar read: {0} events (turn it off in My account → This device).", String(a.count)));
        },
        () => undefined,
      );
    };
    window.addEventListener("nokker:device-request", onReq);
    return () => window.removeEventListener("nokker:device-request", onReq);
  }, [store.ready, store.authMode, store.client]);
  // Lien `#/t/<mc_…>/<fil>` (notification, autre appareil, retour) : ouvert dès que la machine est connue.
  const machinesKnown = origins.machines.length > 0;
  useEffect(() => {
    if (!machinesKnown) return;
    const follow = (): void => {
      const r = parseThreadRoute(window.location.hash);
      if (r && r.origin !== "cloud" && !(store.currentOrigin === r.origin && store.current?.id === r.id)) openRemote(r.origin, r.id, true);
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machinesKnown, store.currentOrigin, store.current?.id]);
  const unified: UnifiedDrawer | undefined = origins.origins.length
    ? {
        rows: unifiedRows(store.threads, origins.machines, origins.live),
        origins: origins.origins,
        search: origins.search,
        onOpenRemote: (row) => openRemote(row.origin, row.id),
        current: store.current ? { origin: store.currentOrigin, id: store.current.id } : null,
      }
    : undefined;
  const viewInfo = views.find((v) => v.id === tab);
  const openView = useCallback(
    (v: Tab) => closeDrawer(false, () => setTab(v)),
    [closeDrawer, setTab],
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
      flashKnockOrb();
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
    // Les vues de réglages répondent aussi à « réglages », « settings »… (la palette est le moyen de les trouver).
    ...views.map((v) => ({ id: `v-${v.id}`, group: tr("Go to"), label: v.label, keywords: v.group === "settings" ? `${v.id} ${settingsWords()}` : v.id, icon: v.icon, run: () => openView(v.id) })),
    // Sous-sections de Mon compte : on ouvre la vue puis on défile jusqu'à l'ancre.
    ...(views.some((v) => v.id === "account")
      ? ACCOUNT_SECTIONS.map(([anchor, key]) => ({
          id: `acc-${anchor}`,
          group: tr("Go to"),
          label: `${views.find((v) => v.id === "account")!.label} › ${t(uiLang(), key)}`,
          keywords: `${anchor} ${settingsWords()}`,
          icon: "user" as const,
          run: () => {
            openView("account");
            scrollToAnchor(`acc-${anchor}`);
          },
        }))
      : []),
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
  if (reaccept !== null) return <TermsReaccept client={store.client} lang={reaccept} onDone={() => setReaccept(null)} />;

  return (
    <StoreContext.Provider value={store}>
      <div key={langTick} className={`app ${narrow ? "narrow" : ""} ${narrow && drawerOpen ? "drawer-open" : ""}`}>
        <a href="#nk-composer" className="skip">
          {tr("Skip to message")}
        </a>
        <Drawer
          unified={unified}
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
          onSelect={(id) =>
            closeDrawer(false, () => {
              setTab("chat");
              store.selectThread(id);
            })
          }
          onCreate={(t) => closeDrawer(false, () => void store.createThread(t))}
          onDelete={(id) => void store.deleteThread(id)}
          codeSessions={store.codeSessions}
          roots={store.localRoots}
          onCreateCode={store.localRoots !== null ? async (cwd) => {
            closeDrawer();
            await store.createCodeSession(cwd);
            setTab("chat");
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
            onClick={() => (drawerOpen ? closeDrawer() : nav.current ? nav.current.openDrawer() : setDrawerOpen(true))}
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
                  {store.currentOrigin !== "cloud" ? (
                    <span className="origin-pill topbar-origin" data-current-origin={store.currentOrigin}>
                      {origins.origins.find((o) => o.id === store.currentOrigin)?.name ?? store.currentOrigin}
                    </span>
                  ) : null}
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
              <span className="demo-badge" role="img" aria-label={tr("Demo · fictitious values")} title={tr("Demo · fictitious values")}>
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
              {modeAt ? <SessionModeBar key={modeAt.threadId} client={store.client} target={modeAt} onEvent={store.onCodeEvent} onSend={(t) => void store.send(t, [])} toast={store.toast} compact={narrow} working={!!store.current?.working} /> : null}
              <Chat
                title={store.current?.title ?? ""}
                messages={store.messages}
                streaming={store.streaming}
                live={store.live}
                startedMessage={store.startedMessage}
                sending={store.sending}
                onSend={(t, images, texts, opts) => store.send(t, images, texts, opts)}
                offlineAt={store.offlineAt}
                readOnly={readOnly}
                prefill={store.current ? prefills[store.current.id] ?? null : null}
                {...(guideOn ? { onCommand: guideCommand } : {})}
                threadId={store.current?.id ?? null}
                client={store.client}
                turnCosts={store.turnCosts}
                quotaTurns={store.quotaTurns}
                turnNotices={store.turnNotices}
                onOpenAccount={() => (off("account") ? void window.open(nokkerAccountUrl(), "_blank", "noopener,noreferrer") : openView("account"))}
                accountRemote={off("account")}
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
          ) : store.ready && tab === "devices" && accordOn && store.authMode === "local" ? (
            <AccordDevices client={store.client} toast={store.toast} />
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
              signDecision={store.signDecision ?? null}
              billingReturn={billingReturn}
              canSetLang={store.authMode !== "local"}
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
        {store.ready ? <ThreeDSDock client={store.client} rev={store.payAgentRev} signDecision={store.authMode === "passkey" ? (store.signDecision ?? null) : null} /> : null}
        {store.ready ? <PayPromptDock client={store.client} rev={store.payAgentRev} /> : null}
        <KnockOrb />
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
