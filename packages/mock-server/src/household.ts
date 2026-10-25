/**
 * Foyer (X23, LOKKAL §7.29) — mock. Drapeau `household` : `MOCK_HOUSEHOLD` = `off` (défaut : 404 partout, comme le
 * noyau), `payer` (alice paie « Famille Exemple » : sam adulte, léa adolescente avec attestation, une invitation en
 * attente, une carte de léa à décider), `member` (alice membre adulte du foyer de bob), `minor` (alice adolescente
 * du foyer de bob : `training_locked`), `none` (pas de foyer, une invitation reçue). Le payeur voit la consommation de
 * chacun, jamais le contenu. Les fenêtres et plafonds suivent le noyau ; les tours sont figés (démo).
 */
import { createHash, randomBytes } from "node:crypto";
import type {
  Household,
  HouseholdApproval,
  HouseholdConsentRecord,
  HouseholdInvitation,
  HouseholdMember,
  HouseholdNote,
  HouseholdPolicy,
  HouseholdProfile,
  HouseholdQuarantined,
  ReceivedHouseholdInvitation,
} from "@nokker-apps/sdk";
import type { MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;
export type HouseholdMode = "off" | "payer" | "member" | "minor" | "none";

const EMAIL = (u: string): string => `${u}@example.com`;
const id = (p: string): string => `${p}_${randomBytes(6).toString("hex")}`;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const isoIn = (ms: number): string => new Date(Date.now() + ms).toISOString();
const DAY = 86_400_000;
const PROFILES: HouseholdProfile[] = ["adult", "teen", "child"];
const CONNECTORS = ["mail", "calendar"]; // ConnectorKind du SDK

const CONSENT_TEXT: Record<"fr" | "en", string> = {
  fr: "Attestation du représentant légal (démo)\n\nJe déclare être le représentant légal de la personne mineure que j'ajoute à ce foyer. Je comprends que :\n- ses conversations restent privées, je vois seulement sa consommation ;\n- tout envoi externe et toute action destructive attendent ma décision, depuis mes appareils ;\n- ses données ne servent jamais à l'entraînement ;\n- je peux retirer cette attestation à tout moment : son profil est alors suspendu.",
  en: "Legal guardian attestation (demo)\n\nI declare that I am the legal guardian of the minor I am adding to this household. I understand that:\n- their conversations stay private, I only see their usage;\n- any external send and any destructive action wait for my decision, from my own devices;\n- their data is never used for training;\n- I can withdraw this attestation at any time: their profile is then suspended.",
};
const consentVersion = (lang: "fr" | "en"): string => createHash("sha256").update(CONSENT_TEXT[lang], "utf8").digest("hex");

interface H {
  mode: HouseholdMode;
  hh: Omit<Household, "you" | "members" | "invitations" | "policy" | "minors" | "size" | "counted"> & { payer: string };
  members: Map<string, Omit<HouseholdMember, "you">>;
  invitations: HouseholdInvitation[];
  received: (ReceivedHouseholdInvitation & { from: string })[];
  policy: HouseholdPolicy;
  minors: boolean;
  consents: HouseholdConsentRecord[];
  notes: HouseholdNote[];
  quarantine: HouseholdQuarantined[];
  approvals: HouseholdApproval[];
  challenges: Map<string, string>;
  seq: number;
}
const all = new WeakMap<MockState, H>();

function member(account: string, profile: HouseholdProfile, payer: boolean, today: number, week: number, cap: HouseholdMember["cap"], daysAgo: number): Omit<HouseholdMember, "you"> {
  return {
    account_id: account,
    email: EMAIL(account),
    payer,
    profile,
    status: "active",
    joined_at: iso(daysAgo * DAY),
    turns: { today, week },
    cap,
  };
}

function seed(mode: HouseholdMode): H {
  const payer = mode === "payer" ? "alice" : "bob";
  const h: H = {
    mode,
    hh: {
      id: id("hh"),
      name: mode === "payer" ? "Famille Exemple" : "Foyer de Bob",
      created_at: iso(12 * DAY),
      plan: "famille",
      mode: "hard",
      max_members: 6,
      quota: {
        tz: "Europe/Zurich",
        today: { used: 0, cap: 110, resets_at: nextNoon() },
        week: { used: 0, cap: 550, resets_at: nextMonday() },
      },
      payer,
    },
    members: new Map(),
    invitations: [],
    received: [],
    policy: { minor_connectors: ["calendar"], minor_agents: [] },
    minors: true,
    consents: [],
    notes: [],
    quarantine: [],
    approvals: [],
    challenges: new Map(),
    seq: 3,
  };
  if (mode === "none") {
    h.received.push({
      id: id("iv"),
      household: { id: id("hh"), name: "Foyer de Bob" },
      profile: "adult",
      created_at: iso(3600_000),
      expires_at: isoIn(14 * DAY),
      from: "bob",
    });
    return h;
  }
  const add = (m: Omit<HouseholdMember, "you">) => h.members.set(m.account_id, m);
  add(member(payer, "adult", true, 14, 61, { turns_per_day: null, source: "none" }, 12));
  if (mode === "payer") {
    add(member("sam", "adult", false, 22, 97, { turns_per_day: 40, source: "default" }, 9));
    add(member("lea", "teen", false, 9, 31, { turns_per_day: 20, source: "custom" }, 6));
    h.consents.push({
      id: id("pc"),
      minor_email: EMAIL("lea"),
      profile: "teen",
      version: consentVersion("fr"),
      lang: "fr",
      granted_at: iso(6 * DAY),
      revoked_at: null,
      active: true,
    });
    h.invitations.push({
      id: id("iv"),
      email: "grand-pere@example.org",
      profile: "adult",
      state: "pending",
      created_at: iso(2 * 3600_000),
      expires_at: isoIn(14 * DAY),
      decided_at: null,
    });
    h.approvals.push({
      member: { account_id: "lea", email: EMAIL("lea"), profile: "teen" },
      approval: {
        id: id("ap"),
        tool_name: "mail_send",
        effect: "external",
        strength: "strong",
        reason: "envoi externe d'un profil mineur : décision du représentant",
        args: {
          to: "prof.maths@example.org",
          subject: "Devoir de jeudi",
          body: "Bonjour, je vous envoie mon devoir en pièce jointe. Léa",
        },
        status: "pending",
        created_at: iso(15 * 60_000),
        expires_at: isoIn(45 * 60_000),
      },
    });
  } else {
    add(
      member(
        "alice",
        mode === "minor" ? "teen" : "adult",
        false,
        7,
        33,
        {
          turns_per_day: mode === "minor" ? 20 : 40,
          source: mode === "minor" ? "custom" : "default",
        },
        5,
      ),
    );
    add(member("carol", "adult", false, 30, 120, { turns_per_day: 40, source: "default" }, 8));
  }
  h.notes.push(
    {
      name: "fact-allergies-3c4d",
      kind: "fact",
      deleted: false,
      sha: "n1",
      updated_at: iso(4 * DAY),
      author_account: payer,
      seq: 1,
      title: "Allergies",
      text: "Sam est allergique aux arachides : le dire à chaque recette proposée.",
    },
    {
      name: "rule-courses-5e6f",
      kind: "rule",
      deleted: false,
      sha: "n2",
      updated_at: iso(DAY),
      author_account: "sam",
      seq: 3,
      title: "Courses du samedi",
      text: "La liste des courses part le vendredi soir, magasin habituel.",
    },
  );
  h.quarantine.push({
    id: id("q"),
    name: "rule-courses-5e6f",
    title: "Courses du dimanche",
    text: "La liste part le samedi soir.",
    sha: "n0",
    updated_at: iso(2 * DAY),
    author_account: "lea",
    replaced_by: "n2",
  });
  return h;
}

function nextNoon(): string {
  const d = new Date();
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));
  if (n.getTime() <= d.getTime()) n.setUTCDate(n.getUTCDate() + 1);
  return n.toISOString();
}
function nextMonday(): string {
  const d = new Date();
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 6));
  n.setUTCDate(n.getUTCDate() + ((8 - n.getUTCDay()) % 7 || 7));
  return n.toISOString();
}

