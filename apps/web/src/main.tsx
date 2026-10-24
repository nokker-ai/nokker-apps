import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ApprovalPage } from "./approvals/ApprovalPage.js";
import { approvalIdFromPath } from "./approvals/path.js";
import { uiLang } from "./components/ConnectorsTab.js";
import { Onboarding } from "./onboarding/Onboarding.js";
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
    {location.pathname === "/invite" ? <Onboarding /> : approvalId ? <ApprovalPage id={approvalId} /> : <App />}
    <UpdateBanner lang={uiLang()} />
  </React.StrictMode>,
);
