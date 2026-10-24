/**
 * Fichier de marque — SOURCE UNIQUE.
 *
 * Correction du 18.10.2026 (coordinateur, relayant l'exigence produit du 16.10, cf
 * `docs/BRAND.md`) : le nom commercial EST choisi — **Nokker** (nokker.ai, déposé
 * 15.10.2026) — et toute la CLI doit s'appeler `nokker` (même convention que le binaire Python du
 * noyau `nokker_brand.py` : `PRODUCT_NAME = "Nokker"`, `CLI_NAME = "nokker"`). Tous les clients
 * (CLI, web, desktop, mobile) importent `BRAND` depuis ce fichier au lieu d'écrire le nom en dur :
 * un futur changement de marque (si jamais) tient en modifiant les valeurs ci-dessous, rien
 * d'autre dans le monorepo.
 */

export const PRODUCT_NAME = "Nokker" as const;

/** Binaire CLI (nom de commande exposé par `apps/cli`, `bin` du package.json) — même nom que la
 * CLI Python du noyau (`BRAND.md` point 1/8), pas de double identité CLI. */
export const CLI_NAME = "nokker" as const;

/** Dossier de config/état utilisateur (clé d'appareil, jeton de session) — XDG-like, pas de point
 * dans le nom pour rester lisible sur Windows (`%APPDATA%\<name>`). */
export const NOKKER_CONFIG_DIRNAME = "nokker" as const;

/** Nom de service pour le trousseau OS (macOS Keychain / libsecret / Windows Credential Manager)
 * quand `apps/cli` y range la clé d'appareil. */
export const NOKKER_KEYCHAIN_SERVICE = "nokker-device-key" as const;

/** User-Agent HTTP envoyé par le SDK (apparaît dans les logs serveur). */
export const NOKKER_USER_AGENT = `${CLI_NAME}-sdk/0.1` as const;

/** Slogan / sous-titre court, utilisé dans la CLI (bannière `/new`) et le `<title>` web. */
export const NOKKER_TAGLINE = "l'agente Nina, en ligne de commande comme sur navigateur" as const;

/** Thème — couleurs de base partagées par `apps/cli` (chalk/ink) et `apps/web` (CSS variables). */
export const NOKKER_THEME = {
  accent: "#6366f1",
  accentDark: "#818cf8",
  success: "#22c55e",
  warning: "#f59e0b",
  danger: "#ef4444",
  mutedLight: "#6b7280",
  mutedDark: "#9ca3af",
} as const;

export const BRAND = {
  /** @deprecated garder la clé `appName` pour la compat du code déjà écrit contre ce fichier —
   * vaut `PRODUCT_NAME`. Un futur renommage ne touche QUE les constantes ci-dessus. */
  appName: PRODUCT_NAME,
  productName: PRODUCT_NAME,
  cliBin: CLI_NAME,
  configDirName: NOKKER_CONFIG_DIRNAME,
  keychainService: NOKKER_KEYCHAIN_SERVICE,
  userAgent: NOKKER_USER_AGENT,
  tagline: NOKKER_TAGLINE,
  theme: NOKKER_THEME,
} as const;

export type Brand = typeof BRAND;