export function householdOf(state: MockState): H {
  let h = all.get(state);
  if (!h) all.set(state, (h = seed(state.household)));
  return h;
}

/** Ligne de `GET /v1/account/usage` (§7.29.5) pour un membre ; `null` sans foyer. */
export function householdUsage(state: MockState, user: string): Record<string, unknown> | null {
  const h = householdOf(state);
  if (h.mode === "off") return null;
  const me = h.members.get(user);
  if (!me) return null;
  const q = quota(h);
  return {
    id: h.hh.id,
    mode: h.hh.mode,
    today: q.today,
    week: q.week,
    member: {
      today: me.turns.today,
      cap: me.cap.turns_per_day,
      source: me.cap.source,
    },
  };
}
/** `consents.training_locked` de `GET /v1/account` : profil mineur. */
export function householdMinor(state: MockState, user: string): boolean {
  const h = householdOf(state);
  const p = h.mode === "off" ? undefined : h.members.get(user)?.profile;
  return p === "teen" || p === "child";
}

function quota(h: H): Household["quota"] {
  const used = (k: "today" | "week") => [...h.members.values()].reduce((n, m) => n + m.turns[k], 0);
  return {
    tz: "Europe/Zurich",
    today: { ...h.hh.quota.today, used: used("today") },
    week: { ...h.hh.quota.week, used: used("week") },
  };
}

