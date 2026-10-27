/** Onglet Équipe : un 403 `sso_required` (§7.24) mène au SSO de la connexion exigée (une fois par minute), sinon le dit. */
import { useMemo } from "react";
import type { NokkerClient } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";
import { autoSso } from "./browser.js";
import { withSsoGuard } from "./flow.js";

export function useSsoGuard(client: NokkerClient, toast: (text: string, tone?: "ok" | "error") => void): NokkerClient {
  return useMemo(
    () =>
      withSsoGuard(client, (sc) => {
        if (!autoSso(client, shellLang(), sc)) toast(tr("This project requires a recent SSO sign-in: use “Sign in with SSO”."), "error");
      }),
    [client, toast],
  );
}
