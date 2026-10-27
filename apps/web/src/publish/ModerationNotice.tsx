/** Page retirée par la modération de nokker.ai (§7.26 point 6) : exposé des motifs à son auteur (DSA art. 17) — date,
 * motif, comment contester (phrase fixe de nokker.ai) et l'identifiant de la page à citer. Plus de publication possible. */
import React, { useState } from "react";
import type { ArtifactState } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";

export function moderationDate(at: number | null | undefined, lang = shellLang()): string | null {
  if (!at) return null;
  return new Date(at * 1000).toLocaleDateString(lang === "fr" ? "fr-CH" : "en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export function ModerationNotice({ s }: { s: Pick<ArtifactState, "page_id" | "moderated_at" | "moderation"> }): React.ReactElement {
  const lang = shellLang();
  const m = s.moderation;
  const when = moderationDate(m?.at ?? s.moderated_at, lang);
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(s.page_id).then(
      () => setCopied(true),
      () => undefined,
    );
  };
  return (
    <section className="moderation-notice" role="status" aria-label={tr("Removed by moderation")}>
      <strong>{when ? tr("Removed by nokker.ai moderation on {0}.", when) : tr("Removed by nokker.ai moderation.")}</strong>
      <p>{m?.reason ? tr("Reason: {0}", m.reason) : tr("The reason has not been given yet.")}</p>
      <p className="fine">{tr("The page stays here for you; it is no longer public and cannot be published again.")}</p>
      <p className="fine">{m?.appeal ? (lang === "fr" ? m.appeal.fr : m.appeal.en) : tr("To contest this removal, reply to moderation@nokker.ai quoting the page identifier.")}</p>
      <p className="fine moderation-id">
        {tr("Page identifier:")} <code>{s.page_id}</code>{" "}
        <button type="button" className="btn btn-sm" onClick={copy}>
          {copied ? tr("Copied") : tr("Copy")}
        </button>
      </p>
    </section>
  );
}
