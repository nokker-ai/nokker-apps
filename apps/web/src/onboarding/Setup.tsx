import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { BRAND } from "@nokker-apps/brand";
import { NokkerApiError, type NokkerClient } from "@nokker-apps/sdk";
import { createClient } from "../api.js";
import { uiLang } from "../components/ConnectorsTab.js";
import { writeJson } from "../viewState.js";
import { ConnectorsStep, ErrorLine, TelegramStep } from "./Connectors.js";
import { localErrorKey, testErrorKind } from "./errors.js";
import { t, type Key } from "./i18n.js";
import { takeLocalToken } from "./localToken.js";
import { StepsNav } from "./Onboarding.js";
import { DefaultPicker, optionLabel, RouterCard } from "./SetupParts.js";
import {
  byokName,
  canContinueModels,
  defaultOptions,
  initialLocalState,
  missingWithoutRouter,
  reduceLocal,
  RUNTIME_LABEL,
  validApiUrl,
  type LocalAction,
  type LocalFlowState,
  type LocalStep,
} from "./localFlow.js";

/** Page `/setup` de Lokkal : premier lancement, sur http://127.0.0.1:<port> (docs/LOKKAL.md §7). */

const STEPS: { step: LocalStep; label: Key }[] = [
  { step: "models", label: "lkStepModels" },
  { step: "connectors", label: "stepConnectors" },
  { step: "channels", label: "lkStepChannels" },
  { step: "done", label: "stepDone" },
];

type Dispatch = React.Dispatch<LocalAction>;

/** 502 = nokker.ai ne sert pas encore le lien (écran de repli, pas une panne) ; 503 = coffre sans clé ; le reste = injoignable. */
function linkFailure(err: unknown): LocalAction {
  if (err instanceof NokkerApiError && err.status === 502) return { type: "link_unavailable" };
  if (err instanceof NokkerApiError && err.status === 503) return { type: "link_vault" };
  return { type: "link_failed" };
}


