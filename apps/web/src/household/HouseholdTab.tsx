/**
 * Onglet « Foyer » (X23, LOKKAL §7.29.6) : offre Famille ou Large partagée par 6 personnes au plus. Visible quand
 * `GET /v1/household/invitations/received` répond (drapeau `household` de nokker.ai). Le payeur règle les plafonds, les
 * invitations, les profils mineurs (attestation affichée en entier) et décide des cartes d'un mineur avec SA passkey ;
 * un membre voit sa ligne. Jamais de contenu de conversation : des tours, des noms, des états.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  NokkerApiError,
  type Household,
  type HouseholdApproval,
  type HouseholdConsentText,
  type HouseholdMember,
  type HouseholdNote,
  type HouseholdProfile,
  type HouseholdQuarantined,
  type NokkerClient,
  type ReceivedHouseholdInvitation,
} from "@nokker-apps/sdk";
import { fmtReset, planLabel } from "../account/usage.js";
import {
  POLICY_CONNECTORS,
  PROFILE_LABEL,
  PROFILE_SHORT,
  agentsFromText,
  apiCode,
  capText,
  h,
  householdError,
  invitableProfiles,
  isMinor,
  noteName,
  parseCap,
  quotaRows,
  seatsLeft,
  type HKey,
  type Lang,
} from "./model.js";

type Toast = (text: string, tone?: "ok" | "error") => void;
type Sign = (
  challenge: string,
  decision: "approve" | "reject",
) => Promise<{
  device_id: string;
  signature?: string;
  webauthn?: {
    client_data_json: string;
    authenticator_data: string;
    signature: string;
  };
}>;

const fmtDate = (lang: Lang, iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat(lang, {
        dateStyle: "medium",
        timeZone: "Europe/Zurich",
      }).format(d);
};

export function HouseholdTab({
  client,
  lang,
  toast,
  signDecision,
  onReceived,
}: {
  client: NokkerClient;
  lang: Lang;
  toast: Toast;
  signDecision: Sign | null;
  onReceived?: (n: number) => void;
}): React.ReactElement {
  const [hh, setHh] = useState<Household | null | undefined>(undefined);
  const [received, setReceived] = useState<ReceivedHouseholdInvitation[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const fail = useCallback((e: unknown) => toast(householdError(lang, e), "error"), [lang, toast]);

  const load = useCallback(async () => {
    try {
      setHh(await client.getHousehold());
      setReceived([]);
      onReceived?.(0);
      setErr(null);
    } catch (e) {
      if (!(e instanceof NokkerApiError && e.status === 404)) return setErr(householdError(lang, e));
      setHh(null);
      try {
        const r = await client.listReceivedHouseholdInvitations();
        setReceived(r.invitations);
        onReceived?.(r.invitations.length);
        setErr(null);
      } catch (e2) {
        setErr(householdError(lang, e2));
      }
    }
  }, [client, lang, onReceived]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="hh-tab" aria-labelledby="hh-title">
      <h2 id="hh-title">{hh ? hh.name : h(lang, "title")}</h2>
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}
      {hh === undefined && !err ? <p className="fine">{h(lang, "loading")}</p> : null}
      {hh === null ? <NoHousehold client={client} lang={lang} toast={toast} fail={fail} received={received} onDone={load} /> : null}
      {hh ? <HouseholdView hh={hh} client={client} lang={lang} toast={toast} fail={fail} signDecision={signDecision} reload={load} /> : null}
    </section>
  );
}

function NoHousehold({
  client,
  lang,
  toast,
  fail,
  received,
  onDone,
}: {
  client: NokkerClient;
  lang: Lang;
  toast: Toast;
  fail: (e: unknown) => void;
  received: ReceivedHouseholdInvitation[];
  onDone: () => Promise<void>;
}): React.ReactElement {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await f();
      await onDone();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="fine">{h(lang, "noneLead")}</p>
      {received.length ? (
        <div className="machine-section">
          <h3>{h(lang, "received")}</h3>
          <ul className="hh-list">
            {received.map((iv) => (
              <li key={iv.id} className="hh-row">
                <span>
                  {h(lang, "receivedLine", {
                    name: iv.household.name,
                    profile: PROFILE_SHORT[lang][iv.profile],
                  })}
                </span>
                <span className="team-row-actions">
                  <button
                    type="button"
                    className="btn btn-brass"
                    disabled={busy}
                    onClick={() => void run(async () => (await client.answerHouseholdInvitation(iv.id, true), toast(h(lang, "joined", { name: iv.household.name }), "ok")))}
                  >
                    {h(lang, "accept")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => void run(async () => (await client.answerHouseholdInvitation(iv.id, false), toast(h(lang, "declined"), "ok")))}
                  >
                    {h(lang, "decline")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <form
        className="machine-section team-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const v = await client.createHousehold(name.trim() || undefined);
            toast(h(lang, "created", { name: v.name }), "ok");
          });
        }}
      >
        <label className="fine" htmlFor="hh-name">
          {h(lang, "createName")}
        </label>
        <input id="hh-name" value={name} maxLength={80} placeholder={h(lang, "createPh")} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn btn-brass" disabled={busy}>
          {h(lang, "create")}
        </button>
      </form>
    </>
  );
}

function HouseholdView({
  hh,
  client,
  lang,
  toast,
  fail,
  signDecision,
  reload,
}: {
  hh: Household;
  client: NokkerClient;
  lang: Lang;
  toast: Toast;
  fail: (e: unknown) => void;
  signDecision: Sign | null;
  reload: () => Promise<void>;
}): React.ReactElement {
  const payer = hh.you.payer;
  const me = hh.members.find((m) => m.you);
  const minors = hh.members.filter((m) => isMinor(m.profile));
  return (
    <>
      <p className="fine">
        {h(lang, "planLine", {
          plan: planLabel(hh.plan),
          size: hh.size,
          max: hh.max_members,
        })}
      </p>
      <Quota hh={hh} lang={lang} />
      {payer ? (
        <>
          <Members hh={hh} client={client} lang={lang} toast={toast} fail={fail} reload={reload} />
          <Invitations hh={hh} client={client} lang={lang} toast={toast} fail={fail} reload={reload} />
          {hh.minors?.enabled || minors.length ? <Approvals client={client} lang={lang} toast={toast} fail={fail} signDecision={signDecision} /> : null}
          {(hh.minors?.enabled || minors.length) && hh.policy ? <Policy hh={hh} client={client} lang={lang} toast={toast} fail={fail} reload={reload} /> : null}
        </>
      ) : me ? (
        <MyLine me={me} hh={hh} client={client} lang={lang} toast={toast} fail={fail} reload={reload} />
      ) : null}
      <Notes client={client} lang={lang} toast={toast} fail={fail} payer={payer} who={(a) => hh.members.find((m) => m.account_id === a)?.email ?? null} />
      <p className="fine">{h(lang, "privacy")}</p>
      {payer ? <DeleteHousehold hh={hh} client={client} lang={lang} toast={toast} fail={fail} reload={reload} /> : null}
    </>
  );
}

function Quota({ hh, lang }: { hh: Household; lang: Lang }): React.ReactElement {
  return (
    <div className="machine-section" aria-label={h(lang, "quota")}>
      <h3>{h(lang, "quota")}</h3>
      {quotaRows(hh).map((r) => {
        const label = h(lang, r.key === "today" ? "today" : "week");
        const at = fmtReset(lang, r.resets_at, r.key === "week");
        return (
          <div key={r.key} className="acc-usage" data-level={r.level} data-usage={`household-${r.key}`}>
            <div className="acc-usage-head">
              <span>{label}</span>
              <span className="acc-usage-n">{r.cap === null ? h(lang, "usedNoCap", { used: r.used }) : h(lang, "usedOf", { used: r.used, cap: r.cap })}</span>
            </div>
            {r.pct !== null ? (
              <div className="acc-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.pct} aria-label={label}>
                <div className="acc-bar-fill" style={{ width: `${r.pct}%` }} />
              </div>
            ) : null}
            {at ? (
              <span className="fine">
                {h(lang, r.key === "today" ? "resetsDay" : "resetsWeek", {
                  at,
                })}
              </span>
            ) : null}
          </div>
        );
      })}
      {hh.mode === "soft" ? <p className="fine">{h(lang, "softNote")}</p> : null}
    </div>
  );
}

/** Attestation du représentant légal : le texte du noyau EN ENTIER, une case ; renvoie `{version, lang}` lus. */
function Attestation({
  client,
  lang,
  checked,
  onChange,
}: {
  client: NokkerClient;
  lang: Lang;
  checked: boolean;
  onChange: (v: boolean, text: HouseholdConsentText | null) => void;
}): React.ReactElement {
  const [text, setText] = useState<HouseholdConsentText | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client.getHouseholdConsentText(lang).then(
      (t) => live && setText(t),
      (e) => live && setErr(householdError(lang, e)),
    );
    return () => {
      live = false;
    };
  }, [client, lang]);
  return (
    <div className="hh-attest">
      <h4>{h(lang, "attestTitle")}</h4>
      {err ? <p className="error">{err}</p> : null}
      {text ? <div className="hh-attest-text">{text.text}</div> : <p className="fine">{h(lang, "loading")}</p>}
      <label className="fine team-check">
        <input type="checkbox" checked={checked} disabled={!text} onChange={(e) => onChange(e.target.checked, text)} /> {h(lang, "attestCheck")}
      </label>
    </div>
  );
}
const attestationOf = (t: HouseholdConsentText) => ({
  version: t.version,
  lang: t.lang,
  legal_guardian: true as const,
});

