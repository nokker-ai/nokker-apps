/**
 * Étape « Ton Nokker » du parcours (drapeau `onboarding_avatar`) : nom, voix et avatar de l'assistant. « Passer »
 * garde les valeurs par défaut (aucun PUT) ; « Continuer » envoie `PUT /v1/persona`. L'aperçu 3D est facultatif : sans
 * WebGL ou sans GLB, les vignettes suffisent ; sans parole horodatée, l'avatar reste muet.
 */
import React, { useEffect, useState } from "react";
import { NokkerApiError, type NokkerClient, type PersonaAvatarRef, type TimedSpeech } from "@nokker-apps/sdk";
import { TalkingAvatar } from "../avatar/TalkingAvatar.js";
import { ErrorLine } from "./Connectors.js";
import { errorCode } from "./errors.js";
import { personaErrorKey, personaRequest, type Action, type PersonaForm } from "./flow.js";
import { t, type Lang } from "./i18n.js";
import "./persona.css";

type Preview = { state: "idle" | "loading" } | { state: "off" } | { state: "error"; key: "errRate" | "errGeneric" };

export function PersonaStep(props: { client: NokkerClient; lang: Lang; p: PersonaForm; dispatch: React.Dispatch<Action> }): React.ReactElement {
  const { client, lang: L, p, dispatch } = props;

  // Catalogue (liste fermée) et choix déjà faits ; un noyau sans ces routes saute l'étape.
  useEffect(() => {
    if (p.status !== "loading") return;
    let off = false;
    Promise.all([client.getPersonaCatalog(), client.getPersona().catch(() => null)])
      .then(([catalog, current]) => !off && dispatch({ type: "persona_loaded", catalog, current }))
      .catch(() => !off && dispatch({ type: "persona_unavailable" }));
    return () => {
      off = true;
    };
  }, [client, p.status, dispatch]);

  const [speech, setSpeech] = useState<TimedSpeech | null>(null);
  const [cache, setCache] = useState<Record<string, TimedSpeech>>({});
  const [preview, setPreview] = useState<Preview>({ state: "idle" });
  // Sans WebGL : plus d'aperçu 3D ; un GLB qui ne charge pas : seulement pour cet avatar.
  const [noGl, setNoGl] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  // Une autre voix : la phrase de l'ancienne ne doit plus être rejouée.
  useEffect(() => setSpeech(null), [p.voiceId]);

  const save = async () => {
    const req = personaRequest(p);
    dispatch({ type: "persona_submit" });
    if (!req) return;
    try {
      await client.putPersona(req);
      dispatch({ type: "persona_saved" });
    } catch (err) {
      const code = errorCode(err);
      dispatch({ type: "persona_failed", code, error: personaErrorKey(code) });
    }
  };

  const listen = async () => {
    const key = `${p.voiceId}:${L}`;
    const hit = cache[key];
    // Un nouvel objet à chaque clic : l'avatar redit la phrase.
    if (hit) return setSpeech({ ...hit });
    setPreview({ state: "loading" });
    try {
      const s = await client.previewPersona({ voice_id: p.voiceId, lang: L });
      setCache((c) => ({ ...c, [key]: s }));
      setSpeech(s);
      setPreview({ state: "idle" });
    } catch (err) {
      if (err instanceof NokkerApiError && err.status === 429) setPreview({ state: "error", key: "errRate" });
      else if (err instanceof NokkerApiError && (err.status === 404 || err.status === 503)) setPreview({ state: "off" });
      else setPreview({ state: "error", key: "errGeneric" });
    }
  };

  if (p.status === "loading" || !p.catalog) {
    return (
      <section>
        <h1 id="ob-title" className="ob-title">{t(L, "personaTitle")}</h1>
        <p className="ob-status" role="status">{t(L, "personaLoading")}</p>
        <div className="ob-actions">
          <button type="button" className="ob-btn" onClick={() => dispatch({ type: "persona_skip" })}>{t(L, "personaSkip")}</button>
        </div>
      </section>
    );
  }

  const c = p.catalog;
  const saving = p.status === "saving";
  const selected = p.avatar ? c.avatars.find((a) => a.id === p.avatar!.id && a.version === p.avatar!.version) : undefined;
  const sameRef = (a: PersonaAvatarRef) => !!p.avatar && a.id === p.avatar.id && a.version === p.avatar.version;

  return (
    <section>
      <h1 id="ob-title" className="ob-title">{t(L, "personaTitle")}</h1>
      <p>{t(L, "personaIntro")}</p>

      {selected && !noGl && failedUrl !== selected.url && (
        <div className="ob-persona-stage">
          <TalkingAvatar
            avatarUrl={selected.url}
            lang={L}
            speech={speech}
            mood="happy"
            framing="head"
            onError={(code) => (code === "webgl_unavailable" ? setNoGl(true) : code === "load_failed" ? setFailedUrl(selected.url) : undefined)}
          />
        </div>
      )}

      <div className="ob-field">
        <label htmlFor="ob-persona-name">{t(L, "personaName")}</label>
        <input
          id="ob-persona-name"
          type="text"
          autoComplete="off"
          maxLength={c.name.max}
          value={p.name}
          disabled={saving}
          aria-invalid={p.field === "name"}
          aria-describedby="ob-persona-name-hint"
          onChange={(e) => dispatch({ type: "persona_name", value: e.target.value })}
        />
        <span className="ob-note" id="ob-persona-name-hint">{t(L, "personaNameHint", { max: String(c.name.max) })}</span>
      </div>

      <div className="ob-field">
        <label htmlFor="ob-persona-voice">{t(L, "personaVoice")}</label>
        <div className="ob-persona-voice">
          <select id="ob-persona-voice" value={p.voiceId} disabled={saving} aria-invalid={p.field === "voice"} onChange={(e) => dispatch({ type: "persona_voice", id: e.target.value })}>
            {c.voices.map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
          {preview.state !== "off" && (
            <button type="button" className="ob-btn" disabled={saving || preview.state === "loading"} onClick={() => void listen()}>
              {preview.state === "loading" ? t(L, "personaListening") : t(L, "personaListen")}
            </button>
          )}
        </div>
        {preview.state === "off" && <span className="ob-note">{t(L, "personaPreviewMuted")}</span>}
        {preview.state === "error" && <ErrorLine lang={L} k={preview.key} />}
      </div>

      <fieldset className="ob-persona-avatars" aria-invalid={p.field === "avatar"} disabled={saving}>
        <legend>{t(L, "personaAvatar")}</legend>
        {c.avatars.map((a) => (
          <button
            key={`${a.id}-${a.version}`}
            type="button"
            className={"ob-persona-thumb" + (sameRef(a) ? " on" : "")}
            aria-pressed={sameRef(a)}
            onClick={() => dispatch({ type: "persona_avatar", avatar: { id: a.id, version: a.version } })}
          >
            <img src={a.thumb} alt="" width={72} height={72} loading="lazy" />
            <span>{a.label}</span>
          </button>
        ))}
      </fieldset>

      <ErrorLine id="ob-persona-err" lang={L} k={p.error} />
      <div className="ob-actions">
        <button type="button" className="ob-btn primary" disabled={saving} onClick={() => void save()}>
          {saving ? t(L, "personaSaving") : t(L, "personaContinue")}
        </button>
        <button type="button" className="ob-btn" disabled={saving} onClick={() => dispatch({ type: "persona_skip" })}>{t(L, "personaSkip")}</button>
      </div>
    </section>
  );
}
