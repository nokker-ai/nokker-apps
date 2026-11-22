import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { captureOAuthReturn, captureVoucher } from "./account/links.js";
import { approvalIdFromPath } from "./approvals/path.js";
import { sitesLink } from "./sites/links.js";
import { uiLang } from "./components/ConnectorsTab.js";
import { shellLang } from "./i18n/index.js";
import { UpdateBanner } from "./pwa/InstallCard.js";
import { listenInstall } from "./pwa/install.js";
import { registerServiceWorker } from "./pwa/register.js";
import { fakeShellAllowed, installExternalLinks, isNativeShell } from "./platform/native.js";
import { nodePlugin } from "./platform/node.js";
import { watchHomeMode } from "./platform/homeGuard.js";
import { watchKeyboard } from "./platform/viewport.js";
import { installGlow } from "./visual/glow.js";
import { installGlass } from "./glass/glass.js";
import "./glass/glass.css";
import { enterPersonal, installPersonalIdleGuard, kioskEnabled, KIOSK_PATH, takeKioskToken } from "./kiosk/mode.js";
import { redeemSessionCode, takeCodeFromHash } from "./onboarding/sessionCode.js";
import { onPresentScreen } from "./kiosk/scope.js";
import { isLoopbackHost, isMockServer } from "./auth.js";
import { SERVER_URL } from "./api.js";
import "./theme.css";

// Pages other than the app shell load on demand: the sign-in screen does not download the approval, setup or gateway pages.
const ApprovalPage = lazy(() => import("./approvals/ApprovalPage.js").then((m) => ({ default: m.ApprovalPage })));
const PresentPage = lazy(() => import("./browser/PresentPage.js").then((m) => ({ default: m.PresentPage })));
const LinkPage = lazy(() => import("./link/LinkPage.js").then((m) => ({ default: m.LinkPage })));
const MachinesPage = lazy(() => import("./machines/MachinesPage.js").then((m) => ({ default: m.MachinesPage })));
const NinaLivePage = lazy(() => import("./ninaLive/NinaLivePage.js").then((m) => ({ default: m.NinaLivePage })));
const RemoteApprovalPage = lazy(() => import("./approvals/RemoteApprovalPage.js").then((m) => ({ default: m.RemoteApprovalPage })));
const Onboarding = lazy(() => import("./onboarding/Onboarding.js").then((m) => ({ default: m.Onboarding })));
const AuthorizePage = lazy(() => import("./gateway/AuthorizePage.js").then((m) => ({ default: m.AuthorizePage })));
const Setup = lazy(() => import("./onboarding/Setup.js").then((m) => ({ default: m.Setup })));
const GlancePage = lazy(() => import("./glance/GlancePage.js").then((m) => ({ default: m.GlancePage })));
const WallPage = lazy(() => import("./glance/WallPage.js").then((m) => ({ default: m.WallPage })));
const KioskPage = lazy(() => import("./kiosk/KioskPage.js").then((m) => ({ default: m.KioskPage })));
const SiteRequestPage = lazy(() => import("./sites/SitesPages.js").then((m) => ({ default: m.SiteRequestPage })));
const SiteHandoffPage = lazy(() => import("./sites/SitesPages.js").then((m) => ({ default: m.SiteHandoffPage })));
const SsoCallbackPage = lazy(() => import("./sso/SsoCallbackPage.js").then((m) => ({ default: m.SsoCallbackPage })));

listenInstall();
registerServiceWorker();
// Coque native : un lien web (Postuler, conditions, aide…) part vers le navigateur système, pas dans la vue de l'app.
installExternalLinks();
// Clavier ouvert sur iOS : la coque prend la hauteur visible, le composeur reste au-dessus du clavier.
watchKeyboard();
// Code d'essai d'une campagne (`?code=` sur le lien d'invitation ou de Mon compte) : gardé jusqu'au Checkout.
captureVoucher(location.search);
captureOAuthReturn(location.search);
// index.html ships lang="fr"; the shell may be in English (stored choice or browser language): screen readers follow this.
document.documentElement.lang = shellLang();
// Lot V1 « Glow » : un seul interrupteur (VITE_NOKKER_GLOW=0 ou nokker.web.glow = "0" l'éteint).
installGlow();
void installGlass(); // V4 : opt-in (VITE_NOKKER_GLASS=1 / nokker.web.glass), mesuré, repli automatique

