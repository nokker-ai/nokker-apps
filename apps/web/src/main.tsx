import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ApprovalPage } from "./approvals/ApprovalPage.js";
import { approvalIdFromPath } from "./approvals/path.js";
import { uiLang } from "./components/ConnectorsTab.js";
import { LinkPage } from "./link/LinkPage.js";
import { MachinesPage } from "./machines/MachinesPage.js";
import { RemoteApprovalPage } from "./approvals/RemoteApprovalPage.js";
import { Onboarding } from "./onboarding/Onboarding.js";
import { AuthorizePage } from "./gateway/AuthorizePage.js";
import { UpdateBanner } from "./pwa/InstallCard.js";
import { listenInstall } from "./pwa/install.js";
import { registerServiceWorker } from "./pwa/register.js";
import "./theme.css";

listenInstall();
registerServiceWorker();

const el = document.getElementById("root");
if (!el) throw new Error("#root manquant dans index.html");
const approvalId = approvalIdFromPath(location.pathname);
createRoot(el).render(
  <React.StrictMode>
    {location.pathname === "/invite" ? <Onboarding /> : location.pathname === "/gateway/authorize" ? <AuthorizePage /> : location.pathname === "/link" ? <LinkPage /> : location.pathname === "/machines" ? <MachinesPage /> : location.pathname === "/approve" || location.pathname.startsWith("/approve/") ? <RemoteApprovalPage /> : approvalId ? <ApprovalPage id={approvalId} /> : <App />}
    <UpdateBanner lang={uiLang()} />
  </React.StrictMode>,
);
