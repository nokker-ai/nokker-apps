/**
 * Connecteurs, plusieurs boîtes mail et agendas par profil (core docs/CONNECTORS-MULTI.md, `features.connectors_multi`) :
 * mes boîtes et mes agendas (nom, adresse, « par défaut », tester, renommer, définir par défaut, supprimer, partager),
 * puis « Partagées avec moi » (« partagée par … », retirer). Partager = carte d'approbation forte pour le propriétaire ;
 * le partage en attente reste visible. Un connecteur d'un autre membre n'apparaît jamais ici sans partage. Le secret
 * vit dans son champ, jamais dans l'état React.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  CONNECTOR_LABEL_FORBIDDEN,
  CONNECTOR_LABEL_MAX,
  CONNECTORS_MAX_PER_KIND,
  connectorLevels,
  type ConnectorGrant,
  type ConnectorLevel,
  type ConnectorMember,
  type ConnectorsMultiListing,
  type CreateConnectorRequest,
  type MultiConnector,
  type MultiKind,
  type NokkerClient,
  type OAuthReturn,
  type PickedFile,
} from "@nokker-apps/sdk";
import { takeOAuthReturn } from "../account/links.js";
import { capability } from "../capabilities.js";
import { openPicker } from "./picker.js";
import { errorCode, errorKey, keyForCode } from "../onboarding/errors.js";
import { buildCalendarRequest, buildMailRequest, orderPresets, presetLabel } from "../onboarding/flow.js";
import { t, type Key, type Lang } from "../onboarding/i18n.js";
import "./connectors.css";

const PRESET_EXTRA_LABEL: Record<string, string> = {
  yahoo: "Yahoo", aol: "AOL", posteo: "Posteo", mailbox_org: "mailbox.org", gmx: "GMX", web_de: "WEB.DE", zoho: "Zoho",
  bluewin: "Bluewin (Swisscom)", hostpoint: "Hostpoint", sunrise: "Sunrise", outlook: "Outlook",
};
export const providerLabel = (p: string): string => PRESET_EXTRA_LABEL[p] ?? presetLabel(p);

export function levelKey(kind: MultiKind, level: ConnectorLevel): Key {
  if (kind === "mail") return level === "send" ? "cmLevelMailSend" : "cmLevelMailRead";
  return level === "write" ? "cmLevelCalWrite" : "cmLevelCalRead";
}

export function connectorAddress(c: Pick<MultiConnector, "settings">): string {
  const s = c.settings ?? {};
  // Pas `settings.label` (nom d'un iCal à sa création) : après un renommage, il afficherait l'ancien nom comme une adresse.
  return String(s.address ?? s.email ?? s.username ?? s.url ?? "");
}

/** Mes connecteurs d'une nature, le défaut d'abord puis par nom. */
export function mineOf(list: MultiConnector[], kind: MultiKind): MultiConnector[] {
  return list.filter((c) => c.kind === kind && c.access === "owner").sort((a, b) => Number(b.default) - Number(a.default) || a.label.localeCompare(b.label));
}

export function sharedWithMe(list: MultiConnector[]): MultiConnector[] {
  return list.filter((c) => c.access !== "owner").sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
}

/** Ligne d'un partage : « Sam · lecture seule — en attente d'approbation ». */
export function grantLine(lang: Lang, kind: MultiKind, g: ConnectorGrant): string {
  const who = g.minor ? t(lang, "cmMinor", { name: g.name }) : g.name;
  const base = `${who} · ${t(lang, levelKey(kind, g.level))}`;
  if (g.status === "pending") return `${base} — ${t(lang, "cmGrantPending")}`;
  if (g.pending_level) return `${base} — ${t(lang, "cmGrantUpgrade", { level: t(lang, levelKey(kind, g.pending_level)) })}`;
  return base;
}

/** Nom refusé d'avance (le noyau répond `bad_label`) : vide, trop long, forme d'id, ou « / », « | », « · ». */
export function labelProblem(label: string): Key | null {
  // Comme store.check_label : espaces regroupés, puis longueur, séparateurs et forme d'un id (minuscules, a-z0-9).
  const l = label.split(/\s+/).filter(Boolean).join(" ");
  if (!l) return null;
  return l.length > CONNECTOR_LABEL_MAX || CONNECTOR_LABEL_FORBIDDEN.test(l) || /^(mb|ca|ct|fl|tk|pg)_[a-z0-9]{10}$/.test(l.toLowerCase()) ? "errBadLabel" : null;
}

/** Fournisseurs qui exigent un mot de passe d'application (les autres : celui de l'adresse, leur aide le dit). */
const APP_PASSWORD = new Set(["gmail", "icloud", "yahoo", "aol", "fastmail", "zoho"]);
export const passwordLabelKey = (preset: string, hasHelp: boolean): Key => (hasHelp && !APP_PASSWORD.has(preset) ? "cmPassword" : "mailPassword");

export const KIND_TITLE: Record<MultiKind, Key> = { mail: "cmMail", calendar: "cmCalendar", contacts: "cmContacts", files: "cmFiles", tasks: "cmTasks", pages: "cmPages" };
export const SERVICE_KEY: Record<MultiKind, Key> = { mail: "cmSvcMail", calendar: "cmSvcCalendar", contacts: "cmSvcContacts", files: "cmSvcFiles", tasks: "cmSvcTasks", pages: "cmSvcPages" };
const PROVIDER_NAME: Record<string, string> = { microsoft: "Microsoft", google: "Google" };
export const oauthProviderName = (p: string | null | undefined): string => (p ? (PROVIDER_NAME[p] ?? p) : "");