function view(h: H, user: string): Household {
  const me = h.members.get(user)!;
  const payer = me.payer;
  const pending = h.invitations.filter((iv) => iv.state === "pending");
  const { payer: _p, ...hh } = h.hh;
  return {
    ...hh,
    size: h.members.size,
    counted: h.members.size + pending.length,
    you: { account_id: user, payer, profile: me.profile },
    quota: quota(h),
    members: [...h.members.values()].filter((m) => payer || m.account_id === user).map((m) => ({ ...m, you: m.account_id === user })),
    ...(payer
      ? {
          invitations: pending,
          policy: h.policy,
          minors: { enabled: h.minors },
        }
      : {}),
  };
}

const err = (send: Send, status: number, code: string, message: string): true => (send(status, { error: { code, message } }), true);

function checkAttestation(h: H, a: unknown, send: Send): boolean {
  const at = a as { version?: unknown; lang?: unknown; legal_guardian?: unknown } | undefined;
  if (!at || at.legal_guardian !== true || (at.lang !== "fr" && at.lang !== "en")) return !err(send, 400, "attestation_required", "attestation du représentant légal requise");
  if (at.version !== consentVersion(at.lang)) return !err(send, 409, "attestation_stale", "le texte d'attestation a changé : relis-le");
  return true;
}

