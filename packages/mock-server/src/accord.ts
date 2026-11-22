/**
 * ACCORD (nokker docs/ACCORD-DEVICE.md §2, `nokker/accord/http.py`) — mock, jeton local seulement. Drapeau éteint
 * (`state.accordEnabled`, défaut faux) : 404, comme le noyau. Même sémantique que le hub : fenêtre de 2 min ouverte par
 * « Ajouter un appareil » ; un code fait correspondre UNE demande (aucune : code faux, trois faux = appairage bloqué
 * 10 min ; plusieurs : fenêtre fermée) ; révocation d'un appareil connu.
 *
 * Le simulateur d'appareil est joué par les tests : `accordRequest(state, {key8, code})` dépose une demande dans la
 * fenêtre (l'appareil réel l'envoie par WebSocket, la personne tape ensuite le code affiché sur l'appareil).
 */
import { randomBytes } from "node:crypto";
import type { AccordDevice, AccordStatus } from "@nokker-apps/sdk";
import { LOCAL_OWNER, type MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;

export const ACCORD_WINDOW_S = 120;
export const ACCORD_LOCK_S = 600;
export const ACCORD_PENDING_MAX = 3;
export const ACCORD_HOST_FP = "9f2c41d7a85e3b60c1f94e72d8a6b05f3e1c7a9d4b8620f5e3a1d7c9b4f80a62";

interface Request {
  key8: string;
  code: string;
  at: number;
}
interface Accord {
  windowUntil: number;
  lockedUntil: number;
  wrong: number;
  requests: Request[];
  devices: AccordDevice[];
}
const all = new WeakMap<MockState, Accord>();
const acc = (state: MockState): Accord => {
  let a = all.get(state);
  if (!a) all.set(state, (a = { windowUntil: 0, lockedUntil: 0, wrong: 0, requests: [], devices: [] }));
  return a;
};
const now = (): number => Date.now() / 1000;

function view(state: MockState): AccordStatus {
  const a = acc(state);
  const t = now();
  if (t >= a.windowUntil) a.requests = [];
  a.requests = a.requests.filter((r) => t - r.at < ACCORD_WINDOW_S);
  return {
    enabled: true,
    host_fp: ACCORD_HOST_FP,
    host_fp8: ACCORD_HOST_FP.slice(0, 8),
    pairing: {
      open: t < a.windowUntil,
      closes_in_s: Math.max(0, Math.floor(a.windowUntil - t)),
      locked: t < a.lockedUntil,
      locked_for_s: Math.max(0, Math.floor(a.lockedUntil - t)),
      requests: a.requests.map((r) => ({ key8: r.key8 })),
    },
    devices: a.devices.map(shown),
  };
}

/** Tests / démo : un appareil déjà appairé (ex. l'appareil émulé de lokkal-test1). */
export function accordSeedDevice(state: MockState, d: Partial<AccordDevice> & { device_id: string; key8: string }): AccordDevice {
  const dev: AccordDevice = { paired_at: now() - 3600, revoked: false, revoked_at: null, ...d };
  acc(state).devices.push(dev);
  return dev;
}

/** Simulateur d'appareil : une demande d'appairage dans la fenêtre (`pair` reçu par WebSocket). `false` : fenêtre fermée. */
export function accordRequest(state: MockState, r: { key8: string; code: string }): boolean {
  const a = acc(state);
  const t = now();
  if (t >= a.windowUntil || t < a.lockedUntil) return false;
  view(state);
  if (a.requests.length >= ACCORD_PENDING_MAX) return false;
  a.requests.push({ ...r, at: t });
  return true;
}

/** Tests : la dernière connexion d'un appareil (secondes Unix ; `null` : jamais). */
export function accordSetLastSeen(state: MockState, deviceId: string, sec: number | null): void {
  const d = acc(state).devices.find((x) => x.device_id === deviceId);
  if (d) d.last_seen_at = sec;
}

/** Tests : remet l'état ACCORD à zéro. */
export function accordReset(state: MockState): void {
  all.set(state, { windowUntil: 0, lockedUntil: 0, wrong: 0, requests: [], devices: [] });
}

/** Tests : fixe des échéances (secondes restantes) pour un compte à rebours déterministe. */
export function accordSet(state: MockState, p: { windowS?: number; lockedS?: number }): void {
  const a = acc(state);
  if (p.windowS !== undefined) a.windowUntil = now() + p.windowS;
  if (p.lockedS !== undefined) a.lockedUntil = now() + p.lockedS;
}

const DEFAULT_NAME = (key8: string): string => `ACCORD ${key8}`;
/** Nom accepté (comme le noyau) : NFC, 40 caractères au plus, aucun caractère de contrôle ; vide : `null` (nom par défaut). */
function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") throw new Error("bad_name");
  const n = raw.normalize("NFC").trim();
  if (/[\u0000-\u001f\u007f]/.test(n) || [...n].length > 40) throw new Error("bad_name");
  return n === "" ? null : n;
}
/** Un appareil tel que le noyau le sert : `name` est toujours le nom à montrer. */
function shown(d: AccordDevice & { _name?: string | null }): AccordDevice {
  const own = d._name ?? null;
  const { _name: _n, ...rest } = d;
  void _n;
  return { ...rest, name: own ?? DEFAULT_NAME(d.key8), name_is_default: own === null, last_seen_at: d.last_seen_at ?? null };
}

