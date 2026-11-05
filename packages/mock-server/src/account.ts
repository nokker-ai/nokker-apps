/**
 * « Mon compte » en démo : `/v1/account*` (contrat final de Nokker dev, 22.10.2026) et `/v1/billing/*`
 * (nokker/billing). Le réglage de la démo passe par `POST /v1/dev/account-mock` (mock seulement) :
 * `{billing: bool, plan: "byok"|"solo"|"famille"|"large"|null, status, deleting: bool, internal: bool, export_disabled: bool,
 * expire_export: true, decide_delete: "approve"|"reject"|"expire"}` (`decide_delete` tranche la carte de suppression en attente). Un export est construit tout de suite (24 h, un par 24 h) ; la suppression pose une carte forte
 * dont l'accord suspend le compte.
 */
import { argsSha256, type Approval, type BillingStatus, type VoucherCheck } from "@nokker-apps/sdk";
import { finalizeDecision, MOCK_USER, randomId, type MockState } from "./state.js";
import { householdMinor, householdUsage } from "./household.js";
import { currentTerms, termsLangOf } from "./onboarding.js";

type Send = (status: number, payload: unknown, headers?: Record<string, string>) => void;

interface AccountMock {
  billing: boolean;
  plan: string | null;
  status: string | null;
  deleting: boolean;
  internal: boolean;
  /** Route des codes d'essai servie (noyau ≥ r38) ; faux : `GET /v1/billing/voucher` en 404 comme un noyau d'avant. */
  vouchers: boolean;
  /** Résiliation demandée (`cancel_at_period_end`), y compris pendant l'essai ; `status: "canceling"` aussi. */
  cancelling: boolean;
  exportDisabled: boolean;
  exp: { id: string; created: number; expires: number } | null;
  turnsToday: number;
  mode: "soft" | "hard";
  training: boolean;
  /** Version des conditions acceptée en dernier (MOCK_TERMS_OUTDATED=1 : une version d'avant → réacceptation). */
  termsAccepted: string;
  termsLang: "fr" | "en";
  /** Langue du compte (`POST /v1/dev/account-mock {lang}`) ; null : celle du navigateur qui appelle
   * (`Accept-Language`), comme un compte créé dans cette langue. */
  lang: "fr" | "en" | null;
}

const mocks = new WeakMap<MockState, AccountMock>();
export function accountMock(state: MockState): AccountMock {
  let m = mocks.get(state);
  if (!m) {
    m = { billing: true, plan: null, status: null, deleting: false, internal: false, vouchers: true, cancelling: false, exportDisabled: false, exp: null, turnsToday: 37, mode: "soft", training: false,
      termsAccepted: process.env.MOCK_TERMS_OUTDATED === "1" ? "0".repeat(64) : currentTerms("fr").version, termsLang: "fr", lang: null };
    mocks.set(state, m);
  }
  return m;
}

// Codes d'essai de la démo (nokker/billing/voucher.py) : ESSAI2026 valide, PERIME expiré, EPUISE épuisé, DEJA déjà
// utilisé par ce compte ; tout autre code est inconnu. Premier débit = même jour le mois suivant (Zurich).
const DEMO_VOUCHERS: Record<string, "ok" | "code_expired" | "code_exhausted" | "code_used"> = {
  ESSAI2026: "ok", PERIME: "code_expired", EPUISE: "code_exhausted", DEJA: "code_used",
};

function trialEnd(): string {
  const d = new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), Math.min(d.getUTCDate(), last), 22, 59, 59)).toISOString();
}

function voucherCheck(raw: string, customer: boolean): VoucherCheck {
  const code = raw.replace(/\s+/g, "").toUpperCase();
  if (customer) return { ok: false, error: "code_customer" };
  const r = DEMO_VOUCHERS[code];
  if (!r) return { ok: false, error: "code_invalid" };
  if (r !== "ok") return { ok: false, error: r };
  return { ok: true, months: 1, first_charge_on: trialEnd().slice(0, 10) };
}

