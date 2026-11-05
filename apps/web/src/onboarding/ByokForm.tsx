/**
 * Carte « Ma propre clé » : essai d'un point d'accès compatible OpenAI, choix du modèle, ajout à la liste. Partagée
 * par le réglage Lokkal (`/setup`, coffre de la machine) et par Mon compte → Modèles sur nokker.ai (coffre du compte).
 * La clé ne vit que dans une référence le temps de l'essai, jamais dans l'état React, et n'est plus jamais affichée.
 */
import React, { useRef, useState } from "react";
import type { LocalModelTestRequest, LocalModelTestResult } from "@nokker-apps/sdk";
import { localErrorKey, testErrorKind } from "./errors.js";
import { t, type Key, type Lang } from "./i18n.js";
import { byokName, validApiUrl, type ByokEntry } from "./localFlow.js";

export type ByokListItem = Pick<ByokEntry, "name" | "base_url" | "model" | "hasKey">;

/** `https://` seulement (nokker.ai : l'inférence du client part du nuage, jamais en clair). */
export function httpsApiUrl(baseUrl: string): boolean {
  return validApiUrl(baseUrl) && /^https:\/\//i.test(baseUrl.trim());
}

export function ByokForm(props: {
  lang: Lang;
  /** Préfixe des ids (`lk` sur Lokkal : ids historiques `lk-byok-*`). */
  idPrefix: string;
  list: ByokListItem[];
  test: (req: LocalModelTestRequest) => Promise<LocalModelTestResult>;
  onAdd: (name: string, baseUrl: string, model: string, key: string) => void;
  onRemove: (name: string) => void;
  httpsOnly?: boolean;
  /** Faux : la liste est pleine, le formulaire d'essai est masqué (la liste reste). */
  canAdd?: boolean;
  /** Texte sous le titre (sinon celui de Lokkal : « rangée dans le coffre de cette machine »). */
  bodyKey?: Key;
  errorKeyOf?: (err: unknown) => Key;
}): React.ReactElement {
  const L = props.lang;
  const id = (s: string): string => `${props.idPrefix}-byok${s}`;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [info, setInfo] = useState<string | undefined>();
  // Essai réussi, en attente du choix du modèle. La clé reste dans cette référence, jamais dans l'état React.
  const [tested, setTested] = useState<{ baseUrl: string; models: string[] } | null>(null);
  const testedKey = useRef("");

  const test = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const baseUrl = String(new FormData(form).get("base_url") ?? "").trim();
    const keyField = form.elements.namedItem("api_key") as HTMLInputElement | null;
    const key = keyField?.value ?? "";
    setInfo(undefined);
    setTested(null);
    if (props.httpsOnly ? !httpsApiUrl(baseUrl) : !validApiUrl(baseUrl)) return void setError(t(L, props.httpsOnly ? "lkByokHttpsNeeded" : "lkByokUrlNeeded"));
    setBusy(true);
    setError(undefined);
    try {
      const r = await props.test({ base_url: baseUrl, ...(key ? { api_key: key } : {}) });
      if (r.ok) {
        testedKey.current = key;
        setTested({ baseUrl, models: r.models });
        setInfo(t(L, "lkByokOk", { n: String(r.models.length), ms: String(r.latency_ms ?? "–") }));
        if (keyField) keyField.value = ""; // la clé a quitté le champ : elle n'est plus affichée
      } else {
        const kind = testErrorKind(r.error);
        setError(kind === "invalid_key" ? t(L, "lkByokInvalidKey") : kind === "url" ? t(L, props.httpsOnly ? "lkByokHttpsNeeded" : "lkByokUrlNeeded") : t(L, "lkByokUnreachable", { detail: r.error || "?" }));
      }
    } catch (err) {
      setError(t(L, (props.errorKeyOf ?? localErrorKey)(err)));
    } finally {
      setBusy(false);
    }
  };

  const add = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!tested) return;
    const model = String(new FormData(e.currentTarget).get("model") ?? "").trim();
    if (!model) return;
    props.onAdd(byokName(tested.baseUrl), tested.baseUrl, model, testedKey.current);
    testedKey.current = "";
    setTested(null);
    setInfo(undefined);
  };

  const ready = props.list;
  return (
    <article className="ob-conn" aria-labelledby={id("")}>
      <div className="ob-conn-head">
        <h3 id={id("")}>{t(L, "lkByokTitle")}</h3>
        <span className={"ob-badge " + (ready.length ? "ok" : "absent")}>{ready.length ? t(L, "lkByokReady") : t(L, "stateAbsent")}</span>
      </div>
      <p className="ob-note">{t(L, props.bodyKey ?? "lkByokBody")}</p>
      {ready.map((b) => (
        <p key={b.name} className="ob-account lk-byok-ok">
          <span className="mono">{b.name}</span>
          <span className="ob-muted"> · <span className="mono">{b.model}</span> · {t(L, b.hasKey ? "lkByokKeyStored" : "lkByokNoKey")} </span>
          <button type="button" className="ob-btn link" onClick={() => props.onRemove(b.name)}>{t(L, "lkByokRemove")}</button>
        </p>
      ))}
      {props.canAdd === false ? null : (
        <form className="ob-form" onSubmit={test} autoComplete="off">
          <div className="ob-field">
            <label htmlFor={id("-url")}>{t(L, "lkByokUrl")}</label>
            <input id={id("-url")} name="base_url" type="url" inputMode="url" placeholder="https://api.exemple.com/v1" autoComplete="off" autoCapitalize="none" spellCheck={false} required onChange={() => setTested(null)} />
          </div>
          <div className="ob-field">
            <label htmlFor={id("-key")}>{t(L, "lkByokKey")}</label>
            <input id={id("-key")} name="api_key" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </div>
          <div className="ob-row" aria-live="polite">
            {error && <p className="ob-error" role="alert">{error}</p>}
            {info && !error && <p className="ob-okline">{info}</p>}
          </div>
          <div className="ob-actions inline">
            <button type="submit" className="ob-btn" disabled={busy}>{busy ? t(L, "lkByokTesting") : t(L, "lkByokTest")}</button>
          </div>
        </form>
      )}
      {tested && props.canAdd !== false && (
        <form className="ob-form lk-byok-model" onSubmit={add} autoComplete="off">
          <div className="ob-field">
            <label htmlFor={id("-model")}>{t(L, "lkByokModel")}</label>
            {tested.models.length > 0 ? (
              <select id={id("-model")} name="model" defaultValue={tested.models[0]} required>
                {tested.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input id={id("-model")} name="model" type="text" autoCapitalize="none" spellCheck={false} required />
            )}
          </div>
          <div className="ob-actions inline">
            <button type="submit" className="ob-btn primary">{t(L, "lkByokAdd")}</button>
          </div>
        </form>
      )}
    </article>
  );
}
