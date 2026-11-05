/**
 * Mon compte → Modèles (BYOK sur nokker.ai, lot du 05.11.2026) : Router de son plan, ou sa propre inférence
 * compatible OpenAI. Reprend la carte « Ma propre clé » du réglage Lokkal (`ByokForm` : essai, choix du modèle) ;
 * l'enregistrement renvoie la liste ENTIÈRE (`PUT /v1/account/models`), une clé non ressaisie reste au coffre.
 * `GET /v1/account/models` en 404 : noyau sans BYOK cloud, la carte n'existe pas. `entitled` faux : la formule ne
 * comprend pas le BYOK (le noyau décide quelles formules l'incluent), la carte renvoie vers les formules. La clé n'est jamais affichée ni relue.
 */
import React, { useEffect, useRef, useState } from "react";
import { ACCOUNT_BYOK_MAX, NokkerApiError, type AccountDefaultModel, type AccountModels, type NokkerClient } from "@nokker-apps/sdk";
import { ByokForm, type ByokListItem } from "../onboarding/ByokForm.js";
import { errorKey } from "../onboarding/errors.js";
import { t, type Lang } from "../onboarding/i18n.js";
import { off as offCap } from "../capabilities.js";

/** Liste de l'écran depuis la réponse du noyau (un point d'accès sans modèle retenu garde un libellé vide). */
export function byokItems(m: AccountModels): ByokListItem[] {
  return m.byok.map((b) => ({ name: b.name, base_url: b.base_url, model: b.model ?? "", hasKey: b.has_key === true }));
}

/** Nom accepté par le noyau (`[A-Za-z0-9][A-Za-z0-9_.-]{0,31}`) depuis le nom tiré de l'hôte. */
export function cloudByokName(name: string): string {
  const n = name.slice(0, 32).replace(/-+$/g, "");
  return /^[A-Za-z0-9]/.test(n) ? n : `k${n}`.slice(0, 32);
}