function Members({
  hh,
  client,
  lang,
  toast,
  fail,
  reload,
}: {
  hh: Household;
  client: NokkerClient;
  lang: Lang;
  toast: Toast;
  fail: (e: unknown) => void;
  reload: () => Promise<void>;
}): React.ReactElement {
  return (
    <div className="machine-section">
      <h3>{h(lang, "members")}</h3>
      <ul className="hh-members">
        {hh.members.map((m) => (
          <MemberRow key={m.account_id} m={m} client={client} lang={lang} toast={toast} fail={fail} reload={reload} minorsOpen={!!hh.minors?.enabled} />
        ))}
      </ul>
    </div>
  );
}

function MemberRow({
  m,
  client,
  lang,
  toast,
  fail,
  reload,
  minorsOpen,
}: {
  m: HouseholdMember;
  client: NokkerClient;
  lang: Lang;
  toast: Toast;
  fail: (e: unknown) => void;
  reload: () => Promise<void>;
  minorsOpen: boolean;
}): React.ReactElement {
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"remove" | "consent" | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [attest, setAttest] = useState<HouseholdConsentText | null>(null);
  const parsed = parseCap(cap);
  const run = async (f: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusy(true);
    try {
      await f();
      toast(ok, "ok");
      setConfirm(null);
      setRenewing(false);
      setCap("");
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const minor = isMinor(m.profile);
  return (
    <li className={`hh-member ${m.status === "suspended" ? "suspended" : ""}`}>
      <div className="hh-member-head">
        <strong className="team-member-mail">{m.email}</strong>
        <span className="fine">
          {PROFILE_LABEL[lang][m.profile]}
          {m.payer ? ` · ${h(lang, "payer")}` : ""}
          {m.you ? ` · ${h(lang, "you")}` : ""}
          {m.status === "suspended" ? ` · ${h(lang, "suspended")}` : ""}
        </span>
      </div>
      <dl className="hh-member-stats">
        <dt>{h(lang, "colTurns")}</dt>
        <dd>
          {m.turns.today} · {m.turns.week}
        </dd>
        <dt>{h(lang, "colCap")}</dt>
        <dd>{capText(lang, m)}</dd>
      </dl>
      <form
        className="team-inline-form hh-cap-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (parsed === null || parsed === "invalid") return;
          void run(() => client.setHouseholdCap(m.account_id, parsed), h(lang, "capSaved", { email: m.email, cap: parsed }));
        }}
      >
        <label className="fine" htmlFor={`cap-${m.account_id}`}>
          {h(lang, "capChange")}
        </label>
        <input
          id={`cap-${m.account_id}`}
          inputMode="numeric"
          value={cap}
          placeholder={m.cap.turns_per_day === null ? "—" : String(m.cap.turns_per_day)}
          onChange={(e) => setCap(e.target.value)}
          aria-invalid={parsed === "invalid"}
        />
        <button type="submit" className="btn" disabled={busy || parsed === null || parsed === "invalid"}>
          {h(lang, "capSave")}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy || m.cap.source === "none"}
          onClick={() =>
            void run(
              () => client.setHouseholdCap(m.account_id, null),
              h(lang, "capSaved", {
                email: m.email,
                cap: h(lang, "capNoneValue"),
              }),
            )
          }
        >
          {h(lang, "capUnlimited")}
        </button>
        {!m.payer ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || m.cap.source === "default"}
            onClick={() =>
              void run(
                () => client.resetHouseholdCap(m.account_id),
                h(lang, "capSaved", {
                  email: m.email,
                  cap: h(lang, "capDefault"),
                }),
              )
            }
          >
            {h(lang, "capReset")}
          </button>
        ) : null}
        {parsed === "invalid" ? <span className="fine">{h(lang, "capInvalid")}</span> : null}
      </form>
      {minor ? (
        <div className="hh-minor">
          <span className="fine">{h(lang, "minorTools")}</span>
          <div className="team-row-actions">
            {m.status === "active" ? (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm("consent")}>
                {h(lang, "revokeConsent")}
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost" disabled={busy || !minorsOpen} onClick={() => setRenewing((v) => !v)}>
              {h(lang, "renew")}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void run(() => client.setHouseholdProfile(m.account_id, "adult"), h(lang, "madeAdult", { email: m.email }))}>
              {h(lang, "makeAdult")}
            </button>
          </div>
          {renewing ? (
            <>
              <Attestation client={client} lang={lang} checked={!!attest} onChange={(v, t) => setAttest(v ? t : null)} />
              <button
                type="button"
                className="btn btn-brass"
                disabled={busy || !attest}
                onClick={() => attest && void run(() => client.renewHouseholdConsent(m.account_id, attestationOf(attest)), h(lang, "renewed"))}
              >
                {h(lang, "renew")}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {confirm ? (
        <p className="hh-confirm" role="alert">
          {confirm === "remove" ? h(lang, "removeConfirm", { email: m.email }) : h(lang, "revokeConsentConfirm", { email: m.email })}{" "}
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() =>
              void (confirm === "remove"
                ? run(() => client.removeHouseholdMember(m.account_id), h(lang, "removed", { email: m.email }))
                : run(() => client.revokeHouseholdConsent(m.account_id), h(lang, "consentRevoked")))
            }
          >
            {h(lang, "yes")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirm(null)}>
            {h(lang, "cancel")}
          </button>
        </p>
      ) : !m.payer ? (
        <button type="button" className="btn btn-ghost hh-remove" disabled={busy} onClick={() => setConfirm("remove")}>
          {h(lang, "remove")}
        </button>
      ) : null}
    </li>
  );
}

function Invitations({
  hh,
  client,
  lang,
  toast,
  fail,
  reload,
}: {
  hh: Household;
  client: NokkerClient;
  lang: Lang;
  toast: Toast;
  fail: (e: unknown) => void;
  reload: () => Promise<void>;
}): React.ReactElement {
  const [email, setEmail] = useState("");
  const [profile, setProfile] = useState<HouseholdProfile>("adult");
  const [attest, setAttest] = useState<HouseholdConsentText | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const pending = (hh.invitations ?? []).filter((iv) => iv.state === "pending");
  const left = seatsLeft(hh);
  const minor = isMinor(profile);
  const send = async (): Promise<void> => {
    setMsg(null);
    if (minor && !attest) return setMsg(h(lang, "attestNeeded"));
    setBusy(true);
    try {
      await client.inviteToHousehold(email.trim(), profile, minor && attest ? attestationOf(attest) : undefined);
      toast(h(lang, "invited", { email: email.trim() }), "ok");
      setEmail("");
      setProfile("adult");
      setAttest(null);
      await reload();
    } catch (e) {
      if (apiCode(e) === "attestation_stale") setAttest(null);
      setMsg(householdError(lang, e));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string): Promise<void> => {
    try {
      await client.revokeHouseholdInvitation(id);
      toast(h(lang, "revoked"), "ok");
      await reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <div className="machine-section">
      {pending.length ? (
        <>
          <h3>{h(lang, "pending")}</h3>
          <ul className="hh-list">
            {pending.map((iv) => (
              <li key={iv.id} className="hh-row">
                <span>
                  {iv.email}{" "}
                  <span className="fine">
                    · {PROFILE_LABEL[lang][iv.profile]} · {h(lang, "expires", { date: fmtDate(lang, iv.expires_at) })}
                  </span>
                </span>
                <button type="button" className="btn btn-ghost" onClick={() => void revoke(iv.id)}>
                  {h(lang, "revoke")}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h3>{h(lang, "invite")}</h3>
      {left === 0 ? (
        <p className="fine">{h(lang, "full")}</p>
      ) : (
        <form
          className="hh-invite"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label className="fine" htmlFor="hh-inv-email">
            {h(lang, "inviteEmail")}
          </label>
          <input id="hh-inv-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={200} />
          <label className="fine" htmlFor="hh-inv-profile">
            {h(lang, "inviteProfile")}
          </label>
          <select
            id="hh-inv-profile"
            value={profile}
            onChange={(e) => {
              setProfile(e.target.value as HouseholdProfile);
              setAttest(null);
            }}
          >
            {invitableProfiles(hh).map((p) => (
              <option key={p} value={p}>
                {PROFILE_LABEL[lang][p]}
              </option>
            ))}
          </select>
          {minor ? <Attestation client={client} lang={lang} checked={!!attest} onChange={(v, t) => setAttest(v ? t : null)} /> : null}
          <button type="submit" className="btn btn-brass" disabled={busy || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) || (minor && !attest)}>
            {h(lang, "invite")}
          </button>
          {msg ? (
            <p className="error" role="alert">
              {msg}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}

function Policy({
  hh,
  client,
  lang,
  toast,
  fail,
  reload,
}: {
  hh: Household;
  client: NokkerClient;
  lang: Lang;
  toast: Toast;
  fail: (e: unknown) => void;
  reload: () => Promise<void>;
}): React.ReactElement {
  const [conns, setConns] = useState<string[]>(hh.policy?.minor_connectors ?? []);
  const [agents, setAgents] = useState((hh.policy?.minor_agents ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      // Le noyau remplace les DEUX listes à chaque PUT : on envoie toujours les deux.
      await client.setHouseholdPolicy({
        minor_connectors: conns,
        minor_agents: agentsFromText(agents),
      });
      toast(h(lang, "policySaved"), "ok");
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="machine-section">
      <h3>{h(lang, "policy")}</h3>
      <p className="fine">{h(lang, "policyLead")}</p>
      <fieldset className="hh-policy">
        <legend className="fine">{h(lang, "policyConnectors")}</legend>
        {POLICY_CONNECTORS.map((c) => (
          <label key={c} className="fine team-check">
            <input type="checkbox" checked={conns.includes(c)} onChange={(e) => setConns((cur) => (e.target.checked ? [...cur, c] : cur.filter((x) => x !== c)))} /> {h(lang, `conn_${c}` as HKey)}
          </label>
        ))}
      </fieldset>
      <label className="fine" htmlFor="hh-agents">
        {h(lang, "policyAgents")}
      </label>
      <input id="hh-agents" value={agents} onChange={(e) => setAgents(e.target.value)} autoComplete="off" />
      <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
        {h(lang, "policySave")}
      </button>
    </div>
  );
}

function Approvals({ client, lang, toast, fail, signDecision }: { client: NokkerClient; lang: Lang; toast: Toast; fail: (e: unknown) => void; signDecision: Sign | null }): React.ReactElement {
  const [cards, setCards] = useState<HouseholdApproval[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setCards((await client.listHouseholdApprovals()).approvals);
    } catch (e) {
      setCards([]);
      setErr(householdError(lang, e));
    }
  }, [client, lang]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);
  const decide = async (c: HouseholdApproval, decision: "approve" | "reject"): Promise<void> => {
    if (!signDecision) return setErr(h(lang, "noPasskey"));
    setBusy(c.approval.id);
    setErr(null);
    try {
      const { challenge } = await client.householdApprovalChallenge(c.approval.id, c.member.account_id);
      const p = await signDecision(challenge, decision);
      await client.householdApprovalDecision(c.approval.id, {
        member: c.member.account_id,
        decision,
        challenge,
        device_id: p.device_id,
        ...(p.webauthn ? { webauthn: p.webauthn } : {}),
        ...(p.signature !== undefined ? { signature: p.signature } : {}),
      });
      toast(h(lang, decision === "approve" ? "approved" : "rejected"), "ok");
      await load();
    } catch (e) {
      if (e instanceof NokkerApiError) setErr(householdError(lang, e));
      else fail(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="machine-section">
      <h3>{h(lang, "approvals")}</h3>
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}
      {cards === null ? <p className="fine">{h(lang, "loading")}</p> : !cards.length ? <p className="fine">{h(lang, "approvalsNone")}</p> : null}
      <ul className="hh-list">
        {(cards ?? []).map((c) => (
          <li key={c.approval.id} className="hh-card">
            <strong>
              {h(lang, "approvalFrom", {
                email: c.member.email,
                profile: PROFILE_SHORT[lang][c.member.profile],
                tool: c.approval.tool_name,
              })}
            </strong>
            {c.approval.reason ? <p className="fine">{h(lang, "approvalReason", { reason: c.approval.reason })}</p> : null}
            {c.approval.args ? (
              <dl className="ra-summary">
                {Object.entries(c.approval.args).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt>{k}</dt>
                    <dd className="ra-value">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
                  </React.Fragment>
                ))}
              </dl>
            ) : null}
            {c.approval.expires_at ? (
              <p className="fine">
                {h(lang, "expires", {
                  date: fmtReset(lang, c.approval.expires_at, true) ?? c.approval.expires_at,
                })}
              </p>
            ) : null}
            <div className="team-row-actions">
              <button type="button" className="btn btn-brass" disabled={busy !== null} onClick={() => void decide(c, "approve")}>
                {busy === c.approval.id ? h(lang, "signing") : h(lang, "approve")}
              </button>
              <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void decide(c, "reject")}>
                {h(lang, "reject")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MyLine({
  me,
  hh,
  client,
  lang,
  toast,
  fail,
  reload,
}: {
  me: HouseholdMember;
  hh: Household;
  client: NokkerClient;
  lang: Lang;
  toast: Toast;
  fail: (e: unknown) => void;
  reload: () => Promise<void>;
}): React.ReactElement {
  const [confirm, setConfirm] = useState(false);
  const leave = async (): Promise<void> => {
    try {
      await client.removeHouseholdMember(me.account_id);
      toast(h(lang, "left"), "ok");
      await reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <div className="machine-section">
      <h3>{h(lang, "yourLine")}</h3>
      <p>
        {h(lang, "colTurns")} : {me.turns.today} · {me.turns.week}
      </p>
      <p className="fine">
        {PROFILE_LABEL[lang][me.profile]}
        {me.status === "suspended" ? ` · ${h(lang, "suspended")}` : ""} · {me.cap.turns_per_day === null ? h(lang, "yourNoCap") : h(lang, "yourCap", { cap: me.cap.turns_per_day })}
      </p>
      {isMinor(me.profile) ? (
        <p className="fine">{h(lang, "minorNoLeave")}</p>
      ) : confirm ? (
        <p className="hh-confirm" role="alert">
          {h(lang, "leaveConfirm", { name: hh.name })}{" "}
          <button type="button" className="btn btn-danger" onClick={() => void leave()}>
            {h(lang, "yes")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)}>
            {h(lang, "cancel")}
          </button>
        </p>
      ) : (
        <button type="button" className="btn btn-ghost" onClick={() => setConfirm(true)}>
          {h(lang, "leave")}
        </button>
      )}
    </div>
  );
}

const KINDS: HouseholdNote["kind"][] = ["fact", "rule", "feedback"];

function Notes({
  client,
  lang,
  toast,
  fail,
  payer,
  who,
}: {
  client: NokkerClient;
  lang: Lang;
  toast: Toast;
  fail: (e: unknown) => void;
  payer: boolean;
  who: (account: string) => string | null;
}): React.ReactElement {
  // L'auteur est un identifiant de compte : on montre l'adresse d'un membre connu, sinon la date seule.
  const by = (account: string, at: string): string => {
    const w = who(account);
    return w ? h(lang, "noteBy", { who: w, date: fmtDate(lang, at) }) : h(lang, "noteOn", { date: fmtDate(lang, at) });
  };
  const [notes, setNotes] = useState<HouseholdNote[] | null>(null);
  const [edit, setEdit] = useState<{
    name: string | null;
    kind: HouseholdNote["kind"];
    title: string;
    text: string;
    base_sha?: string;
  } | null>(null);
  const [forget, setForget] = useState<HouseholdNote | null>(null);
  const [history, setHistory] = useState<HouseholdQuarantined[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setNotes((await client.listHouseholdNotes()).notes.filter((n) => !n.deleted));
    } catch (e) {
      setNotes([]);
      fail(e);
    }
  }, [client, fail]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (): Promise<void> => {
    if (!edit || !edit.title.trim() || !edit.text.trim()) return;
    setBusy(true);
    try {
      const r = await client.putHouseholdNote(edit.name ?? noteName(edit.kind, edit.title), {
        kind: edit.kind,
        title: edit.title.trim(),
        text: edit.text,
        ...(edit.base_sha ? { base_sha: edit.base_sha } : {}),
      });
      if (r.refused) toast(h(lang, "noteRefused"), "error");
      else toast(h(lang, r.quarantined ? "noteConflict" : "noteSaved"), "ok");
      if (!r.refused) setEdit(null);
      await load();
      if (history) setHistory((await client.listHouseholdQuarantine()).quarantine);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const doForget = async (n: HouseholdNote): Promise<void> => {
    try {
      await client.forgetHouseholdNote(n.name);
      toast(h(lang, "noteForgotten"), "ok");
      setForget(null);
      await load();
    } catch (e) {
      fail(e);
    }
  };
  const toggleHistory = async (): Promise<void> => {
    if (history) return setHistory(null);
    try {
      setHistory((await client.listHouseholdQuarantine()).quarantine);
    } catch (e) {
      fail(e);
    }
  };
  const restore = async (q: HouseholdQuarantined): Promise<void> => {
    try {
      await client.restoreHouseholdQuarantine(q.id);
      toast(h(lang, "restored"), "ok");
      await load();
      setHistory((await client.listHouseholdQuarantine()).quarantine);
    } catch (e) {
      fail(e);
    }
  };
  return (
    <div className="machine-section">
      <h3>{h(lang, "notes")}</h3>
      <p className="fine">{h(lang, "notesLead")}</p>
      {notes === null ? <p className="fine">{h(lang, "loading")}</p> : !notes.length ? <p className="fine">{h(lang, "notesNone")}</p> : null}
      <ul className="hh-list">
        {(notes ?? []).map((n) => (
          <li key={n.name} className="hh-note">
            <span className="chip">{h(lang, `kind_${n.kind}` as HKey)}</span>
            <strong>{n.title}</strong>
            <p>{n.text}</p>
            <span className="fine">{by(n.author_account, n.updated_at)}</span>
            {forget?.name === n.name ? (
              <p className="hh-confirm" role="alert">
                {h(lang, "noteForgetConfirm", { title: n.title ?? n.name })}{" "}
                <button type="button" className="btn btn-danger" onClick={() => void doForget(n)}>
                  {h(lang, "yes")}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setForget(null)}>
                  {h(lang, "cancel")}
                </button>
              </p>
            ) : (
              <span className="team-row-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() =>
                    setEdit({
                      name: n.name,
                      kind: n.kind,
                      title: n.title ?? "",
                      text: n.text ?? "",
                      base_sha: n.sha,
                    })
                  }
                >
                  {h(lang, "noteEdit")}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setForget(n)}>
                  {h(lang, "noteForget")}
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {edit ? (
        <form
          className="hh-note-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="fine" htmlFor="hh-note-kind">
            {h(lang, "noteKind")}
          </label>
          <select
            id="hh-note-kind"
            value={edit.kind}
            disabled={edit.name !== null}
            onChange={(e) =>
              setEdit({
                ...edit,
                kind: e.target.value as HouseholdNote["kind"],
              })
            }
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {h(lang, `kind_${k}` as HKey)}
              </option>
            ))}
          </select>
          <label className="fine" htmlFor="hh-note-title">
            {h(lang, "noteTitle")}
          </label>
          <input id="hh-note-title" value={edit.title} maxLength={200} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
          <label className="fine" htmlFor="hh-note-text">
            {h(lang, "noteText")}
          </label>
          <textarea id="hh-note-text" value={edit.text} maxLength={4000} rows={3} onChange={(e) => setEdit({ ...edit, text: e.target.value })} />
          <span className="team-row-actions">
            <button type="submit" className="btn btn-brass" disabled={busy || !edit.title.trim() || !edit.text.trim()}>
              {h(lang, "noteSave")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>
              {h(lang, "cancel")}
            </button>
          </span>
        </form>
      ) : (
        <button type="button" className="btn" onClick={() => setEdit({ name: null, kind: "fact", title: "", text: "" })}>
          {h(lang, "noteAdd")}
        </button>
      )}
      {payer ? (
        <div className="hh-history">
          <button type="button" className="btn btn-ghost" aria-expanded={!!history} onClick={() => void toggleHistory()}>
            {h(lang, "history")}
          </button>
          {history ? (
            history.length ? (
              <ul className="hh-list">
                {history.map((q) => (
                  <li key={q.id} className="hh-note">
                    <strong>{q.title ?? q.name}</strong>
                    {q.text ? <p>{q.text}</p> : null}
                    <span className="fine">{by(q.author_account, q.updated_at)}</span>
                    <button type="button" className="btn btn-ghost" onClick={() => void restore(q)}>
                      {h(lang, "restore")}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="fine">{h(lang, "historyNone")}</p>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DeleteHousehold({
  hh,
  client,
  lang,
  toast,
  fail,
  reload,
}: {
  hh: Household;
  client: NokkerClient;
  lang: Lang;
  toast: Toast;
  fail: (e: unknown) => void;
  reload: () => Promise<void>;
}): React.ReactElement {
  const [confirm, setConfirm] = useState(false);
  const del = async (): Promise<void> => {
    try {
      await client.deleteHousehold();
      toast(h(lang, "deleted"), "ok");
      await reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <div className="machine-section hh-danger">
      {confirm ? (
        <p className="hh-confirm" role="alert">
          {h(lang, "deleteConfirm", { name: hh.name })}{" "}
          <button type="button" className="btn btn-danger" onClick={() => void del()}>
            {h(lang, "yes")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)}>
            {h(lang, "cancel")}
          </button>
        </p>
      ) : (
        <button type="button" className="btn btn-ghost" onClick={() => setConfirm(true)}>
          {h(lang, "danger")}
        </button>
      )}
    </div>
  );
}