const err = (send: Send, status: number, code: string): void => send(status, { error: { code, message: code } });

export async function handleAccord(state: MockState, user: string | null, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  // Simulateur d'appareil pour les parcours e2e (processus séparé) : une demande d'appairage, un appareil déjà appairé.
  if (method === "POST" && path === "/v1/dev/accord/request" && state.accordEnabled && user === LOCAL_OWNER) {
    const b = await readBody();
    send(200, { accepted: accordRequest(state, { key8: String(b.key8 ?? ""), code: String(b.code ?? "") }) });
    return true;
  }
  if (method === "POST" && path === "/v1/dev/accord/reset" && state.accordEnabled && user === LOCAL_OWNER) {
    accordReset(state);
    send(200, { reset: true });
    return true;
  }
  if (method === "POST" && path === "/v1/dev/accord/seed" && state.accordEnabled && user === LOCAL_OWNER) {
    const b = await readBody();
    const dev = accordSeedDevice(state, { device_id: String(b.device_id), key8: String(b.key8), last_seen_at: typeof b.last_seen_at === "number" ? b.last_seen_at : null });
    if (typeof b.name === "string" && b.name) (dev as { _name?: string | null })._name = b.name;
    send(200, shown(dev));
    return true;
  }
  if (path !== "/v1/local/accord" && !path.startsWith("/v1/local/accord/")) return false;
  if (!state.accordEnabled || user !== LOCAL_OWNER) {
    send(404, { error: { message: "not found" } }); // drapeau éteint (ou pas le propriétaire local) : comme le noyau
    return true;
  }
  const a = acc(state);
  if (method === "GET" && path === "/v1/local/accord") {
    send(200, view(state));
    return true;
  }
  if (method === "POST" && path === "/v1/local/accord/pair/open") {
    if (now() < a.lockedUntil) return err(send, 423, "pairing_locked"), true;
    a.windowUntil = now() + ACCORD_WINDOW_S;
    a.requests = [];
    send(200, view(state));
    return true;
  }
  if (method === "POST" && path === "/v1/local/accord/pair") {
    const body = await readBody();
    const t = now();
    if (t < a.lockedUntil) return err(send, 423, "pairing_locked"), true;
    if (t >= a.windowUntil) return err(send, 409, "pairing_closed"), true;
    const code = String(body.code ?? "").trim();
    view(state);
    const hits = a.requests.filter((r) => r.code === code);
    if (hits.length > 1) {
      a.windowUntil = 0;
      a.requests = [];
      return err(send, 409, "ambiguous"), true;
    }
    if (hits.length === 0) {
      a.wrong += 1;
      if (a.wrong >= 3) {
        a.wrong = 0;
        a.lockedUntil = t + ACCORD_LOCK_S;
        a.windowUntil = 0;
        a.requests = [];
        return err(send, 423, "pairing_locked"), true;
      }
      return err(send, 400, "bad_code"), true;
    }
    const dev: AccordDevice = { device_id: `acc_${randomBytes(6).toString("hex")}`, key8: hits[0]!.key8, paired_at: t, revoked: false, revoked_at: null };
    a.devices.push(dev);
    a.wrong = 0;
    a.windowUntil = 0;
    a.requests = [];
    send(200, shown(dev));
    return true;
  }
  const m = /^\/v1\/local\/accord\/devices\/(acc_[0-9a-f]{12})$/.exec(path);
  if (method === "PATCH" && m) {
    const body = await readBody();
    let name: string | null;
    try {
      name = cleanName(body.name);
    } catch {
      return err(send, 400, "bad_name"), true;
    }
    const d = a.devices.find((x) => x.device_id === m[1] && !x.revoked);
    if (!d) {
      send(404, { error: { message: "appareil inconnu ou révoqué" } });
      return true;
    }
    (d as { _name?: string | null })._name = name;
    send(200, shown(d));
    return true;
  }
  if (method === "DELETE" && m) {
    const d = a.devices.find((x) => x.device_id === m[1] && !x.revoked);
    if (!d) {
      send(404, { error: { message: "appareil inconnu ou déjà révoqué" } });
      return true;
    }
    d.revoked = true;
    d.revoked_at = now();
    send(200, { device_id: d.device_id, revoked: true });
    return true;
  }
  send(404, { error: { message: "not found" } });
  return true;
}
