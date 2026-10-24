import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectorCard, ConnectorKind, NokkerClient, TelegramPairing } from "@nokker-apps/sdk";
import { errorKey, keyForCode } from "./errors.js";
import {
  buildCalendarRequest,
  buildMailRequest,
  formatCountdown,
  needsAppPassword,
  orderPresets,
  presetLabel,
  secondsLeft,
} from "./flow.js";
import { t, type Key, type Lang } from "./i18n.js";

/** Étapes Connecteurs et Telegram, partagées par le parcours `/invite` et l'onglet « Connecteurs » de l'App. */

export function ErrorLine({ id, lang, k }: { id?: string; lang: Lang; k?: string }): React.ReactElement | null {
  return k ? <p id={id} className="ob-error" role="alert">{t(lang, k as Key)}</p> : null;
}

// -- Connecteurs ------------------------------------------------------------

type Busy = "save" | "test" | "revoke" | null;

/** `embedded` : dans l'App (onglet Connecteurs), sans parcours — titre h2, pas de bouton « Passer/Continuer ». */
export function ConnectorsStep(props: {
  client: NokkerClient;
  lang: Lang;
  embedded?: boolean;
  anyLinked?: boolean;
  onLinked?: (kind: ConnectorKind, linked: boolean) => void;
  onNext?: () => void;
}): React.ReactElement {
  const { client, lang: L } = props;
  const onLinked = useRef(props.onLinked);
  onLinked.current = props.onLinked;
  const [cards, setCards] = useState<ConnectorCard[] | null>(null);
  const [presets, setPresets] = useState<string[]>(orderPresets(["gmail", "icloud", "infomaniak", "fastmail"]));
  const [loadError, setLoadError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const l = await client.listConnectors();
      setCards(l.connectors);
      if (l.presets?.mail?.length) setPresets(orderPresets(l.presets.mail));
      for (const c of l.connectors) onLinked.current?.(c.kind, c.state !== "absent");
      setLoadError(undefined);
    } catch (err) {
      setCards([]);
      setLoadError(errorKey(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const card = (kind: ConnectorKind): ConnectorCard => cards?.find((c) => c.kind === kind) ?? { kind, state: "absent" };

  return (
    <section>
      {!props.embedded && (
        <>
          <h1 id="ob-title" className="ob-title">{t(L, "connectorsTitle")}</h1>
          <p>{t(L, "connectorsIntro")}</p>
        </>
      )}
      <ErrorLine lang={L} k={loadError} />
      {cards !== null && (
        <>
          <ConnectorPanel kind="mail" client={client} lang={L} card={card("mail")} presets={presets} onChanged={refresh} />
          <ConnectorPanel kind="calendar" client={client} lang={L} card={card("calendar")} presets={presets} onChanged={refresh} />
        </>
      )}
      {props.onNext && (
        <div className="ob-actions">
          <button type="button" className="ob-btn primary" onClick={props.onNext}>
            {props.anyLinked ? t(L, "next") : t(L, "skip")}
          </button>
        </div>
      )}
    </section>
  );
}

const STATE_KEY: Record<ConnectorCard["state"], Key> = { absent: "stateAbsent", unverified: "stateUnverified", ok: "stateOk" };

function linkedAccount(card: ConnectorCard): string {
  const st = card.settings ?? {};
  return String(st.address ?? st.username ?? st.label ?? st.url ?? "");
}

function ConnectorPanel(props: {
  kind: ConnectorKind;
  client: NokkerClient;
  lang: Lang;
  card: ConnectorCard;
  presets: string[];
  onChanged: () => Promise<void>;
}): React.ReactElement {
  const { kind, client, lang: L, card, onChanged } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | undefined>();
  const [info, setInfo] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [preset, setPreset] = useState(props.presets[0] ?? "gmail");
  const [calMode, setCalMode] = useState<"ical" | "caldav">("ical");
  const formRef = useRef<HTMLFormElement>(null);
  const titleId = `ob-c-${kind}`;
  const linked = card.state !== "absent";

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const get = (n: string) => String(data.get(n) ?? "");
    // Le secret vit dans le champ, jamais dans l'état React : lu ici, puis le champ est vidé avant l'envoi.
    const secret = get("secret");
    const secretField = form.elements.namedItem("secret") as HTMLInputElement | null;
    if (secretField) secretField.value = "";
    const req =
      kind === "mail"
        ? buildMailRequest({ preset: get("preset"), address: get("address"), secret, imapHost: get("imapHost"), imapPort: get("imapPort"), smtpHost: get("smtpHost"), smtpPort: get("smtpPort") })
        : get("mode") === "caldav"
          ? buildCalendarRequest({ mode: "caldav", url: get("url"), username: get("username"), secret })
          : buildCalendarRequest({ mode: "ical", label: get("label"), secret });
    if (!req) return void setError("errFieldsRequired");
    setBusy("save");
    setError(undefined);
    setInfo(undefined);
    try {
      await client.putConnector(kind, req);
      setOpen(false);
      await onChanged();
    } catch (err) {
      setError(errorKey(err));
    } finally {
      setBusy(null);
    }
  };

  const run = async (what: "test" | "revoke") => {
    setConfirming(false);
    setBusy(what);
    setError(undefined);
    setInfo(undefined);
    try {
      if (what === "test") {
        const r = await client.testConnector(kind);
        if (r.ok) setInfo("testOk");
        else setError(keyForCode(r.code));
      } else {
        await client.deleteConnector(kind);
        setInfo("revoked");
      }
      await onChanged();
    } catch (err) {
      setError(errorKey(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="ob-conn" aria-labelledby={titleId}>
      <div className="ob-conn-head">
        <h3 id={titleId}>{t(L, kind === "mail" ? "mail" : "calendar")}</h3>
        <span className={"ob-badge " + card.state}>{t(L, STATE_KEY[card.state])}</span>
      </div>
      {linked && (
        <p className="ob-account">
          <span className="ob-muted">{t(L, "linkedAccount")} · </span>
          <span className="mono">{linkedAccount(card)}</span>
        </p>
      )}
      <div className="ob-row" aria-live="polite">
        {error && <p className="ob-error" role="alert">{t(L, error as Key)}</p>}
        {info && !error && <p className="ob-okline">{t(L, info as Key)}</p>}
      </div>
      {!open && (
        <div className="ob-actions inline">
          <button type="button" className="ob-btn" disabled={busy !== null} onClick={() => setOpen(true)}>
            {linked ? t(L, "edit") : t(L, "connect")}
          </button>
          {linked && (
            <>
              <button type="button" className="ob-btn" disabled={busy !== null} onClick={() => void run("test")}>
                {busy === "test" ? t(L, "testing") : t(L, "test")}
              </button>
              {confirming ? (
                <>
                  <button type="button" className="ob-btn danger" disabled={busy !== null} onClick={() => void run("revoke")}>
                    {t(L, "revokeConfirm")}
                  </button>
                  <button type="button" className="ob-btn" onClick={() => setConfirming(false)}>{t(L, "cancel")}</button>
                </>
              ) : (
                <button type="button" className="ob-btn danger" disabled={busy !== null} onClick={() => { setInfo(undefined); setConfirming(true); }}>
                  {t(L, "revoke")}
                </button>
              )}
            </>
          )}
        </div>
      )}
      {open && (
        <form ref={formRef} className="ob-form" onSubmit={save} autoComplete="off">
          {kind === "mail" ? (
            <>
              <Field label={t(L, "mailPreset")} htmlFor="ob-mail-preset">
                <select id="ob-mail-preset" name="preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
                  {props.presets.map((p) => (
                    <option key={p} value={p}>{presetLabel(p)}</option>
                  ))}
                  <option value="custom">{t(L, "presetCustom")}</option>
                </select>
              </Field>
              <Field label={t(L, "mailAddress")} htmlFor="ob-mail-address">
                <input id="ob-mail-address" name="address" type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} required />
              </Field>
              {preset === "custom" && (
                <>
                  <Field label={t(L, "imapHost")} htmlFor="ob-imap-host"><input id="ob-imap-host" name="imapHost" autoComplete="off" autoCapitalize="none" spellCheck={false} required /></Field>
                  <Field label={t(L, "imapPort")} htmlFor="ob-imap-port"><input id="ob-imap-port" name="imapPort" inputMode="numeric" defaultValue="993" required /></Field>
                  <Field label={t(L, "smtpHost")} htmlFor="ob-smtp-host"><input id="ob-smtp-host" name="smtpHost" autoComplete="off" autoCapitalize="none" spellCheck={false} required /></Field>
                  <Field label={t(L, "smtpPort")} htmlFor="ob-smtp-port"><input id="ob-smtp-port" name="smtpPort" inputMode="numeric" defaultValue="587" required /></Field>
                </>
              )}
              <Field label={t(L, "mailPassword")} htmlFor="ob-mail-secret">
                <input id="ob-mail-secret" name="secret" type="password" autoComplete="off" required aria-describedby="ob-mail-tip" />
              </Field>
              <p id="ob-mail-tip" className="ob-note">
                {needsAppPassword(preset) && <>{t(L, "appPasswordTip")} </>}
                {t(L, "secretNote")}
              </p>
            </>
          ) : (
            <>
              <Field label={t(L, "calMode")} htmlFor="ob-cal-mode">
                <select id="ob-cal-mode" name="mode" value={calMode} onChange={(e) => setCalMode(e.target.value === "caldav" ? "caldav" : "ical")}>
                  <option value="ical">{t(L, "calIcal")}</option>
                  <option value="caldav">{t(L, "calCaldav")}</option>
                </select>
              </Field>
              {calMode === "ical" ? (
                <>
                  <Field label={t(L, "calLabel")} htmlFor="ob-cal-label"><input id="ob-cal-label" name="label" autoComplete="off" required /></Field>
                  <Field label={t(L, "calIcalUrl")} htmlFor="ob-cal-secret">
                    <input id="ob-cal-secret" name="secret" type="password" autoComplete="off" required aria-describedby="ob-cal-tip" />
                  </Field>
                </>
              ) : (
                <>
                  <Field label={t(L, "calUrl")} htmlFor="ob-cal-url"><input id="ob-cal-url" name="url" type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} required /></Field>
                  <Field label={t(L, "calUser")} htmlFor="ob-cal-user"><input id="ob-cal-user" name="username" autoComplete="off" autoCapitalize="none" spellCheck={false} required /></Field>
                  <Field label={t(L, "calPassword")} htmlFor="ob-cal-secret">
                    <input id="ob-cal-secret" name="secret" type="password" autoComplete="off" required aria-describedby="ob-cal-tip" />
                  </Field>
                </>
              )}
              <p id="ob-cal-tip" className="ob-note">{t(L, "secretNote")}</p>
            </>
          )}
          <div className="ob-actions inline">
            <button type="submit" className="ob-btn primary" disabled={busy !== null}>{busy === "save" ? t(L, "saving") : t(L, "save")}</button>
            <button type="button" className="ob-btn" disabled={busy !== null} onClick={() => { setOpen(false); setError(undefined); }}>{t(L, "cancel")}</button>
          </div>
        </form>
      )}
    </article>
  );
}

function Field(props: { label: string; htmlFor: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="ob-field">
      <label htmlFor={props.htmlFor}>{props.label}</label>
      {props.children}
    </div>
  );
}

// -- Telegram ---------------------------------------------------------------

export function TelegramStep(props: {
  client: NokkerClient;
  lang: Lang;
  embedded?: boolean;
  onGenerated?: () => void;
  onNext?: () => void;
}): React.ReactElement {
  const { client, lang: L } = props;
  const Title = props.embedded ? "h2" : "h1";
  const [pairing, setPairing] = useState<TelegramPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!pairing) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pairing]);

  const generate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setPairing(await client.createTelegramPairing());
      setNow(Date.now());
      props.onGenerated?.();
    } catch (err) {
      setError(errorKey(err));
    } finally {
      setBusy(false);
    }
  };

  const left = pairing ? secondsLeft(pairing.expires_at, now) : 0;
  const expired = pairing !== null && left === 0;

  return (
    <section>
      <Title id={props.embedded ? undefined : "ob-title"} className="ob-title">{t(L, "telegramTitle")}</Title>
      {!props.embedded && <p>{t(L, "telegramIntro")}</p>}
      <ErrorLine lang={L} k={error} />
      {!pairing && (
        <div className="ob-actions inline">
          <button type="button" className="ob-btn primary" disabled={busy} onClick={() => void generate()}>{t(L, "telegramGenerate")}</button>
        </div>
      )}
      {pairing && (
        <div className="ob-pair">
          <p className="ob-note">{t(L, "telegramHow")}</p>
          <p className="ob-pair-label">{t(L, "telegramCode")}</p>
          <p className={"ob-code mono" + (expired ? " expired" : "")} aria-label={`${t(L, "telegramCode")} ${pairing.code.split("").join(" ")}`}>{pairing.code}</p>
          <p className="ob-timer" role="timer" aria-live="off">{expired ? t(L, "expired") : t(L, "expiresIn", { time: formatCountdown(left) })}</p>
          <div className="ob-actions inline">
            {!expired && (
              <a className="ob-btn primary" href={pairing.link} target="_blank" rel="noopener noreferrer">{t(L, "telegramOpen")}</a>
            )}
            <button type="button" className="ob-btn" disabled={busy} onClick={() => void generate()}>{t(L, "telegramRegenerate")}</button>
          </div>
        </div>
      )}
      {props.onNext && (
        <div className="ob-actions">
          <button type="button" className={"ob-btn" + (pairing ? " primary" : "")} onClick={props.onNext}>{pairing ? t(L, "next") : t(L, "skip")}</button>
        </div>
      )}
    </section>
  );
}

