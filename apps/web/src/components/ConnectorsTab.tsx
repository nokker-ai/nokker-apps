import React from "react";
import type { NokkerClient } from "@nokker-apps/sdk";
import { ConnectorsStep, TelegramStep } from "../onboarding/Connectors.js";
import { normLang, t, type Lang } from "../onboarding/i18n.js";
import { InstallCard } from "../pwa/InstallCard.js";
import { readJson } from "../viewState.js";

/** Langue du compte mémorisée à l'onboarding, sinon celle du navigateur (fr par défaut). */
export function uiLang(): Lang {
  return normLang(readJson<string>("lang", "") || navigator.language);
}

export function ConnectorsTab({ client, lang }: { client: NokkerClient; lang: Lang }): React.ReactElement {
  return (
    <div className="ob ob-embedded">
      <div className="ob-card">
        <h2 className="ob-title">{t(lang, "tabConnectors")}</h2>
        <ConnectorsStep client={client} lang={lang} embedded />
        <TelegramStep client={client} lang={lang} embedded />
      </div>
      <InstallCard lang={lang} />
    </div>
  );
}