/** Natures affichées : celles du noyau (`presets.kinds`, CONNECTORS-OAUTH), sinon mail et agenda (068). */
export function shownKinds(data: Pick<ConnectorsMultiListing, "presets">): MultiKind[] {
  const known: MultiKind[] = ["mail", "calendar", "contacts", "files", "tasks", "pages"];
  const k = data.presets.kinds?.filter((x) => known.includes(x));
  return k?.length ? k : ["mail", "calendar"];
}

export interface OAuthAccountGroup {
  id: string;
  provider: string;
  email: string;
  state: "ok" | "reconnect";
  kinds: MultiKind[];
  connectors: MultiConnector[];
}

/** Comptes OAuth reliés, déduits de MES cartes (`oauth_account`), dans l'ordre d'apparition. */
export function oauthAccounts(list: MultiConnector[]): OAuthAccountGroup[] {
  const out = new Map<string, OAuthAccountGroup>();
  for (const c of list) {
    if (c.access !== "owner" || !c.oauth_account) continue;
    const g = out.get(c.oauth_account.id) ?? { id: c.oauth_account.id, provider: c.provider ?? "", email: c.oauth_account.email, state: c.oauth_account.state, kinds: [], connectors: [] };
    if (!g.kinds.includes(c.kind)) g.kinds.push(c.kind);
    g.connectors.push(c);
    if (c.oauth_account.state === "reconnect") g.state = "reconnect";
    out.set(g.id, g);
  }
  return [...out.values()];
}

type OAuthEntry = NonNullable<ConnectorsMultiListing["presets"]["oauth"]>[number];

/** Libellé du bouton « Connecter … » d'une entrée `presets.oauth`. */
/** Google Drive : l'entrée à part de Google (`separate: true`, e7648a6), avec `picker` quand Google est configuré ;
 * à défaut, reconnue à sa forme (google, ["files"]). */
export const isDriveEntry = (e: Pick<OAuthEntry, "provider" | "services" | "picker" | "separate">): boolean =>
  !!e.picker || (e.provider === "google" && (e.separate === true || (e.services.length === 1 && e.services[0] === "files")));

export function connectLabelKey(e: Pick<OAuthEntry, "provider" | "services" | "picker" | "separate">): Key {
  if (isDriveEntry(e)) return "cmConnectDrive";
  return e.provider === "microsoft" ? "cmConnectMicrosoft" : e.provider === "google" ? "cmConnectGoogle" : "cmConnectOther";
}

/** L'entrée de `presets.oauth` d'un compte relié (Drive : celle qui a le sélecteur). */
export function entryOf(data: Pick<ConnectorsMultiListing, "presets">, g: Pick<OAuthAccountGroup, "provider" | "kinds">): OAuthEntry | undefined {
  const entries = (data.presets.oauth ?? []).filter((e) => e.provider === g.provider);
  return entries.find((e) => g.kinds.every((k) => e.services.includes(k))) ?? entries[0];
}

/** Message du retour d'une connexion OAuth (`?oauth=…`). */
export function oauthReturnKey(r: OAuthReturn): Key {
  if (r.status === "done") return "cmOAuthDone";
  const known: Record<string, Key> = { denied: "cmOAuthDenied", expired: "cmOAuthExpired", scope_missing: "cmOAuthScopeMissing", provider_error: "cmOAuthProviderError", already_linked_elsewhere: "cmOAuthElsewhere" };
  return (r.code && known[r.code]) || "cmOAuthFailed";
}

const cmErrorKey = (err: unknown): Key => (errorCode(err) === "not_found" ? "errConnNotFound" : errorKey(err));

export function ConnectorsMulti({ client, lang: L }: { client: NokkerClient; lang: Lang }): React.ReactElement {
  const [data, setData] = useState<ConnectorsMultiListing | null>(null);
  // Retour d'une connexion OAuth, lu une fois au chargement (l'adresse est déjà nettoyée).
  const [oauthBack, setOAuthBack] = useState<OAuthReturn | null>(() => takeOAuthReturn());
  const [loadError, setLoadError] = useState<Key | undefined>();
  const refresh = useCallback(async () => {
    try {
      setData(await client.listConnectorsMulti());
      setLoadError(undefined);
    } catch (err) {
      setLoadError(cmErrorKey(err));
    }
  }, [client]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!data) return <section data-connectors-multi>{loadError ? <p className="ob-error" role="alert">{t(L, loadError)}</p> : null}</section>;
  const shared = sharedWithMe(data.connectors);
  return (
    <section data-connectors-multi>
      <p className="ob-note">{t(L, "cmIntro")}</p>
      {loadError ? <p className="ob-error" role="alert">{t(L, loadError)}</p> : null}
      {oauthBack ? <OAuthReturnBanner r={oauthBack} lang={L} onClose={() => setOAuthBack(null)} /> : null}
      {data.presets.oauth?.length && capability("connectors_oauth") !== false ? <OAuthPanel client={client} lang={L} data={data} fresh={oauthBack?.status === "done" ? oauthBack.account : null} onChanged={refresh} /> : null}
      {shownKinds(data).map((kind) => (
        <KindSection key={kind} kind={kind} client={client} lang={L} data={data} onChanged={refresh} />
      ))}
      {shared.length ? (
        <article className="ob-conn" aria-labelledby="cm-shared" data-cm-shared>
          <h3 id="cm-shared">{t(L, "cmShared")}</h3>
          <ul className="cm-list">
            {shared.map((c) => (
              <SharedItem key={c.id} c={c} client={client} lang={L} onChanged={refresh} />
            ))}
          </ul>
        </article>
      ) : null}
    </section>
  );
}

