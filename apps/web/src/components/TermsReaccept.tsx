/**
 * Conditions modifiées (core `GET /v1/account` → `terms_outdated`) : écran BLOQUANT à la place de l'app, tant que la
 * personne n'a pas accepté la version courante. Texte lu par `GET /v1/terms?lang=`, accord par
 * `POST /v1/account/terms {version}` ; 409 `stale_version` (le texte a encore changé) : la dernière version est relue.
 */
import React, { useCallback, useEffect, useState } from "react";
import { NokkerApiError, type NokkerClient } from "@nokker-apps/sdk";
import { Markdown } from "../Markdown.js";
import { t, type Lang } from "../onboarding/i18n.js";

export function TermsReaccept({ client, lang: initial, onDone }: { client: NokkerClient; lang: Lang; onDone: () => void }): React.ReactElement {
  const [lang, setLang] = useState<Lang>(initial);
  const [doc, setDoc] = useState<{ version: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<"reaccStale" | "reaccFailed" | null>(null);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    let live = true;
    setDoc(null);
    client.getCurrentTerms(lang).then(
      (d) => live && setDoc({ version: d.version, text: d.text }),
      () => live && setNote("reaccFailed"),
    );
    return () => {
      live = false;
    };
  }, [client, lang, rev]);

  const accept = useCallback(async () => {
    if (!doc) return;
    setBusy(true);
    setNote(null);
    try {
      await client.acceptCurrentTerms(doc.version);
      onDone();
    } catch (e) {
      if (e instanceof NokkerApiError && e.status === 409) {
        setNote("reaccStale");
        setRev((n) => n + 1);
      } else setNote("reaccFailed");
    } finally {
      setBusy(false);
    }
  }, [client, doc, onDone]);

  return (
    <div className="ob ob-embedded" data-terms-reaccept>
      <div className="ob-card" role="dialog" aria-modal="true" aria-labelledby="reacc-title">
        <h2 className="ob-title" id="reacc-title">
          {t(lang, "reaccTitle")}
        </h2>
        <p>{t(lang, "reaccIntro")}</p>
        <div className="ob-lang" role="group" aria-label={t(lang, "termsLang")}>
          {(["fr", "en"] as const).map((l) => (
            <button key={l} type="button" className={"ob-chip" + (l === lang ? " on" : "")} aria-pressed={l === lang} disabled={busy} onClick={() => setLang(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="ob-terms" tabIndex={0} role="region" aria-label={t(lang, "termsTitle")} aria-busy={doc === null}>
          {doc === null ? <p className="ob-status">{t(lang, "reaccLoading")}</p> : <Markdown text={doc.text} />}
        </div>
        {note ? (
          <p className={note === "reaccFailed" ? "ob-error" : "ob-hint"} role={note === "reaccFailed" ? "alert" : "status"}>
            {t(lang, note)}
          </p>
        ) : null}
        <div className="ob-actions">
          <button type="button" className="ob-btn primary" disabled={!doc || busy} onClick={() => void accept()}>
            {t(lang, "reaccAccept")}
          </button>
        </div>
      </div>
    </div>
  );
}
