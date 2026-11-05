import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { captureOAuthReturn, captureVoucher } from "./account/links.js";
import { approvalIdFromPath } from "./approvals/path.js";
import { uiLang } from "./components/ConnectorsTab.js";
import { shellLang } from "./i18n/index.js";
import { UpdateBanner } from "./pwa/InstallCard.js";
import { listenInstall } from "./pwa/install.js";
import { registerServiceWorker } from "./pwa/register.js";
import "./theme.css";

// Pages other than the app shell load on demand: the sign-in screen does not download the approval, setup or gateway pages.
const ApprovalPage = lazy(() => import("./approvals/ApprovalPage.js").then((m) => ({ default: m.ApprovalPage })));
const LinkPage = lazy(() => import("./link/LinkPage.js").then((m) => ({ default: m.LinkPage })));
const MachinesPage = lazy(() => import("./machines/MachinesPage.js").then((m) => ({ default: m.MachinesPage })));
const RemoteApprovalPage = lazy(() => import("./approvals/RemoteApprovalPage.js").then((m) => ({ default: m.RemoteApprovalPage })));
const Onboarding = lazy(() => import("./onboarding/Onboarding.js").then((m) => ({ default: m.Onboarding })));
const AuthorizePage = lazy(() => import("./gateway/AuthorizePage.js").then((m) => ({ default: m.AuthorizePage })));
const Setup = lazy(() => import("./onboarding/Setup.js").then((m) => ({ default: m.Setup })));
const GlancePage = lazy(() => import("./glance/GlancePage.js").then((m) => ({ default: m.GlancePage })));
const SsoCallbackPage = lazy(() => import("./sso/SsoCallbackPage.js").then((m) => ({ default: m.SsoCallbackPage })));

listenInstall();
registerServiceWorker();
// Code d'essai d'une campagne (`?code=` sur le lien d'invitation ou de Mon compte) : gardé jusqu'au Checkout.
captureVoucher(location.search);
captureOAuthReturn(location.search);
// index.html ships lang="fr"; the shell may be in English (stored choice or browser language): screen readers follow this.
document.documentElement.lang = shellLang();

const el = document.getElementById("root");
if (!el) throw new Error("#root manquant dans index.html");
const approvalId = approvalIdFromPath(location.pathname);
createRoot(el).render(
  <React.StrictMode>
    <Suspense fallback={null}>
    {location.pathname === "/sso/callback" ? <SsoCallbackPage /> : location.pathname === "/invite" ? <Onboarding /> : location.pathname === "/setup" ? <Setup /> : location.pathname === "/gateway/authorize" ? <AuthorizePage /> : location.pathname === "/link" ? <LinkPage /> : location.pathname === "/machines" ? <MachinesPage /> : location.pathname === "/glance" ? <GlancePage /> : location.pathname === "/approve" || location.pathname.startsWith("/approve/") ? <RemoteApprovalPage /> : approvalId ? <ApprovalPage id={approvalId} /> : <App />}
    </Suspense>
    <UpdateBanner lang={uiLang()} />
  </React.StrictMode>,
);