// Paliers du noyau (nokker/billing/plans.py, 05.11) : mêmes clés que `GET /v1/billing/plan`, prix lus sur Stripe.
const PLANS: { id: string; caps: Record<string, number>; price?: { amount: number; currency: string; interval: string | null } }[] = [
  { id: "byok", caps: {}, price: { amount: 9, currency: "CHF", interval: "month" } },
  { id: "solo", caps: { turns_per_day: 40, turns_per_week: 200, deep_per_day: 20 }, price: { amount: 19, currency: "CHF", interval: "month" } },
  { id: "famille", caps: { turns_per_day: 110, turns_per_week: 550, household_members: 6 }, price: { amount: 49, currency: "CHF", interval: "month" } },
  // Large sans prix : le noyau omet `price` quand Stripe n'a pas répondu (la carte s'affiche sans montant).
  { id: "large", caps: { turns_per_day: 230, turns_per_week: 1150, household_members: 6 } },
];

// `{}` (palier byok) = plafonds par défaut de la bêta côté noyau (limits.py), pas « sans plafond ».
function planCapsOrBeta(plan: string | null): Record<string, number> {
  const caps = PLANS.find((p) => p.id === plan)?.caps;
  return caps && Object.keys(caps).length > 0 ? caps : { turns_per_day: 40, turns_per_week: 200 };
}

/** Prochain midi UTC. */
function nextNoonUtc(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/** Fenêtre de la semaine : du lundi 06:00 UTC passé au prochain lundi 06:00 UTC (strictement après `now`). */
export function weekWindowUtc(now = new Date()): { starts: string; resets_at: string } {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6));
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  return { starts: new Date(d.getTime() - 7 * 86_400_000).toISOString(), resets_at: d.toISOString() };
}

const zurichDay = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich" }).format(new Date());

