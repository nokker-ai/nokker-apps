/** Publication des pages (LOKKAL §7.26, BUBBLES §10.4) : choix explicite page par page, jamais un outil du modèle. */

/** `POST /v1/pages/{id}/publish` : 202, carte forte (à la clé d'appareil seulement) ; cette version-là devient publique. */
export interface PublishPageResult {
  approval_id: string;
  strength: "strong";
  rule: "pages:publish";
  version: number;
}

/** Copie publique au miroir : retirée tout de suite (`done`), à refaire au prochain passage (`pending`), ou aucune. */
export type PublicPurge = "done" | "pending" | "none";

export interface UnpublishPageResult {
  page_id: string;
  public: false;
  purge: PublicPurge;
}

export interface PageLocalityResult {
  page_id: string;
  locality: "local" | null;
  public: boolean;
  purge: PublicPurge;
}
