/** Onglet Équipe : un 403 `sso_required` (§7.24) mène au SSO de la connexion exigée (une fois par minute), sinon le dit. */
import { useMemo } from "react";
import type { NokkerClient } from "@nokker-apps/sdk";
import { autoSso } from "./browser.js";
import { withSsoGuard } from "./flow.js";

export function useSsoGuard(client: NokkerClient, toast: (text: string, tone?: "ok" | "error") => void): NokkerClient {
  return useMemo(
    () =>
      withSsoGuard(client, (sc) => {
        if (!autoSso(client, "fr", sc)) toast("Ce projet demande une connexion SSO récente : utilise « Se connecter avec le SSO ».", "error");
      }),
    [client, toast],
  );
}