/** Hôte + port d'une adresse : la clé rangée ne suit l'entrée que si cet hôte ne change pas (§2 PUT). */
export function hostOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl.trim());
    return `${u.hostname.toLowerCase()}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return baseUrl.trim().toLowerCase();
  }
}

/** Entrées qui avaient une clé avant l'enregistrement et n'en ont plus après (hôte changé sans nouvelle clé). */
export function droppedKeys(before: ReadonlyArray<ByokListItem>, after: AccountModels, typed: ReadonlySet<string>): string[] {
  return after.byok.filter((b) => b.has_key === false && !typed.has(b.name) && before.some((x) => x.name === b.name && x.hasKey)).map((b) => b.name);
}

/** Défaut valide pour la liste : un `byok:<nom>` retiré retombe sur le Router ; sans Router (formule byok), sur la
 * première entrée qui a un modèle, sinon `null` (rien à envoyer). */
export function validDefault(def: AccountDefaultModel, list: ReadonlyArray<Pick<ByokListItem, "name" | "model">>, routerIncluded = true): AccountDefaultModel | null {
  if (def !== "router" && list.some((b) => `byok:${b.name}` === def && b.model)) return def;
  if (routerIncluded) return "router";
  const first = list.find((b) => b.model);
  return first ? `byok:${first.name}` : null;
}

export function ModelsCard({ client, lang }: { client: NokkerClient; lang: Lang }): React.ReactElement | null {
  const [models, setModels] = useState<AccountModels | null>(null);
  const [absent, setAbsent] = useState(false);
  const [list, setList] = useState<ByokListItem[]>([]);
  const [def, setDef] = useState<AccountDefaultModel | null>("router");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [dropped, setDropped] = useState<string[]>([]);
  // Entrées telles qu'enregistrées (pour savoir si une adresse a changé d'hôte).
  const stored = useRef<ByokListItem[]>([]);
  // Clés saisies et pas encore enregistrées, par nom : jamais dans l'état React.
  const keys = useRef(new Map<string, string>());

  const apply = (m: AccountModels): void => {
    setModels(m);
    const items = byokItems(m);
    stored.current = items;
    setList(items);
    setDef(validDefault(m.default, items, m.router_included !== false));
    setDirty(false);
  };

  useEffect(() => {
    if (offCap("cloud_byok")) return setAbsent(true);
    let live = true;
    client.getAccountModels().then(
      (m) => live && apply(m),
      (e) => {
        if (!live) return;
        if (e instanceof NokkerApiError && e.status === 404) setAbsent(true);
        else setErr(e);
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  if (absent) return null;
  const entitled = models?.entitled ?? false;
  const routerIncluded = models?.router_included !== false;

  const change = (): void => {
    setDirty(true);
    setSaved(false);
    setErr(null);
  };
  const add = (hostName: string, baseUrl: string, model: string, key: string): void => {
    const name = cloudByokName(hostName);
    if (key) keys.current.set(name, key);
    // Sans nouvelle clé, la clé rangée ne suit que si l'hôte (nom + port) ne change pas.
    const prev = stored.current.find((b) => b.name === name);
    const keeps = !!prev?.hasKey && hostOf(prev.base_url) === hostOf(baseUrl);
    setList((l) => [...l.filter((b) => b.name !== name), { name, base_url: baseUrl, model, hasKey: !!key || keeps }]);
    setDef(`byok:${name}`);
    change();
  };
  const remove = (name: string): void => {
    keys.current.delete(name);
    const next = list.filter((b) => b.name !== name);
    setList(next);
    setDef((d) => validDefault(d ?? "router", next, routerIncluded));
    change();
  };
  const save = (): void => {
    setBusy(true);
    setErr(null);
    const byok = list.map((b) => {
      const key = keys.current.get(b.name);
      return { name: b.name, base_url: b.base_url, ...(b.model ? { model: b.model } : {}), ...(key ? { api_key: key } : {}) };
    });
    const typed = new Set(keys.current.keys());
    const before = stored.current;
    const d = validDefault(def ?? "router", list, routerIncluded);
    client.putAccountModels({ ...(d ? { default: d } : {}), byok }).then(
      (m) => {
        keys.current.clear();
        setDropped(droppedKeys(before, m, typed));
        apply(m);
        setSaved(true);
        setBusy(false);
      },
      (e) => {
        setErr(e);
        setBusy(false);
      },
    );
  };
  const toPlans = (): void => document.getElementById("acc-sub")?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <section className="ob-conn" aria-labelledby="acc-models" data-account-models>
      <h3 id="acc-models">{t(lang, "accModels")}</h3>
      <p className="ob-note">{t(lang, "accModelsIntro")}</p>
      {err ? (
        <p className="ob-error" role="alert">
          {t(lang, errorKey(err))}
        </p>
      ) : null}
      {models && !entitled ? (
        <div className="ob-note" data-models-locked>
          <p>{t(lang, models.default !== "router" ? "accModelsOnRouter" : "accModelsLocked")}</p>
          <button type="button" className="ob-btn" onClick={toPlans}>
            {t(lang, "accModelsSeePlans")}
          </button>
        </div>
      ) : null}
      {models && entitled ? (
        <>
          {models.effective === "none" ? (
            <p className="ob-note acc-models-none" role="status" data-models-none>
              {t(lang, "accModelsNone")}
            </p>
          ) : null}
          {routerIncluded || list.length ? (
            <fieldset className="acc-models-default">
              <legend>{t(lang, "accModelsDefault")}</legend>
              {routerIncluded ? (
                <label className="acc-radio">
                  <input type="radio" name="acc-default-model" value="router" checked={def === "router"} onChange={() => (setDef("router"), change())} />
                  <span>{t(lang, "accModelsRouter")}</span>
                </label>
              ) : null}
              {list.map((b) => (
                <label key={b.name} className="acc-radio">
                  <input type="radio" name="acc-default-model" value={`byok:${b.name}`} checked={def === `byok:${b.name}`} onChange={() => (setDef(`byok:${b.name}`), change())} />
                  <span>{t(lang, "accModelsByokOption", { name: b.name, model: b.model || "—" })}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
          {dropped.map((n) => (
            <p key={n} className="ob-note" role="status" data-key-dropped={n}>
              {t(lang, "accModelsKeyDropped", { name: n })}
            </p>
          ))}
          {list.length >= ACCOUNT_BYOK_MAX ? <p className="ob-muted">{t(lang, "accModelsFull")}</p> : null}
          <ByokForm
            lang={lang}
            canAdd={list.length < ACCOUNT_BYOK_MAX}
            idPrefix="acc"
            list={list}
            test={(req) => client.testAccountModel(req)}
            onAdd={add}
            onRemove={remove}
            httpsOnly
            bodyKey="accModelsByokBody"
            errorKeyOf={errorKey}
          />
          <div className="ob-actions inline" aria-live="polite">
            <button type="button" className="ob-btn primary" disabled={!dirty || busy} onClick={save}>
              {busy ? t(lang, "accModelsSaving") : t(lang, "accModelsSave")}
            </button>
            {dirty ? <span className="ob-muted">{t(lang, "accModelsUnsaved")}</span> : saved ? <span className="ob-okline">{t(lang, "accModelsSaved")}</span> : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
