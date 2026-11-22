/**
 * Plugins de la coque (chargé SEULEMENT dans l'app, par main.tsx) : le pont natif de Capacitor ne publie que des
 * en-têtes (`PluginHeaders`) ; c'est `registerPlugin` de @capacitor/core qui crée `Capacitor.Plugins.<Nom>` que lit
 * platform/native.ts (retour Android, navigateur système, vibrations, clavier, barre d'état). Le web n'en charge rien.
 */
import { registerPlugin } from "@capacitor/core";
import { REDACT_RULES_SNAPSHOT } from "@nokker-apps/sdk";

// NokkerShare, NokkerZones : plugins maison de la cible App (ios/App/App/*Plugin.swift, enregistrés par NokkerViewController).
export const NATIVE_PLUGINS = ["App", "Browser", "Haptics", "Keyboard", "StatusBar", "SplashScreen", "NokkerShare", "NokkerZones", "NokkerPim", "NokkerText", "NokkerNode", "NokkerVault"] as const;

export function registerNativePlugins(): void {
  for (const name of NATIVE_PLUGINS) registerPlugin(name);
}

registerNativePlugins();

/** P9b : la copie embarquée des règles de masquage (générée depuis le noyau) rejouée par le moteur NATIF (ICU) à chaque
 * lancement, par le vrai pont : le journal dit « NokkerVault: self-test rules ok (version …, N rules, M vectors, bad 0) »
 * (exigé par le CI). Aucune valeur n'est journalisée ; rien n'est stocké par cet appel. */
void (registerPlugin("NokkerVault") as unknown as { checkRules?: (o: { rules: typeof REDACT_RULES_SNAPSHOT }) => Promise<unknown> })
  .checkRules?.({ rules: REDACT_RULES_SNAPSHOT })
  ?.catch(() => undefined);