export async function handleHousehold(state: MockState, user: string, method: string, url: URL, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const path = url.pathname;
  if (path !== "/v1/household" && !path.startsWith("/v1/household/")) return false;
  const h = householdOf(state);
  if (h.mode === "off") return err(send, 404, "not_found", "introuvable");
  const me = h.members.get(user);
  const isPayer = !!me?.payer;
  const payerOnly = (): boolean => (isPayer ? false : err(send, me ? 403 : 404, me ? "forbidden" : "not_found", me ? "réservé au payeur" : "aucun foyer"));

  if (path === "/v1/household/consent" && method === "GET") {
    const lang = url.searchParams.get("lang") === "en" ? "en" : "fr";
    return (
      send(200, {
        version: consentVersion(lang),
        lang,
        text: CONSENT_TEXT[lang],
      }),
      true
    );
  }
  if (path === "/v1/household/invitations/received" && method === "GET") {
    return (
      send(200, {
        invitations: me ? [] : h.received.map(({ from: _f, ...iv }) => iv),
      }),
      true
    );
  }
  const ans = path.match(/^\/v1\/household\/invitations\/([^/]+)\/(accept|decline)$/);
  if (ans && method === "POST") {
    const iv = h.received.find((x) => x.id === ans[1]);
    if (!iv) return err(send, 404, "not_found", "invitation inconnue");
    h.received = h.received.filter((x) => x !== iv);
    if (ans[2] === "decline") return (send(200, { declined: true }), true);
    if (me) return err(send, 409, "already_in_household", "déjà dans un foyer");
    h.hh.name = iv.household.name;
    h.hh.id = iv.household.id;
    h.hh.payer = iv.from;
    h.members.set(iv.from, member(iv.from, "adult", true, 12, 58, { turns_per_day: null, source: "none" }, 20));
    h.members.set(user, member(user, iv.profile, false, 0, 0, { turns_per_day: 40, source: "default" }, 0));
    h.mode = "member";
    return (send(200, view(h, user)), true);
  }
  if (path === "/v1/household" && method === "POST") {
    if (me) return err(send, 409, "household_exists", "tu as déjà un foyer");
    const b = await readBody();
    h.hh = {
      ...h.hh,
      id: id("hh"),
      name: typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 80) : "Mon foyer",
      created_at: new Date().toISOString(),
      payer: user,
    };
    h.members = new Map([[user, member(user, "adult", true, 0, 0, { turns_per_day: null, source: "none" }, 0)]]);
    h.invitations = [];
    h.mode = "payer";
    return (send(201, view(h, user)), true);
  }
  if (!me) return err(send, 404, "not_found", "aucun foyer");

  if (path === "/v1/household" && method === "GET") return (send(200, view(h, user)), true);
  if (path === "/v1/household" && method === "DELETE") {
    if (payerOnly()) return true;
    h.members = new Map();
    h.invitations = [];
    h.mode = "none";
    return (send(200, { deleted: true }), true);
  }
  if (path === "/v1/household/consents" && method === "GET") return payerOnly() || (send(200, { consents: h.consents }), true);
  if (path === "/v1/household/invitations" && method === "GET") return payerOnly() || (send(200, { invitations: h.invitations }), true);
  if (path === "/v1/household/invitations" && method === "POST") {
    if (payerOnly()) return true;
    const b = await readBody();
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    const profile = (PROFILES.includes(b.profile as HouseholdProfile) ? b.profile : "adult") as HouseholdProfile;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(send, 400, "invalid", "adresse invalide");
    if ([...h.members.values()].some((m) => m.email === email)) return err(send, 409, "already_member", "déjà membre");
    if (h.invitations.some((iv) => iv.state === "pending" && iv.email === email)) return err(send, 409, "already_invited", "déjà invitée");
    if (h.members.size + h.invitations.filter((iv) => iv.state === "pending").length >= h.hh.max_members) return err(send, 409, "household_full", "foyer complet");
    if (profile !== "adult") {
      if (!h.minors) return err(send, 400, "minors_disabled", "profils mineurs fermés");
      if (!checkAttestation(h, b.attestation, send)) return true;
      const a = b.attestation as { version: string; lang: string };
      h.consents.push({
        id: id("pc"),
        minor_email: email,
        profile,
        version: a.version,
        lang: a.lang,
        granted_at: new Date().toISOString(),
        revoked_at: null,
        active: true,
      });
    }
    const iv: HouseholdInvitation = {
      id: id("iv"),
      email,
      profile,
      state: "pending",
      created_at: new Date().toISOString(),
      expires_at: isoIn(14 * DAY),
      decided_at: null,
    };
    h.invitations.push(iv);
    return (send(201, iv), true);
  }
  const ivm = path.match(/^\/v1\/household\/invitations\/([^/]+)$/);
  if (ivm && method === "DELETE") {
    if (payerOnly()) return true;
    const iv = h.invitations.find((x) => x.id === ivm[1] && x.state === "pending");
    if (!iv) return err(send, 404, "not_found", "invitation inconnue");
    iv.state = "revoked";
    iv.decided_at = new Date().toISOString();
    for (const c of h.consents) if (c.minor_email === iv.email && c.active) Object.assign(c, { active: false, revoked_at: iv.decided_at });
    return (send(200, { revoked: true }), true);
  }

  const mm = path.match(/^\/v1\/household\/members\/([^/]+)(?:\/(cap|profile|consent))?$/);
  if (mm) {
    const target = h.members.get(decodeURIComponent(mm[1]!));
    if (!target) return err(send, 404, "not_found", "membre inconnu");
    const row = () => ({ ...target, you: target.account_id === user });
    if (!mm[2] && method === "DELETE") {
      if (target.payer) return err(send, 409, "payer_fixed", "le payeur supprime le foyer");
      if (target.account_id === user) {
        if (target.profile !== "adult") return err(send, 403, "minor_cannot_leave", "un profil mineur ne quitte pas seul");
      } else if (payerOnly()) return true;
      h.members.delete(target.account_id);
      if (target.account_id === user) h.mode = "none";
      return (send(200, { removed: true }), true);
    }
    if (payerOnly()) return true;
    if (mm[2] === "cap" && method === "PUT") {
      const b = await readBody();
      const n = b.turns_per_day;
      if (n !== null && !(typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 1000)) return err(send, 400, "invalid", "plafond invalide");
      target.cap = {
        turns_per_day: n as number | null,
        source: n === null ? "none" : "custom",
      };
      return (send(200, row()), true);
    }
    if (mm[2] === "cap" && method === "DELETE") {
      target.cap = target.payer ? { turns_per_day: null, source: "none" } : { turns_per_day: 40, source: "default" };
      return (send(200, row()), true);
    }
    if (mm[2] === "profile" && method === "PUT") {
      const b = await readBody();
      const p = b.profile as HouseholdProfile;
      if (!PROFILES.includes(p)) return err(send, 400, "invalid", "profil invalide");
      if (p !== "adult") {
        if (!h.minors) return err(send, 400, "minors_disabled", "profils mineurs fermés");
        if (!checkAttestation(h, b.attestation, send)) return true;
        const a = b.attestation as { version: string; lang: string };
        h.consents.push({
          id: id("pc"),
          minor_email: target.email,
          profile: p,
          version: a.version,
          lang: a.lang,
          granted_at: new Date().toISOString(),
          revoked_at: null,
          active: true,
        });
        target.status = "active";
      } else
        for (const c of h.consents)
          if (c.minor_email === target.email && c.active)
            Object.assign(c, {
              active: false,
              revoked_at: new Date().toISOString(),
            });
      target.profile = p;
      return (send(200, row()), true);
    }
    if (mm[2] === "consent" && (method === "POST" || method === "DELETE")) {
      if (target.profile === "adult") return err(send, 409, "not_minor", "profil adulte");
      if (method === "DELETE") {
        for (const c of h.consents)
          if (c.minor_email === target.email && c.active)
            Object.assign(c, {
              active: false,
              revoked_at: new Date().toISOString(),
            });
        target.status = "suspended";
        return (send(200, row()), true);
      }
      const b = await readBody();
      if (!checkAttestation(h, b.attestation, send)) return true;
      const a = b.attestation as { version: string; lang: string };
      h.consents.push({
        id: id("pc"),
        minor_email: target.email,
        profile: target.profile,
        version: a.version,
        lang: a.lang,
        granted_at: new Date().toISOString(),
        revoked_at: null,
        active: true,
      });
      target.status = "active";
      return (send(200, row()), true);
    }
  }

  if (path === "/v1/household/policy") {
    if (payerOnly()) return true;
    if (method === "GET") return (send(200, h.policy), true);
    if (method === "PUT") {
      const b = await readBody();
      const list = (v: unknown, allowed?: string[]) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && (!allowed || allowed.includes(x))))] : undefined);
      h.policy = {
        minor_connectors: list(b.minor_connectors, CONNECTORS) ?? [],
        minor_agents: list(b.minor_agents) ?? [],
      };
      return (send(200, h.policy), true);
    }
  }

  if (path === "/v1/household/notes" && method === "GET") {
    const since = Number(url.searchParams.get("since") ?? -1);
    return (send(200, { notes: h.notes.filter((n) => n.seq > since), cursor: h.seq }), true);
  }
  if (path === "/v1/household/notes/quarantine" && method === "GET") return payerOnly() || (send(200, { quarantine: h.quarantine }), true);
  const rq = path.match(/^\/v1\/household\/notes\/quarantine\/([^/]+)\/restore$/);
  if (rq && method === "POST") {
    if (payerOnly()) return true;
    const q = h.quarantine.find((x) => x.id === rq[1]);
    if (!q) return err(send, 404, "not_found", "version inconnue");
    const cur = h.notes.find((n) => n.name === q.name);
    const note: HouseholdNote = {
      name: q.name,
      kind: cur?.kind ?? "fact",
      deleted: false,
      sha: randomBytes(4).toString("hex"),
      updated_at: new Date().toISOString(),
      author_account: user,
      seq: ++h.seq,
      title: q.title,
      text: q.text,
    };
    if (cur)
      h.quarantine.push({
        id: id("q"),
        name: cur.name,
        title: cur.title,
        text: cur.text,
        sha: cur.sha,
        updated_at: cur.updated_at,
        author_account: cur.author_account,
        replaced_by: note.sha,
      });
    h.quarantine = h.quarantine.filter((x) => x !== q);
    h.notes = [...h.notes.filter((n) => n.name !== q.name), note];
    return (send(200, { note }), true);
  }
  const nm = path.match(/^\/v1\/household\/notes\/([^/]+)$/);
  if (nm && method === "PUT") {
    const name = decodeURIComponent(nm[1]!);
    const b = await readBody();
    const kind = b.kind as HouseholdNote["kind"];
    if (!["rule", "feedback", "fact"].includes(kind) || typeof b.title !== "string" || typeof b.text !== "string" || !b.title.trim()) return err(send, 400, "bad_note", "note invalide");
    if (/sk_live_|-----BEGIN/.test(b.text))
      return (
        send(200, {
          note: null,
          accepted: 0,
          skipped: 0,
          quarantined: 0,
          refused: 1,
        }),
        true
      );
    const cur = h.notes.find((n) => n.name === name);
    let quarantined = 0;
    if (cur && b.base_sha !== undefined && b.base_sha !== cur.sha) {
      h.quarantine.push({
        id: id("q"),
        name,
        title: cur.title,
        text: cur.text,
        sha: cur.sha,
        updated_at: cur.updated_at,
        author_account: cur.author_account,
        replaced_by: null,
      });
      quarantined = 1;
    }
    const note: HouseholdNote = {
      name,
      kind,
      deleted: b.deleted === true,
      sha: randomBytes(4).toString("hex"),
      updated_at: new Date().toISOString(),
      author_account: user,
      seq: ++h.seq,
      title: b.title.trim().slice(0, 200),
      text: b.text.slice(0, 4000),
    };
    h.notes = [...h.notes.filter((n) => n.name !== name), note];
    return (send(200, { note, accepted: 1, skipped: 0, quarantined, refused: 0 }), true);
  }
  if (nm && method === "DELETE") {
    const name = decodeURIComponent(nm[1]!);
    const had = h.notes.some((n) => n.name === name && !n.deleted);
    h.notes = h.notes.map((n) => (n.name === name ? { ...n, deleted: true, seq: ++h.seq } : n));
    return (send(200, { forgotten: had }), true);
  }

  if (path === "/v1/household/approvals" && method === "GET")
    return (
      payerOnly() ||
      (send(200, {
        approvals: h.approvals.filter((a) => a.approval.status === "pending"),
      }),
      true)
    );
  const ap = path.match(/^\/v1\/household\/approvals\/([^/]+)\/(challenge|decision)$/);
  if (ap && method === "POST") {
    if (payerOnly()) return true;
    const card = h.approvals.find((a) => a.approval.id === ap[1]);
    const b = await readBody();
    if (!card || b.member !== card.member.account_id) return err(send, 404, "not_found", "carte inconnue");
    if (card.approval.status !== "pending") return err(send, 409, "already_decided", "déjà décidée");
    if (ap[2] === "challenge") {
      const challenge = randomBytes(16).toString("base64url");
      h.challenges.set(card.approval.id, challenge);
      return (
        send(200, {
          challenge,
          nonce: randomBytes(8).toString("hex"),
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
        true
      );
    }
    if (b.decision !== "approve" && b.decision !== "reject") return err(send, 400, "invalid", "décision invalide");
    if (b.challenge !== h.challenges.get(card.approval.id)) return err(send, 400, "bad_challenge", "défi inconnu ou expiré");
    // Preuve forte : passkey (webauthn) ou Mini App (init_data) ; une clé d'appareil seule ne décide pas une carte forte.
    if (typeof b.device_id !== "string" || !(b.webauthn || b.init_data)) return err(send, 403, "strong_device_required", "à décider depuis un appareil de confiance (passkey ou Mini App)");
    h.challenges.delete(card.approval.id);
    card.approval.status = b.decision === "approve" ? "approved" : "rejected";
    return (send(200, card.approval), true);
  }
  return err(send, 404, "not_found", "route inconnue");
}