function KindSection(props: { kind: MultiKind; client: NokkerClient; lang: Lang; data: ConnectorsMultiListing; onChanged: () => Promise<void> }): React.ReactElement {
  const { kind, lang: L, data } = props;
  const mine = mineOf(data.connectors, kind);
  const [adding, setAdding] = useState(false);
  const full = mine.length >= CONNECTORS_MAX_PER_KIND;
  const titleId = `cm-${kind}`;
  return (
    <article className="ob-conn" aria-labelledby={titleId} data-cm-kind={kind}>
      <div className="ob-conn-head">
        <h3 id={titleId}>{t(L, KIND_TITLE[kind])}</h3>
      </div>
      {mine.length ? (
        <ul className="cm-list">
          {mine.map((c) => (
            <MineItem key={c.id} c={c} client={props.client} lang={L} members={data.members} data={data} onChanged={props.onChanged} />
          ))}
        </ul>
      ) : (
        <p className="ob-muted">{t(L, kind === "mail" ? "cmNoneMail" : kind === "calendar" ? "cmNoneCalendar" : "cmNoneKind")}</p>
      )}
      {full ? <p className="ob-muted">{t(L, "cmFull")}</p> : null}
      {kind === "files" || kind === "pages" || ((kind === "contacts" || kind === "tasks") && !(data.presets[kind]?.length)) ? (
        !mine.length ? <p className="ob-note">{t(L, "cmViaOAuth")}</p> : null
      ) : adding ? (
        kind === "mail" || kind === "calendar" ? (
          <AddForm kind={kind} client={props.client} lang={L} data={data} onDone={async (ok) => { setAdding(false); if (ok) await props.onChanged(); }} />
        ) : (
          <PasswordKindForm kind={kind} client={props.client} lang={L} data={data} onDone={async (ok) => { setAdding(false); if (ok) await props.onChanged(); }} />
        )
      ) : !full ? (
        <div className="ob-actions inline">
          <button type="button" className="ob-btn" onClick={() => setAdding(true)}>
            {t(L, kind === "mail" ? "cmAddMail" : kind === "calendar" ? "cmAddCalendar" : kind === "contacts" ? "cmAddContacts" : "cmAddTasks")}
          </button>
        </div>
      ) : null}
    </article>
  );
}

type Panel = null | "rename" | "share" | "delete";