export async function handleAccount(
  state: MockState,
  method: string,
  path: string,
  readBody: () => Promise<Record<string, unknown>>,
  send: Send,
  query: URLSearchParams = new URLSearchParams(),
  acceptLanguage = "",
): Promise<boolean> {
  const m = accountMock(state);

  if (method === "POST" && path === "/v1/dev/account-mock") {
    const b = await readBody();
    for (const k of ["billing", "deleting", "internal", "vouchers", "cancelling"] as const) if (typeof b[k] === "boolean") m[k] = b[k] as boolean;
    if ("plan" in b) m.plan = (b.plan as string | null) ?? null;
    if ("status" in b) m.status = (b.status as string | null) ?? null;
    else if ("plan" in b) m.status = m.plan ? "active" : null;
    if (typeof b.export_disabled === "boolean") m.exportDisabled = b.export_disabled;
    if (b.expire_export === true && m.exp) m.exp = { ...m.exp, created: Date.now() - 25 * 3600_000, expires: Date.now() - 3600_000 };
    if (b.decide_delete === "approve" || b.decide_delete === "reject" || b.decide_delete === "expire") {
      const a = [...state.approvals.values()].find((x) => x.tool_name === "account_delete" && x.status === "pending");
      if (a && b.decide_delete === "expire") a.status = "expired";
      else if (a && b.decide_delete !== "expire") finalizeDecision(state, a, b.decide_delete, "webauthn");
    }
    if (typeof b.turns_today === "number") m.turnsToday = b.turns_today;
    if (b.mode === "soft" || b.mode === "hard") m.mode = b.mode;
    if (b.lang === "fr" || b.lang === "en" || b.lang === null) m.lang = b.lang;
    send(200, { ok: true });
    return true;
  }

  // Carte de suppression accordée : compte et locataire `suspended` tout de suite. Comme le noyau, toute requête
  // authentifiée suivante répond 403 `{error:{message:"forbidden"}}`, `GET /v1/account` compris (aucun code dédié).
  if ([...state.approvals.values()].some((a) => a.tool_name === "account_delete" && (a.status === "approved" || a.status === "executed"))) m.deleting = true;
  if (m.deleting && path.startsWith("/v1/")) return send(403, { error: { message: "forbidden" } }), true;

  if (method === "GET" && path === "/v1/terms") {
    send(200, currentTerms(String(query.get("lang") ?? "fr")));
    return true;
  }

  if (!path.startsWith("/v1/account") && !path.startsWith("/v1/billing/")) return false;

  const termsState = () => {
    const cur = currentTerms(m.termsLang);
    return { terms_current: { version: cur.version, lang: cur.lang }, terms_outdated: termsLangOf(m.termsAccepted) === null };
  };

  if (method === "POST" && path === "/v1/account/terms") {
    const b = await readBody();
    const lang = termsLangOf(String(b.version ?? ""));
    if (!lang) return send(409, { error: "stale_version" }), true;
    m.termsAccepted = String(b.version);
    m.termsLang = lang;
    send(200, { terms: { version: m.termsAccepted, lang, accepted_at: new Date().toISOString() }, ...termsState() });
    return true;
  }

  if (method === "GET" && path === "/v1/account") {
    send(200, {
      email: `${MOCK_USER}@example.ch`,
      lang: m.lang ?? (/^\s*en\b/i.test(acceptLanguage) ? "en" : "fr"),
      created_at: "2026-10-12T08:30:00+02:00",
      status: "active",
      terms: { version: m.termsAccepted, accepted_at: "2026-10-12T08:31:10+02:00" },
      ...termsState(),
      consents: householdMinor(state, MOCK_USER) ? { training: false, training_locked: "minor" } : { training: m.training },
    });
    return true;
  }

  if (method === "PUT" && path === "/v1/account/consent") {
    const b = await readBody();
    if (b.scope !== "training" || typeof b.granted !== "boolean") return send(400, { error: "invalid" }), true;
    if (b.granted && householdMinor(state, MOCK_USER)) return send(403, { error: { code: "minor_training_refused", message: "profil mineur : jamais d'entraînement" } }), true;
    m.training = b.granted;
    send(200, { scope: "training", granted: m.training });
    return true;
  }

  if (method === "GET" && path === "/v1/account/usage") {
    const plan = m.billing ? m.plan : null;
    const caps = m.internal ? null : planCapsOrBeta(plan);
    const dayCap = caps ? (caps.turns_per_day ?? null) : null;
    const weekCap = caps ? (caps.turns_per_week ?? null) : null;
    const weekUsed = m.turnsToday + 173;
    send(200, {
      tz: "Europe/Zurich",
      mode: m.mode,
      plan,
      today: {
        day: zurichDay(),
        resets_at: nextNoonUtc(),
        turns: { used: m.turnsToday, cap: dayCap, over: dayCap !== null && m.turnsToday > dayCap, hard_cap: dayCap === null ? null : 150 },
      },
      week: {
        ...weekWindowUtc(),
        turns: { used: weekUsed, cap: weekCap, over: weekCap !== null && weekUsed > weekCap },
      },
      month: { turns: { used: 412 } },
      ...(householdUsage(state, MOCK_USER) ? { household: householdUsage(state, MOCK_USER) } : {}),
    });
    return true;
  }

  const exportBody = (e: NonNullable<AccountMock["exp"]>): Record<string, unknown> => {
    const expired = Date.now() >= e.expires;
    return {
      id: e.id,
      status: expired ? "expired" : "ready",
      created_at: new Date(e.created).toISOString(),
      expires_at: new Date(e.expires).toISOString(),
      size: 48_213,
      download: expired ? null : `/v1/account/exports/${e.id}/download`,
    };
  };

  if (method === "POST" && path === "/v1/account/export") {
    if (m.exportDisabled) return send(503, { error: "export_disabled" }), true;
    if (m.exp && Date.now() < m.exp.created + 24 * 3600_000) {
      return send(429, { error: "export_limit", retry_at: new Date(m.exp.created + 24 * 3600_000).toISOString() }), true;
    }
    const now = Date.now();
    m.exp = { id: randomId("ex"), created: now, expires: now + 24 * 3600_000 };
    send(202, exportBody(m.exp));
    return true;
  }
  const exportMatch = /^\/v1\/account\/exports\/([^/]+)(\/download)?$/.exec(path);
  if (method === "GET" && exportMatch) {
    const id = decodeURIComponent(exportMatch[1]!);
    if (!m.exp || id !== m.exp.id) return send(404, { error: "not_found" }), true;
    if (!exportMatch[2]) return send(200, exportBody(m.exp)), true;
    if (Date.now() >= m.exp.expires) return send(410, { error: "export_expired" }), true;
    send(
      200,
      { format: "nokker-account-export/1", account: { email: `${MOCK_USER}@example.ch`, lang: "fr" }, threads: [] },
      { "Content-Disposition": `attachment; filename="nokker-export-${id}.json"`, "Cache-Control": "no-store" },
    );
    return true;
  }

  if (method === "POST" && path === "/v1/account/delete") {
    const pending = [...state.approvals.values()].find((a) => a.tool_name === "account_delete" && a.status === "pending" && Date.parse(a.expires_at) > Date.now());
    const approval: Approval =
      pending ??
      (() => {
        const args = { account: MOCK_USER };
        const a: Approval = {
          id: randomId("appr"),
          thread_id: "",
          turn_index: 0,
          channel: "web",
          tool_name: "account_delete",
          arguments: args,
          args_sha256: argsSha256(args),
          effect: "destructive",
          rule: "effect:destructive",
          reason: "Permanent deletion of the account and all its data (demo).",
          advice: null,
          strength: "strong",
          status: "pending",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
          decided_by: null,
          decided_via: null,
          decided_at: null,
          result_summary: null,
          error: null,
        };
        state.approvals.set(a.id, a);
        state.publish({ type: "approval.requested", approval: a });
        return a;
      })();
    send(202, { approval_id: approval.id, strength: "strong", expires_at: approval.expires_at, reason: approval.reason });
    return true;
  }

  if (path.startsWith("/v1/billing/")) {
    if (!m.billing) return send(404, { error: "not_found" }), true;
    if (method === "GET" && path === "/v1/billing/plan") {
      const body: BillingStatus = {
        plan: m.plan,
        status: m.status,
        current_period_end: m.plan ? new Date(Date.now() + 20 * 86_400_000).toISOString() : null,
        cancel_at_period_end: m.status === "canceling" || m.cancelling,
        trial_end: m.status === "trialing" ? trialEnd() : null,
        plans: PLANS,
      };
      send(200, body);
      return true;
    }
    if (method === "GET" && path === "/v1/billing/voucher") {
      if (!m.vouchers) return send(404, { error: "not_found" }), true;
      send(200, voucherCheck(String(query.get("code") ?? ""), m.plan !== null));
      return true;
    }
    if (method === "POST" && path === "/v1/billing/checkout") {
      const b = await readBody();
      if (!PLANS.some((p) => p.id === b.plan)) return send(400, { error: "bad_plan" }), true;
      if (m.plan) return send(409, { error: "already_subscribed" }), true;
      if (b.code) {
        const v = voucherCheck(String(b.code), false);
        if (!v.ok) return send(400, { error: v.error }), true;
        return send(200, { url: `https://checkout.stripe.example/trial/${String(b.plan)}` }), true;
      }
      send(200, { url: `https://checkout.stripe.example/c/${String(b.plan)}` });
      return true;
    }
    if (method === "POST" && path === "/v1/billing/portal") {
      if (!m.plan) return send(404, { error: "no_customer" }), true;
      send(200, { url: "https://billing.stripe.example/p/session" });
      return true;
    }
  }
  return false;
}
