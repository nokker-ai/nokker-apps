/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NOKKER_SERVER_URL?: string;
  readonly VITE_NOKKER_AUTH?: string;
  /** "1" : se comporter comme servi par la passerelle (recette contre le mock). */
  readonly VITE_NOKKER_GATEWAY?: string;
  /** Page d'autorisation de nokker.ai (défaut https://app.nokker.ai/gateway/authorize). */
  readonly VITE_NOKKER_AUTHORIZE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