export function Setup(): React.ReactElement {
  // Le jeton local sert à tout : routes /v1/local/*, connecteurs, Telegram. Sans lui, rien ne s'ouvre.
  const [localToken] = useState(takeLocalToken);
  const client = useMemo(() => {
    const c = createClient();
    if (localToken) c.setToken(localToken);
    return c;
  }, [localToken]);
  const [s, dispatch] = useReducer(reduceLocal, undefined, () => initialLocalState(uiLang()));
  const L = s.lang;
  // Les clés d'API n'existent qu'ici, en mémoire, le temps d'aller du test au PUT ; jamais dans l'état React.
  const keys = useRef(new Map<string, string>());
  const connectorKinds = useRef({ mail: false, calendar: false });

  useEffect(() => {
    document.title = `${t(L, "lkTitle")} · ${BRAND.productName}`;
    document.documentElement.lang = L;
    writeJson("lang", L);
  }, [L]);

  useEffect(() => {
    if (s.step !== "loading") return;
    let off = false;
    if (!localToken) {
      dispatch({ type: "setup_locked" });
      return;
    }
    client
      .getLocalSetup()
      .then((setup) => !off && dispatch({ type: "setup_loaded", setup }))
      .catch((err) => !off && dispatch({ type: err instanceof NokkerApiError && err.status === 401 ? "setup_locked" : "setup_failed" }));
    return () => {
      off = true;
    };
  }, [client, s.step]);

  // Sondage du flux d'appareil tant qu'un code attend l'approbation.
  const waiting = s.link.phase === "waiting" ? s.link : null;
  useEffect(() => {
    if (!waiting) return;
    let off = false;
    const id = setInterval(() => {
      client
        .getLocalLinkStatus()
        .then((r) => !off && dispatch({ type: "link_status", state: r.state, account: r.account ?? undefined }))
        .catch((err) => !off && dispatch(linkFailure(err)));
    }, Math.max(1, waiting.interval) * 1000);
    return () => {
      off = true;
      clearInterval(id);
    };
  }, [client, waiting?.code, waiting?.interval]); // eslint-disable-line react-hooks/exhaustive-deps

  const startLink = useCallback(() => {
    dispatch({ type: "link_start" });
    client
      .startLocalLink()
      .then((r) => dispatch({ type: "link_started", code: r.user_code, uri: r.verification_uri, expiresAt: Date.now() + r.expires_in * 1000, interval: r.interval }))
      .catch((err) => dispatch(linkFailure(err)));
  }, [client]);

  const saveModels = useCallback(async () => {
    if (!canContinueModels(s) || !s.chosen) return;
    dispatch({ type: "models_submit" });
    try {
      // `byok` remplace la liste du noyau : on la renvoie en entier ; une clé non ressaisie reste au coffre.
      const byok = s.byok.map((b) => {
        const key = keys.current.get(b.name);
        return { name: b.name, base_url: b.base_url, model: b.model, ok: true, ...(key ? { api_key: key } : {}) };
      });
      const setup = await client.putLocalModels({ default: s.chosen, byok });
      keys.current.clear();
      dispatch({ type: "models_saved", setup });
    } catch (err) {
      dispatch({ type: "models_failed", error: localErrorKey(err) });
    }
  }, [client, s]);

  const finish = useCallback(async () => {
    dispatch({ type: "finish_submit" });
    try {
      await client.finishLocalSetup();
      dispatch({ type: "finish_ok" });
    } catch (err) {
      dispatch({ type: "finish_failed", error: localErrorKey(err) });
    }
  }, [client]);

  useEffect(() => {
    if (s.finished) location.assign("/");
  }, [s.finished]);

  const inFlow = STEPS.some((x) => x.step === s.step);

  return (
    <div className="ob">
      <main className="ob-card" aria-labelledby="ob-title">
        <header className="ob-head">
          <img className="ob-mark only-light" src="/brand/nokker-emblem-light.svg" alt="" width={36} height={36} />
          <img className="ob-mark only-dark" src="/brand/nokker-emblem-dark.svg" alt="" width={36} height={36} />
          <span className="ob-brand">{BRAND.productName}</span>
          <div className="ob-lang lk-lang" role="group" aria-label="Langue / Language">
            {(["fr", "en"] as const).map((l) => (
              <button key={l} type="button" className={"ob-chip" + (L === l ? " on" : "")} aria-pressed={L === l} onClick={() => dispatch({ type: "set_lang", lang: l })}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </header>
        {inFlow && <StepsNav steps={STEPS} current={s.step} lang={L} />}
        {s.step === "loading" && <p className="ob-status" role="status">{t(L, "lkLoading")}</p>}
        {s.step === "unreachable" && (
          <section aria-live="polite">
            <h1 id="ob-title" className="ob-title">{t(L, "lkUnreachableTitle")}</h1>
            <p>{t(L, "lkUnreachableBody")}</p>
            <button type="button" className="ob-btn primary" onClick={() => dispatch({ type: "retry" })}>{t(L, "retry")}</button>
          </section>
        )}
        {s.step === "locked" && (
          <section aria-live="polite">
            <h1 id="ob-title" className="ob-title">{t(L, "lkLockedTitle")}</h1>
            <p>{t(L, "lkLockedBody")}</p>
          </section>
        )}
        {s.step === "models" && <ModelsStep s={s} client={client} keys={keys.current} dispatch={dispatch} onStartLink={startLink} onSave={() => void saveModels()} />}
        {s.step === "connectors" && (
          <ConnectorsStep
            client={client}
            lang={L}
            anyLinked={s.connectorsLinked}
            onLinked={(kind, linked) => {
              connectorKinds.current[kind] = linked;
              dispatch({ type: "connectors_linked", any: connectorKinds.current.mail || connectorKinds.current.calendar });
            }}
            onNext={() => dispatch({ type: "next" })}
          />
        )}
        {s.step === "channels" && (
          <section className="lk-channels">
            <h1 id="ob-title" className="ob-title">{t(L, "lkChannelsTitle")}</h1>
            <p>{t(L, "lkChannelsIntro")}</p>
            <TelegramStep client={client} lang={L} embedded onGenerated={() => dispatch({ type: "telegram_started" })} />
            <div className="ob-actions">
              <button type="button" className={"ob-btn" + (s.telegramStarted ? " primary" : "")} onClick={() => dispatch({ type: "next" })}>
                {s.telegramStarted ? t(L, "next") : t(L, "skip")}
              </button>
            </div>
          </section>
        )}
        {s.step === "done" && <DoneStep s={s} onFinish={() => void finish()} />}
      </main>
    </div>
  );
}

// -- Étape Modèles --------------------------------------------------------------------------

function ModelsStep(props: {
  s: LocalFlowState;
  client: NokkerClient;
  keys: Map<string, string>;
  dispatch: Dispatch;
  onStartLink: () => void;
  onSave: () => void;
}): React.ReactElement {
  const { s, dispatch } = props;
  const L = s.lang;
  const ok = canContinueModels(s);
  const options = defaultOptions(s);
  return (
    <section>
      <h1 id="ob-title" className="ob-title">{t(L, "lkModelsTitle")}</h1>
      <p>{t(L, "lkModelsIntro")}</p>
      <RouterCard lang={L} routerLinked={s.routerLinked} account={s.account} link={s.link} onStart={props.onStartLink} />
      <ByokCard
        s={s}
        client={props.client}
        onAdd={(name, baseUrl, model, key) => {
          if (key) props.keys.set(name, key);
          else props.keys.delete(name);
          dispatch({ type: "byok_added", name, base_url: baseUrl, model, hasKey: !!key || (s.byok.find((b) => b.name === name)?.hasKey ?? false) });
        }}
        onRemove={(name) => {
          props.keys.delete(name);
          dispatch({ type: "byok_removed", name });
        }}
      />
      {s.local.length > 0 && <LocalCard s={s} />}
      <DefaultPicker lang={L} options={options} chosen={s.chosen} disabled={s.submitting} onChoose={(value) => dispatch({ type: "choose", value })} />
      {missingWithoutRouter(s) && <p className="ob-note lk-missing">{t(L, "lkMissing")}</p>}
      <ErrorLine lang={L} k={s.error} />
      <div className="ob-actions">
        <button type="button" className="ob-btn primary" disabled={!ok} aria-disabled={!ok} onClick={props.onSave}>
          {s.submitting ? t(L, "lkSaving") : t(L, "next")}
        </button>
      </div>
      {options.length === 0 && <p className="ob-hint">{t(L, "lkNeedDefault")}</p>}
    </section>
  );
}

function ByokCard(props: {
  s: LocalFlowState;
  client: NokkerClient;
  onAdd: (name: string, baseUrl: string, model: string, key: string) => void;
  onRemove: (name: string) => void;
}): React.ReactElement {
  const { s, client } = props;
  const L = s.lang;
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
    if (!validApiUrl(baseUrl)) return void setError(t(L, "lkByokUrlNeeded"));
    setBusy(true);
    setError(undefined);
    try {
      const r = await client.testLocalModel({ base_url: baseUrl, ...(key ? { api_key: key } : {}) });
      if (r.ok) {
        testedKey.current = key;
        setTested({ baseUrl, models: r.models });
        setInfo(t(L, "lkByokOk", { n: String(r.models.length), ms: String(r.latency_ms ?? "–") }));
        if (keyField) keyField.value = ""; // la clé a quitté le champ : elle n'est plus affichée
      } else {
        const kind = testErrorKind(r.error);
        setError(kind === "invalid_key" ? t(L, "lkByokInvalidKey") : kind === "url" ? t(L, "lkByokUrlNeeded") : t(L, "lkByokUnreachable", { detail: r.error || "?" }));
      }
    } catch (err) {
      setError(t(L, localErrorKey(err)));
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

  const ready = s.byok;
  return (
    <article className="ob-conn" aria-labelledby="lk-byok">
      <div className="ob-conn-head">
        <h3 id="lk-byok">{t(L, "lkByokTitle")}</h3>
        <span className={"ob-badge " + (ready.length ? "ok" : "absent")}>{ready.length ? t(L, "lkByokReady") : t(L, "stateAbsent")}</span>
      </div>
      <p className="ob-note">{t(L, "lkByokBody")}</p>
      {ready.map((b) => (
        <p key={b.name} className="ob-account lk-byok-ok">
          <span className="mono">{b.name}</span>
          <span className="ob-muted"> · <span className="mono">{b.model}</span> · {t(L, b.hasKey ? "lkByokKeyStored" : "lkByokNoKey")} </span>
          <button type="button" className="ob-btn link" onClick={() => props.onRemove(b.name)}>{t(L, "lkByokRemove")}</button>
        </p>
      ))}
      <form className="ob-form" onSubmit={test} autoComplete="off">
        <div className="ob-field">
          <label htmlFor="lk-byok-url">{t(L, "lkByokUrl")}</label>
          <input id="lk-byok-url" name="base_url" type="url" inputMode="url" placeholder="https://api.exemple.com/v1" autoComplete="off" autoCapitalize="none" spellCheck={false} required onChange={() => setTested(null)} />
        </div>
        <div className="ob-field">
          <label htmlFor="lk-byok-key">{t(L, "lkByokKey")}</label>
          <input id="lk-byok-key" name="api_key" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} />
        </div>
        <div className="ob-row" aria-live="polite">
          {error && <p className="ob-error" role="alert">{error}</p>}
          {info && !error && <p className="ob-okline">{info}</p>}
        </div>
        <div className="ob-actions inline">
          <button type="submit" className="ob-btn" disabled={busy}>{busy ? t(L, "lkByokTesting") : t(L, "lkByokTest")}</button>
        </div>
      </form>
      {tested && (
        <form className="ob-form lk-byok-model" onSubmit={add} autoComplete="off">
          <div className="ob-field">
            <label htmlFor="lk-byok-model">{t(L, "lkByokModel")}</label>
            {tested.models.length > 0 ? (
              <select id="lk-byok-model" name="model" defaultValue={tested.models[0]} required>
                {tested.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input id="lk-byok-model" name="model" type="text" autoCapitalize="none" spellCheck={false} required />
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

function LocalCard({ s }: { s: LocalFlowState }): React.ReactElement {
  const L = s.lang;
  return (
    <article className="ob-conn" aria-labelledby="lk-local">
      <div className="ob-conn-head">
        <h3 id="lk-local">{t(L, "lkLocalTitle")}</h3>
        <span className="ob-badge ok">{t(L, "stateOk")}</span>
      </div>
      {s.local.map((m) => (
        <div key={m.url}>
          <p className="lk-local-line">{t(L, "lkLocalBody", { runtime: RUNTIME_LABEL[m.runtime] })} <span className="mono">{m.url}</span></p>
          <p className="ob-note">{t(L, "lkLocalModels", { n: String(m.models.length), list: m.models.join(", ") })}</p>
        </div>
      ))}
    </article>
  );
}

// -- Fin --------------------------------------------------------------------------------------

function DoneStep({ s, onFinish }: { s: LocalFlowState; onFinish: () => void }): React.ReactElement {
  const L = s.lang;
  const chosen = defaultOptions(s).find((o) => o.value === s.chosen);
  const rows: [string, boolean, string][] = [
    [t(L, "lkDoneModel"), !!chosen, chosen ? optionLabel(L, chosen) : t(L, "doneSkipped")],
    [t(L, "lkDoneAccount"), s.routerLinked, s.routerLinked ? t(L, "doneLinked") : t(L, "doneSkipped")],
    [t(L, "stepConnectors"), s.connectorsLinked, s.connectorsLinked ? t(L, "doneLinked") : t(L, "doneSkipped")],
    [t(L, "stepTelegram"), s.telegramStarted, s.telegramStarted ? t(L, "doneCodeSent") : t(L, "doneSkipped")],
  ];
  return (
    <section>
      <h1 id="ob-title" className="ob-title">{t(L, "lkDoneTitle")}</h1>
      <p>{t(L, "lkDoneBody")}</p>
      <ul className="ob-summary">
        {rows.map(([label, on, value]) => (
          <li key={label} className={on ? "on" : ""}>
            <span>{label}</span>
            <span>{value}</span>
          </li>
        ))}
      </ul>
      {missingWithoutRouter(s) && <p className="ob-note lk-missing">{t(L, "lkMissing")}</p>}
      <ErrorLine lang={L} k={s.error} />
      <div className="ob-actions">
        <button type="button" className="ob-btn primary" disabled={s.submitting || s.finished} onClick={onFinish}>
          {s.submitting || s.finished ? t(L, "lkDoning") : t(L, "lkDoneOpen")}
        </button>
      </div>
    </section>
  );
}