function MineItem(props: { c: MultiConnector; client: NokkerClient; lang: Lang; members: ConnectorMember[]; data: ConnectorsMultiListing; onChanged: () => Promise<void> }): React.ReactElement {
  const { c, client, lang: L, onChanged } = props;
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | undefined>();
  const [info, setInfo] = useState<string | undefined>();
  const act = async (fn: () => Promise<string | undefined>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setInfo(undefined);
    try {
      const msg = await fn();
      if (msg) setInfo(msg);
      await onChanged();
    } catch (err) {
      setError(cmErrorKey(err));
    } finally {
      setBusy(false);
    }
  };
  const address = connectorAddress(c);
  const grants = c.grants ?? [];
  return (
    <li className="cm-item" data-connector={c.id}>
      <div className="cm-head">
        <strong className="cm-label">{c.label}</strong>
        {c.default ? <span className="ob-badge ok" data-default>{t(L, "cmDefault")}</span> : null}
        <span className={"ob-badge " + (c.state === "reconnect" ? "unverified" : c.state)} data-state={c.state}>{t(L, c.state === "ok" ? "stateOk" : c.state === "reconnect" ? "cmStateReconnect" : "stateUnverified")}</span>
        {c.auth === "oauth" && c.provider ? <span className="ob-muted">{t(L, "cmViaProvider", { provider: oauthProviderName(c.provider) })}</span> : null}
      </div>
      {address && address !== c.label ? <p className="cm-address mono">{address}</p> : null}
      {c.state === "reconnect" && c.oauth_account ? (
        <div className="ob-actions inline">
          <p className="ob-note">{t(L, "cmReconnectNote", { provider: oauthProviderName(c.provider) })}</p>
          <ReconnectButton client={client} lang={L} oauthAccount={c.oauth_account.id} small />
        </div>
      ) : null}
      {c.kind === "files" && c.auth === "oauth" && entryOf(props.data, { provider: c.provider ?? "", kinds: ["files"] })?.picker ? (
        <PickedFiles c={c} client={client} lang={L} />
      ) : null}
      {grants.length ? (
        <ul className="cm-grants">
          {grants.map((g) => (
            <li key={g.account_id} data-grant={g.account_id} data-grant-status={g.pending_level ? "upgrade" : g.status}>
              <span>{grantLine(L, c.kind, g)}</span>
              <button type="button" className="ob-btn small" disabled={busy} onClick={() => void act(async () => (await client.revokeConnectorGrant(c.id, g.account_id), undefined))}>
                {t(L, "cmGrantRemove")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div aria-live="polite">
        {error ? <p className="ob-error" role="alert">{t(L, error)}</p> : null}
        {info && !error ? <p className="ob-okline">{info}</p> : null}
      </div>
      {panel === "rename" ? (
        <form
          className="ob-form cm-inline"
          onSubmit={(e) => {
            e.preventDefault();
            const label = String(new FormData(e.currentTarget).get("label") ?? "").trim();
            if (!label) return;
            const bad = labelProblem(label);
            if (bad) return void setError(bad);
            void act(async () => (await client.patchConnector(c.id, { label }), setPanel(null), undefined));
          }}
        >
          <div className="ob-field">
            <label htmlFor={`cm-rn-${c.id}`}>{t(L, "cmLabelField")}</label>
            <input id={`cm-rn-${c.id}`} name="label" defaultValue={c.label} maxLength={CONNECTOR_LABEL_MAX} required autoComplete="off" />
          </div>
          <div className="ob-actions inline">
            <button type="submit" className="ob-btn primary" disabled={busy}>{t(L, "cmRenameSave")}</button>
            <button type="button" className="ob-btn" onClick={() => setPanel(null)}>{t(L, "cancel")}</button>
          </div>
        </form>
      ) : panel === "share" ? (
        <ShareForm c={c} lang={L} members={props.members} busy={busy} onCancel={() => setPanel(null)} onShare={(accountId, level) =>
          void act(async () => {
            const r = await client.grantConnector(c.id, accountId, level);
            const name = props.members.find((m) => m.account_id === accountId)?.name ?? "";
            setPanel(null);
            return r.status === "pending" ? t(L, "cmSharePending") : r.status === "unchanged" ? t(L, "cmShareUnchanged", { name }) : t(L, "cmShareUpdated", { name });
          })
        } />
      ) : panel === "delete" ? (
        <div className="ob-actions inline">
          {grants.length ? <p className="ob-note">{t(L, "cmDeleteShared")}</p> : null}
          {c.oauth_account && c.oauth_account.connectors <= 1 ? <p className="ob-note" data-last-oauth>{t(L, "cmDeleteLastOAuth", { provider: oauthProviderName(c.provider) })}</p> : null}
          <button type="button" className="ob-btn danger" disabled={busy} onClick={() => void act(async () => (await client.deleteConnectorById(c.id), setPanel(null), undefined))}>
            {t(L, "cmDeleteConfirm")}
          </button>
          <button type="button" className="ob-btn" onClick={() => setPanel(null)}>{t(L, "cancel")}</button>
        </div>
      ) : (
        <div className="ob-actions inline cm-actions">
          <button type="button" className="ob-btn small" disabled={busy} onClick={() => void act(async () => {
            const r = await client.testConnectorById(c.id);
            if (r.ok) return t(L, "testOk");
            setError(keyForCode(r.code));
            return undefined;
          })}>
            {t(L, "test")}
          </button>
          <button type="button" className="ob-btn small" disabled={busy} onClick={() => setPanel("rename")}>{t(L, "cmRename")}</button>
          {!c.default ? (
            <button type="button" className="ob-btn small" disabled={busy} onClick={() => void act(async () => (await client.patchConnector(c.id, { default: true }), undefined))}>
              {t(L, "cmMakeDefault")}
            </button>
          ) : null}
          {props.members.length ? (
            <button type="button" className="ob-btn small" disabled={busy} onClick={() => setPanel("share")}>{t(L, "cmShare")}</button>
          ) : null}
          <button type="button" className="ob-btn small danger" disabled={busy} onClick={() => setPanel("delete")}>{t(L, "cmDelete")}</button>
        </div>
      )}
    </li>
  );
}

function ShareForm(props: { c: MultiConnector; lang: Lang; members: ConnectorMember[]; busy: boolean; onCancel: () => void; onShare: (accountId: string, level: ConnectorLevel) => void }): React.ReactElement {
  const { c, lang: L, members } = props;
  const levels = connectorLevels(c.kind);
  return (
    <form
      className="ob-form cm-inline"
      data-cm-share
      onSubmit={(e) => {
        e.preventDefault();
        const d = new FormData(e.currentTarget);
        props.onShare(String(d.get("member")), String(d.get("level")) as ConnectorLevel);
      }}
    >
      <div className="ob-field">
        <label htmlFor={`cm-sh-m-${c.id}`}>{t(L, "cmShareWith")}</label>
        <select id={`cm-sh-m-${c.id}`} name="member" required>
          {members.map((m) => (
            <option key={m.account_id} value={m.account_id}>{m.minor ? t(L, "cmMinor", { name: m.name }) : m.name}</option>
          ))}
        </select>
      </div>
      <div className="ob-field">
        <label htmlFor={`cm-sh-l-${c.id}`}>{t(L, "cmShareLevel")}</label>
        <select id={`cm-sh-l-${c.id}`} name="level" defaultValue={levels[0]}>
          {levels.map((l) => (
            <option key={l} value={l}>{t(L, levelKey(c.kind, l))}</option>
          ))}
        </select>
      </div>
      <div className="ob-actions inline">
        <button type="submit" className="ob-btn primary" disabled={props.busy}>{t(L, "cmShareSend")}</button>
        <button type="button" className="ob-btn" onClick={props.onCancel}>{t(L, "cancel")}</button>
      </div>
    </form>
  );
}

function SharedItem(props: { c: MultiConnector; client: NokkerClient; lang: Lang; onChanged: () => Promise<void> }): React.ReactElement {
  const { c, client, lang: L } = props;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | undefined>();
  const owner = c.owner?.name ?? "";
  const level = c.access === "owner" ? "read" : c.access;
  const leave = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await client.revokeConnectorGrant(c.id, "me");
      await props.onChanged();
    } catch (err) {
      setError(cmErrorKey(err));
      setBusy(false);
    }
  };
  const address = connectorAddress(c);
  return (
    <li className="cm-item" data-connector={c.id} data-shared-by={c.owner?.account_id}>
      <div className="cm-head">
        <strong className="cm-label">{c.label}</strong>
        <span className="ob-badge">{t(L, c.kind === "mail" ? "cmSharedBy" : "cmSharedByCal", { name: owner })}</span>
        <span className="ob-muted">{t(L, levelKey(c.kind, level))}</span>
      </div>
      {address ? <p className="cm-address mono">{address}</p> : null}
      {c.state === "reconnect" ? (
        <p className="ob-note" data-owner-reconnect>{t(L, "cmOwnerReconnect", { name: owner })}</p>
      ) : c.state && c.state !== "ok" ? (
        <p className="ob-note">{t(L, "cmOwnerBroken", { name: owner })}</p>
      ) : null}
      {error ? <p className="ob-error" role="alert">{t(L, error)}</p> : null}
      <div className="ob-actions inline">
        {confirming ? (
          <>
            <button type="button" className="ob-btn danger" disabled={busy} onClick={() => void leave()}>{t(L, "cmLeaveConfirm")}</button>
            <button type="button" className="ob-btn" onClick={() => setConfirming(false)}>{t(L, "cancel")}</button>
          </>
        ) : (
          <button type="button" className="ob-btn" onClick={() => setConfirming(true)}>{t(L, c.kind === "mail" ? "cmLeave" : "cmLeaveCal")}</button>
        )}
      </div>
    </li>
  );
}

/** Corps du `POST /v1/connectors` depuis le formulaire, ou `null` si un champ manque. */
export function buildCreateRequest(kind: "mail" | "calendar", get: (n: string) => string): CreateConnectorRequest | null {
  const label = get("label").trim();
  const base =
    kind === "mail"
      ? buildMailRequest({ preset: get("preset"), address: get("address"), secret: get("secret"), imapHost: get("imapHost"), imapPort: get("imapPort"), smtpHost: get("smtpHost"), smtpPort: get("smtpPort") })
      : get("mode") === "caldav"
        ? buildCalendarRequest({ mode: "caldav", url: get("url"), username: get("username"), secret: get("secret") })
        : buildCalendarRequest({ mode: "ical", label: label || "Agenda", secret: get("secret") });
  if (!base) return null;
  const region = get("region");
  const settings = kind === "mail" && region ? { ...base.settings, region } : base.settings;
  return { kind, ...(label ? { label } : {}), settings, secret: base.secret };
}

function AddForm(props: { kind: "mail" | "calendar"; client: NokkerClient; lang: Lang; data: ConnectorsMultiListing; onDone: (ok: boolean) => Promise<void> }): React.ReactElement {
  const { kind, lang: L, data } = props;
  const presets = orderPresets(data.presets.mail ?? []);
  const soon = data.presets.mail_soon ?? [];
  const [preset, setPreset] = useState(presets[0] ?? "gmail");
  const [calMode, setCalMode] = useState<"ical" | "caldav">("ical");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | undefined>();
  const regions = data.presets.mail_regions?.[preset] ?? [];
  const help = data.presets.mail_help?.[preset]?.[L];
  const idp = `cm-add-${kind}`;
  const save = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const form = e.currentTarget;
    const d = new FormData(form);
    const bad = labelProblem(String(d.get("label") ?? ""));
    if (bad) return void setError(bad);
    const req = buildCreateRequest(kind, (n) => String(d.get(n) ?? ""));
    const secretField = form.elements.namedItem("secret") as HTMLInputElement | null;
    if (secretField) secretField.value = "";
    if (!req) return void setError("errFieldsRequired");
    setBusy(true);
    setError(undefined);
    try {
      await props.client.createConnector(req);
      await props.onDone(true);
    } catch (err) {
      setError(cmErrorKey(err));
      setBusy(false);
    }
  };
  return (
    <form className="ob-form" onSubmit={(e) => void save(e)} autoComplete="off" data-cm-add={kind}>
      <div className="ob-field">
        <label htmlFor={`${idp}-label`}>{t(L, "cmLabel")}</label>
        <input id={`${idp}-label`} name="label" maxLength={CONNECTOR_LABEL_MAX} autoComplete="off" aria-describedby={`${idp}-label-hint`} />
        <p id={`${idp}-label-hint`} className="ob-note">{t(L, "cmLabelHint")}</p>
      </div>
      {kind === "mail" ? (
        <>
          <div className="ob-field">
            <label htmlFor={`${idp}-preset`}>{t(L, "mailPreset")}</label>
            <select id={`${idp}-preset`} name="preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
              {presets.map((p) => (
                <option key={p} value={p}>{providerLabel(p)}</option>
              ))}
              {soon.map((p) => (
                <option key={p} value={p} disabled>{t(L, "cmSoon", { name: providerLabel(p) })}</option>
              ))}
              <option value="custom">{t(L, "presetCustom")}</option>
            </select>
          </div>
          {regions.length ? (
            <div className="ob-field">
              <label htmlFor={`${idp}-region`}>{t(L, "cmRegion")}</label>
              <select id={`${idp}-region`} name="region" defaultValue={regions[0]}>
                {regions.map((r) => (
                  <option key={r} value={r}>{r === "eu" ? t(L, "cmRegionEu") : r === "com" ? t(L, "cmRegionCom") : r}</option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="ob-field">
            <label htmlFor={`${idp}-address`}>{t(L, "mailAddress")}</label>
            <input id={`${idp}-address`} name="address" type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} required />
          </div>
          {preset === "custom" ? (
            <>
              <div className="ob-field"><label htmlFor={`${idp}-ih`}>{t(L, "imapHost")}</label><input id={`${idp}-ih`} name="imapHost" autoComplete="off" autoCapitalize="none" spellCheck={false} required /></div>
              <div className="ob-field"><label htmlFor={`${idp}-ip`}>{t(L, "imapPort")}</label><input id={`${idp}-ip`} name="imapPort" inputMode="numeric" defaultValue="993" required /></div>
              <div className="ob-field"><label htmlFor={`${idp}-sh`}>{t(L, "smtpHost")}</label><input id={`${idp}-sh`} name="smtpHost" autoComplete="off" autoCapitalize="none" spellCheck={false} required /></div>
              <div className="ob-field"><label htmlFor={`${idp}-sp`}>{t(L, "smtpPort")}</label><input id={`${idp}-sp`} name="smtpPort" inputMode="numeric" defaultValue="587" required /></div>
            </>
          ) : null}
          <div className="ob-field">
            <label htmlFor={`${idp}-secret`}>{t(L, passwordLabelKey(preset, !!help))}</label>
            <input id={`${idp}-secret`} name="secret" type="password" autoComplete="off" required aria-describedby={`${idp}-tip`} />
          </div>
          <p id={`${idp}-tip`} className="ob-note" data-cm-help={help ? preset : undefined}>
            {help ? <>{help} </> : null}
            {t(L, "secretNote")}
          </p>
        </>
      ) : (
        <>
          <div className="ob-field">
            <label htmlFor={`${idp}-mode`}>{t(L, "calMode")}</label>
            <select id={`${idp}-mode`} name="mode" value={calMode} onChange={(e) => setCalMode(e.target.value === "caldav" ? "caldav" : "ical")}>
              <option value="ical">{t(L, "calIcal")}</option>
              <option value="caldav">{t(L, "calCaldav")}</option>
            </select>
          </div>
          {calMode === "ical" ? (
            <div className="ob-field">
              <label htmlFor={`${idp}-secret`}>{t(L, "calIcalUrl")}</label>
              <input id={`${idp}-secret`} name="secret" type="password" autoComplete="off" required aria-describedby={`${idp}-tip`} />
            </div>
          ) : (
            <>
              <div className="ob-field"><label htmlFor={`${idp}-url`}>{t(L, "calUrl")}</label><input id={`${idp}-url`} name="url" type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} required /></div>
              <div className="ob-field"><label htmlFor={`${idp}-user`}>{t(L, "calUser")}</label><input id={`${idp}-user`} name="username" autoComplete="off" autoCapitalize="none" spellCheck={false} required /></div>
              <div className="ob-field">
                <label htmlFor={`${idp}-secret`}>{t(L, "calPassword")}</label>
                <input id={`${idp}-secret`} name="secret" type="password" autoComplete="off" required aria-describedby={`${idp}-tip`} />
              </div>
            </>
          )}
          <p id={`${idp}-tip`} className="ob-note">{t(L, "secretNote")}</p>
        </>
      )}
      {error ? <p className="ob-error" role="alert">{t(L, error)}</p> : null}
      <div className="ob-actions inline">
        <button type="submit" className="ob-btn primary" disabled={busy}>{busy ? t(L, "saving") : t(L, "save")}</button>
        <button type="button" className="ob-btn" disabled={busy} onClick={() => void props.onDone(false)}>{t(L, "cancel")}</button>
      </div>
    </form>
  );
}

// -- OAuth (CONNECTORS-OAUTH) ---------------------------------------------

function OAuthReturnBanner({ r, lang: L, onClose }: { r: OAuthReturn; lang: Lang; onClose: () => void }): React.ReactElement {
  const provider = oauthProviderName(r.provider);
  const missing = r.missing.map((k) => t(L, SERVICE_KEY[k])).join(", ");
  return (
    <div className={r.status === "done" ? "ob-okline cm-banner" : "ob-error cm-banner"} role={r.status === "done" ? "status" : "alert"} data-oauth-return={r.status} data-oauth-code={r.code ?? undefined}>
      <p>{t(L, oauthReturnKey(r), { provider: provider || t(L, "cmProviderGeneric") })}</p>
      {r.status === "done" && missing ? <p data-oauth-missing>{t(L, "cmOAuthMissing", { services: missing })}</p> : null}
      <button type="button" className="ob-btn small" onClick={onClose}>{t(L, "cmBannerClose")}</button>
    </div>
  );
}

/** Suit l'URL du fournisseur dans le même onglet (aucun jeton côté navigateur). */
async function follow(p: Promise<{ url: string }>): Promise<void> {
  const { url } = await p;
  window.location.assign(url);
}

function ReconnectButton(props: { client: NokkerClient; lang: Lang; oauthAccount: string; small?: boolean }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | undefined>();
  return (
    <>
      <button type="button" className={"ob-btn primary" + (props.small ? " small" : "")} disabled={busy} data-reconnect={props.oauthAccount}
        onClick={() => {
          setBusy(true);
          setError(undefined);
          follow(props.client.reconnectOAuth(props.oauthAccount)).catch((err) => {
            setError(cmErrorKey(err));
            setBusy(false);
          });
        }}>
        {busy ? t(props.lang, "cmRedirecting") : t(props.lang, "cmReconnect")}
      </button>
      {error ? <p className="ob-error" role="alert">{t(props.lang, error)}</p> : null}
    </>
  );
}

function OAuthPanel(props: { client: NokkerClient; lang: Lang; data: ConnectorsMultiListing; fresh: string | null; onChanged: () => Promise<void> }): React.ReactElement {
  const { client, lang: L, data } = props;
  const accounts = oauthAccounts(data.connectors);
  const entries = data.presets.oauth ?? [];
  return (
    <article className="ob-conn" aria-labelledby="cm-oauth" data-cm-oauth>
      <h3 id="cm-oauth">{t(L, "cmOAuthTitle")}</h3>
      <p className="ob-note">{t(L, "cmOAuthIntro")}</p>
      {accounts.length ? (
        <ul className="cm-list">
          {accounts.map((g) => (
            <OAuthAccountItem key={g.id} g={g} client={client} lang={L} data={data} fresh={props.fresh === g.id} onChanged={props.onChanged} />
          ))}
        </ul>
      ) : null}
      <div className="cm-connect">
        {entries.map((e, i) => (
          <ConnectButton key={`${e.provider}-${i}`} entry={e} client={client} lang={L} />
        ))}
      </div>
    </article>
  );
}

function OAuthAccountItem(props: { g: OAuthAccountGroup; client: NokkerClient; lang: Lang; data: ConnectorsMultiListing; fresh: boolean; onChanged: () => Promise<void> }): React.ReactElement {
  const { g, client, lang: L } = props;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | undefined>();
  const entry = entryOf(props.data, g);
  const more = (entry?.services ?? []).filter((k) => !g.kinds.includes(k));
  const services = g.kinds.map((k) => t(L, SERVICE_KEY[k])).join(", ");
  return (
    <li className={"cm-item" + (props.fresh ? " cm-fresh" : "")} data-oauth-account={g.id} data-oauth-fresh={props.fresh ? "" : undefined}>
      <div className="cm-head">
        <strong className="cm-label">{entry?.picker ? t(L, "cmDriveName") : t(L, "cmAccountOf", { provider: oauthProviderName(g.provider) })}</strong>
        <span className={"ob-badge " + (g.state === "ok" ? "ok" : "unverified")}>{t(L, g.state === "ok" ? "stateOk" : "cmStateReconnect")}</span>
      </div>
      <p className="cm-address mono">{g.email}</p>
      <p className="ob-muted">{t(L, "cmOAuthServices", { services })}</p>
      {error ? <p className="ob-error" role="alert">{t(L, error)}</p> : null}
      {confirming ? (
        <div className="ob-actions inline">
          <p className="ob-note">{t(L, "cmDisconnectNote", { n: String(g.connectors.length) })}</p>
          <button type="button" className="ob-btn danger" disabled={busy} onClick={() => {
            setBusy(true);
            client.deleteOAuthAccount(g.id).then(() => props.onChanged(), (err) => { setError(cmErrorKey(err)); setBusy(false); });
          }}>{t(L, "cmDisconnectConfirm")}</button>
          <button type="button" className="ob-btn" onClick={() => setConfirming(false)}>{t(L, "cancel")}</button>
        </div>
      ) : (
        <div className="ob-actions inline cm-actions">
          {g.state === "reconnect" ? <ReconnectButton client={client} lang={L} oauthAccount={g.id} small /> : null}
          {more.length && g.state === "ok" && entry && !entry.picker ? <ConnectButton entry={{ ...entry, services: more }} client={client} lang={L} oauthAccount={g.id} /> : null}
          <button type="button" className="ob-btn small danger" onClick={() => setConfirming(true)}>{t(L, "cmDisconnect")}</button>
        </div>
      )}
    </li>
  );
}

/** « Connecter un compte … » : choix des services (tous cochés), puis l'écran du fournisseur. `oauthAccount` : ajouter des
 * services à un compte déjà relié (consentement incrémental). */
function ConnectButton(props: { entry: OAuthEntry; client: NokkerClient; lang: Lang; oauthAccount?: string }): React.ReactElement {
  const { entry, client, lang: L } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | undefined>();
  const go = (services: MultiKind[]): void => {
    if (!services.length) return void setError("cmPickService");
    setBusy(true);
    setError(undefined);
    follow(client.startOAuth(entry.provider, { services, ...(props.oauthAccount ? { oauth_account: props.oauthAccount } : {}) })).catch((err) => {
      setError(cmErrorKey(err));
      setBusy(false);
    });
  };
  const label = props.oauthAccount ? t(L, "cmAddService") : t(L, connectLabelKey(entry), { provider: oauthProviderName(entry.provider) });
  if (!entry.enabled)
    return (
      <button type="button" className="ob-btn" disabled data-connect={entry.provider}>
        {t(L, "cmConnectSoon", { label })}
      </button>
    );
  // Un seul service (Google Drive) : pas de choix à faire.
  if (entry.services.length === 1 && !props.oauthAccount)
    return (
      <div className="cm-connect-one">
        <button type="button" className="ob-btn" disabled={busy} data-connect={isDriveEntry(entry) ? "google-drive" : entry.provider} onClick={() => go(entry.services)}>
          {busy ? t(L, "cmRedirecting") : label}
        </button>
        {error ? <p className="ob-error" role="alert">{t(L, error)}</p> : null}
      </div>
    );
  return (
    <div className="cm-connect-one">
      {open ? (
        <form className="ob-form cm-inline" data-connect-form={entry.provider} onSubmit={(e) => {
          e.preventDefault();
          go(new FormData(e.currentTarget).getAll("service").map(String) as MultiKind[]);
        }}>
          <fieldset className="cm-services">
            <legend>{label}</legend>
            {entry.services.map((k) => (
              <label key={k} className="acc-radio">
                <input type="checkbox" name="service" value={k} defaultChecked />
                <span>{t(L, SERVICE_KEY[k])}</span>
              </label>
            ))}
          </fieldset>
          <p className="ob-note">{t(L, "cmConnectNote", { provider: oauthProviderName(entry.provider) })}</p>
          {error ? <p className="ob-error" role="alert">{t(L, error)}</p> : null}
          <div className="ob-actions inline">
            <button type="submit" className="ob-btn primary" disabled={busy}>{busy ? t(L, "cmRedirecting") : t(L, "cmContinue", { provider: oauthProviderName(entry.provider) })}</button>
            <button type="button" className="ob-btn" onClick={() => setOpen(false)}>{t(L, "cancel")}</button>
          </div>
        </form>
      ) : (
        <button type="button" className={props.oauthAccount ? "ob-btn small" : "ob-btn"} data-connect={entry.provider} onClick={() => setOpen(true)}>{label}</button>
      )}
    </div>
  );
}

/** Google Drive (`drive.file`) : les fichiers donnés à Nokker par le sélecteur Google ; retirer en enlève l'accès. */
function PickedFiles(props: { c: MultiConnector; client: NokkerClient; lang: Lang }): React.ReactElement {
  const { c, client, lang: L } = props;
  const [files, setFiles] = useState<PickedFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | undefined>();
  useEffect(() => {
    let live = true;
    client.listPickedFiles(c.id).then((r) => live && setFiles(r.files), (err) => live && setError(cmErrorKey(err)));
    return () => {
      live = false;
    };
  }, [client, c.id]);
  const pick = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      // Le jeton du sélecteur ne sort pas de cet appel : ni état React, ni stockage.
      const ids = await openPicker(await client.pickerGrant(c.id), L, { title: t(L, "cmMockPickerTitle"), select: t(L, "cmMockPickerSelect"), cancel: t(L, "cancel") });
      if (ids.length) setFiles((await client.addPickedFiles(c.id, ids)).files);
    } catch (err) {
      setError(err instanceof Error && err.message === "picker_unavailable" ? "cmPickerUnavailable" : cmErrorKey(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cm-picked" data-picked-files>
      <p className="ob-note">{t(L, "cmDriveNote")}</p>
      {files?.length ? (
        <ul className="cm-grants">
          {files.map((f) => (
            <li key={f.id} data-picked={f.id}>
              <span>{f.name}</span>
              <button type="button" className="ob-btn small" disabled={busy} onClick={() => {
                client.removePickedFile(c.id, f.id).then(() => setFiles((l) => (l ?? []).filter((x) => x.id !== f.id)), (err) => setError(cmErrorKey(err)));
              }}>{t(L, "cmGrantRemove")}</button>
            </li>
          ))}
        </ul>
      ) : files ? <p className="ob-muted">{t(L, "cmDriveNone")}</p> : null}
      {error ? <p className="ob-error" role="alert">{t(L, error)}</p> : null}
      <div className="ob-actions inline cm-actions">
        <button type="button" className="ob-btn small" disabled={busy} data-pick-files onClick={() => void pick()}>{t(L, "cmPickFiles")}</button>
      </div>
    </div>
  );
}

/** Corps du `POST /v1/connectors` pour des contacts ou des tâches sans OAuth (CardDAV, iCloud), ou `null`. */
export function buildPasswordKindRequest(kind: "contacts" | "tasks", get: (n: string) => string): CreateConnectorRequest | null {
  const mode = get("mode");
  const username = get("username").trim();
  const secret = get("secret").trim();
  const url = get("url").trim();
  const label = get("label").trim();
  if (!mode || !username || !secret || (mode === "carddav" && !/^https:\/\//.test(url))) return null;
  return { kind, ...(label ? { label } : {}), settings: { mode, username, ...(mode === "carddav" ? { url } : {}) }, secret };
}

function PasswordKindForm(props: { kind: MultiKind; client: NokkerClient; lang: Lang; data: ConnectorsMultiListing; onDone: (ok: boolean) => Promise<void> }): React.ReactElement {
  const kind = props.kind as "contacts" | "tasks";
  const { lang: L, data } = props;
  const modes = data.presets[kind] ?? [];
  const [mode, setMode] = useState(modes[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | undefined>();
  const help = data.presets.help?.[kind]?.[mode]?.[L];
  const idp = `cm-add-${kind}`;
  return (
    <form className="ob-form" autoComplete="off" data-cm-add={kind} onSubmit={(e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const d = new FormData(form);
      const bad = labelProblem(String(d.get("label") ?? ""));
      if (bad) return void setError(bad);
      const req = buildPasswordKindRequest(kind, (n) => String(d.get(n) ?? ""));
      const secretField = form.elements.namedItem("secret") as HTMLInputElement | null;
      if (secretField) secretField.value = "";
      if (!req) return void setError("errFieldsRequired");
      setBusy(true);
      setError(undefined);
      props.client.createConnector(req).then(() => props.onDone(true), (err) => { setError(cmErrorKey(err)); setBusy(false); });
    }}>
      <div className="ob-field">
        <label htmlFor={`${idp}-label`}>{t(L, "cmLabel")}</label>
        <input id={`${idp}-label`} name="label" maxLength={CONNECTOR_LABEL_MAX} autoComplete="off" />
      </div>
      <div className="ob-field">
        <label htmlFor={`${idp}-mode`}>{t(L, "mailPreset")}</label>
        <select id={`${idp}-mode`} name="mode" value={mode} onChange={(e) => setMode(e.target.value)}>
          {modes.map((m) => (
            <option key={m} value={m}>{m === "icloud" ? "iCloud" : m === "carddav" ? "CardDAV" : m}</option>
          ))}
        </select>
      </div>
      {mode === "carddav" ? (
        <div className="ob-field"><label htmlFor={`${idp}-url`}>{t(L, "cmCardDavUrl")}</label><input id={`${idp}-url`} name="url" type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} required /></div>
      ) : null}
      <div className="ob-field"><label htmlFor={`${idp}-user`}>{t(L, "calUser")}</label><input id={`${idp}-user`} name="username" autoComplete="off" autoCapitalize="none" spellCheck={false} required /></div>
      <div className="ob-field">
        <label htmlFor={`${idp}-secret`}>{t(L, mode === "icloud" ? "mailPassword" : "cmPassword")}</label>
        <input id={`${idp}-secret`} name="secret" type="password" autoComplete="off" required aria-describedby={`${idp}-tip`} />
      </div>
      <p id={`${idp}-tip`} className="ob-note">{help ? <>{help} </> : null}{t(L, "secretNote")}</p>
      {error ? <p className="ob-error" role="alert">{t(L, error)}</p> : null}
      <div className="ob-actions inline">
        <button type="submit" className="ob-btn primary" disabled={busy}>{busy ? t(L, "saving") : t(L, "save")}</button>
        <button type="button" className="ob-btn" disabled={busy} onClick={() => void props.onDone(false)}>{t(L, "cancel")}</button>
      </div>
    </form>
  );
}