// Dans la coque native : les plugins Capacitor d'abord (retour, navigateur système, vibrations), puis l'interface.
// Fausse coque de recette (dev seulement) : ses fonctions natives sont simulées, on ne les remplace pas.
const plugins = isNativeShell() && !fakeShellAllowed() ? import("./platform/plugins.js").catch(() => undefined) : Promise.resolve();
const el = document.getElementById("root");
if (!el) throw new Error("#root manquant dans index.html");
// Lien d'une notification (contrat C4) : `https://app.nokker.ai/t/<origine>/<fil>` → la route du web `#/t/<origine>/<fil>`.
{
  const m = /^\/t\/((?:mc_[^/]+\/)?[^/]+)\/?$/.exec(location.pathname);
  if (m) history.replaceState(history.state, "", `/${location.search}#/t/${m[1]}`);
}
const approvalId = approvalIdFromPath(location.pathname);
// Liens des sites connectés (CONNECTED-SITES §15) : saisie sécurisée `/sites/r/<rid>`, vérification `/sites/h/<jeton>`.
const siteLink = sitesLink(location.pathname);
// Kiosque HDMI d'un Lokkal : sa clé (fragment) est prise AVANT tout rendu, pour ne jamais devenir celle de l'app.
const kiosk = location.pathname === KIOSK_PATH && kioskEnabled();
let kioskToken: string | null = kiosk ? takeKioskToken() : null; // `#token=` : transition, retiré à rc.9.40
if (!kiosk && kioskEnabled()) installPersonalIdleGuard();
// V3 + : grand écran de la présentatrice (/present/{session}), chargé à la demande.
const presentId = /^\/present\/(bs_[A-Za-z0-9]+)\/?$/.exec(location.pathname)?.[1] ?? null;
const presentFollow = /^\/present\/?$/.test(location.pathname); // sans id : suit la session navigateur en cours
// Mode nœud maison : « toc toc toc » coupé (pièce commune), lu dès que les plugins sont prêts.
void plugins.then(() => watchHomeMode());
const wall = location.pathname === "/glance" && new URLSearchParams(location.search).get("wall") === "1";
// P10b : la tablette du mur rouvre l'écran mural au lancement (elle peut n'avoir aucune session).
const wallBoot =
  location.pathname === "/" && !location.hash
    ? plugins
        .then(() => nodePlugin()?.wallToken?.())
        .then((r) => (r?.active && r.token ? (location.replace("/glance?wall=1"), true) : false))
        .catch(() => false)
    : Promise.resolve(false);
// Lien d'ouverture d'un Lokkal (`#code=`, usage unique) : le fragment est effacé AVANT tout, puis le code est échangé contre
// un jeton de session, gardé comme l'était le jeton local — avant le premier rendu, pour que l'app le trouve.
const bootCode = isLoopbackHost(location.hostname) ? takeCodeFromHash() : null; // fragment effacé ICI, avant tout réseau
const codeBoot: Promise<unknown> = bootCode
  ? isMockServer(SERVER_URL).catch(() => false).then((mock) => redeemSessionCode(SERVER_URL, bootCode, { persistent: !mock, target: kiosk ? "kiosk" : onPresentScreen() ? "present" : "app" })).catch(() => false)
  : Promise.resolve(false);
// Kiosque : le jeton de portée `kiosk` n'est gardé qu'après l'échange, donc lu ici, avant le premier rendu.
void codeBoot.then(() => {
  if (kiosk && !kioskToken) kioskToken = takeKioskToken();
});
void codeBoot.then(() => wallBoot).then((moved): Promise<boolean> => (moved ? Promise.resolve(true) : plugins.then(() => false))).then((moved) =>
  moved ? undefined : createRoot(el).render(
  <React.StrictMode>
    <Suspense fallback={null}>
    {siteLink ? (siteLink.kind === "request" ? <SiteRequestPage rid={siteLink.id} /> : <SiteHandoffPage token={siteLink.id} />) : presentId ? <PresentPage sessionId={presentId} /> : presentFollow ? <PresentPage sessionId={null} /> : kiosk ? <KioskPage token={kioskToken} onPersonal={() => enterPersonal()} /> : location.pathname === "/sso/callback" ? <SsoCallbackPage /> : location.pathname === "/invite" ? <Onboarding /> : location.pathname === "/setup" ? <Setup /> : location.pathname === "/gateway/authorize" ? <AuthorizePage /> : location.pathname === "/link" ? <LinkPage /> : location.pathname === "/machines" ? <MachinesPage /> : location.pathname === "/nina-live" && import.meta.env.VITE_NOKKER_NINA_LIVE === "1" ? <NinaLivePage /> : wall ? <WallPage /> : location.pathname === "/glance" ? <GlancePage /> : location.pathname === "/approve" || location.pathname.startsWith("/approve/") ? <RemoteApprovalPage /> : approvalId ? <ApprovalPage id={approvalId} /> : <App />}
    </Suspense>
    <UpdateBanner lang={uiLang()} />
  </React.StrictMode>,
),
);
