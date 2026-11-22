/**
 * Données du téléphone à la demande (LOKKAL-PHONE §4.3, lot P8) — faux noyau du contrat (packages/sdk/src/device.ts) :
 * capacités déclarées par appareil, `device.request` publié sur le flux d'événements, réponse de l'app (premier appareil
 * qui répond ; 409 pour les suivants ; 410 après le délai ; 403 si la demande n'est pas au membre), 50 éléments au plus,
 * 30 demandes par heure. Mock seulement : POST /v1/dev/device-request {op, args?, timeout_ms?} joue le noyau qui demande
 * pendant un tour et rend {items} ou {error: "device_offline"|"device_denied"|...}.
 */
import { randomBytes } from "node:crypto";
import { CAP_OF, DEVICE_MAX_ITEMS, type DeviceCap, type DeviceCaps, type DeviceOp } from "@nokker-apps/sdk";
import type { MockState } from "./state.js";
import { enqueuePhoneTask, placeNode } from "./phone.js";

type Send = (status: number, obj: unknown) => void;
const OPS = new Set<DeviceOp>(["calendar.list", "contacts.search", "reminders.list"]);
const CAPS = new Set<DeviceCap>(["calendar.read", "contacts.read", "reminders.read"]);
const PER_HOUR = 30;

interface Pending {
  user: string;
  op: DeviceOp;
  expires: number;
  answered: boolean;
  done: (r: { items?: unknown[]; error?: string }) => void;
}
interface DevState {
  caps: Map<string, Map<string, DeviceCaps>>;
  pending: Map<string, Pending>;
  asked: Map<string, number[]>;
}
const all = new WeakMap<MockState, DevState>();
function st(state: MockState): DevState {
  let s = all.get(state);
  if (!s) all.set(state, (s = { caps: new Map(), pending: new Map(), asked: new Map() }));
  return s;
}

export async function handleDevice(state: MockState, user: string, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const s = st(state);
  const err = (status: number, code: string, message = code): true => (send(status, { error: { code, message } }), true);
  const capsM = /^\/v1\/me\/devices\/([^/]+)\/caps$/.exec(path);
  if (capsM) {
    const id = decodeURIComponent(capsM[1]!);
    const mine = s.caps.get(user) ?? new Map<string, DeviceCaps>();
    s.caps.set(user, mine);
    if (method === "GET") return mine.has(id) ? (send(200, mine.get(id)), true) : err(404, "not_found");
    if (method === "DELETE") return mine.delete(id), send(204, null), true;
    if (method === "PUT") {
      const b = await readBody();
      const caps = Array.isArray(b.caps) ? b.caps.filter((c): c is DeviceCap => CAPS.has(c as DeviceCap)) : null;
      if (!caps || (b.platform !== "ios" && b.platform !== "android") || typeof b.name !== "string" || !b.name.trim()) return err(400, "bad_caps");
      const v: DeviceCaps = { name: b.name.trim().slice(0, 60), platform: b.platform, caps: [...new Set(caps)] };
      mine.set(id, v);
      return send(200, v), true;
    }
    return false;
  }
  const resM = /^\/v1\/me\/device-requests\/([^/]+)\/result$/.exec(path);
  if (resM && method === "POST") {
    const p = s.pending.get(decodeURIComponent(resM[1]!));
    if (!p) return err(404, "not_found");
    if (p.user !== user) return err(403, "not_yours");
    if (Date.now() > p.expires) return err(410, "expired");
    if (p.answered) return err(409, "already_answered");
    const b = await readBody();
    if (typeof b.device_id !== "string" || !s.caps.get(user)?.has(b.device_id)) return err(400, "unknown_device");
    if (typeof b.error === "string") {
      p.answered = true;
      p.done({ error: b.error === "denied" ? "device_denied" : `device_${b.error}` });
      return send(204, null), true;
    }
    if (!Array.isArray(b.items)) return err(400, "bad_result");
    if (b.items.length > DEVICE_MAX_ITEMS) return err(400, "too_many_items");
    p.answered = true;
    p.done({ items: b.items });
    return send(204, null), true;
  }
  if (path === "/v1/dev/device-request" && method === "POST") {
    const b = await readBody();
    const op = b.op as DeviceOp;
    if (!OPS.has(op)) return err(400, "bad_op");
    const now = Date.now();
    const asked = (s.asked.get(user) ?? []).filter((t) => now - t < 3600_000);
    if (asked.length >= PER_HOUR) return err(429, "rate");
    asked.push(now);
    s.asked.set(user, asked);
    const timeout = Math.min(20_000, Math.max(100, Number(b.timeout_ms) || 20_000));
    // P7 : un membre qui a un nœud téléphone EN LIGNE passe par sa file (calendar.list) ; device.request reste le repli
    // (nœud absent, ou silencieux pendant la moitié du délai).
    // P7b : même placement que le noyau (capacité `device_calendar` à `on`, en charge, Wi-Fi, nom).
    const node = op === "calendar.list" ? placeNode(state, user, "device_calendar") : undefined;
    if (node) {
      const t = enqueuePhoneTask(state, node.id, "calendar.list", (b.args as Record<string, unknown>) ?? {});
      const end = now + timeout / 2;
      while (Date.now() < end && (t.status === "queued" || t.status === "leased")) await new Promise((r) => setTimeout(r, 25));
      if (t.status === "done") {
        let items: unknown[] = [];
        try {
          items = (JSON.parse(t.result ?? "{}") as { items?: unknown[] }).items ?? [];
        } catch {
          return send(200, { via: "node", error: "device_bad_result" }), true;
        }
        return send(200, { via: "node", task_id: t.id, items: items.slice(0, DEVICE_MAX_ITEMS) }), true;
      }
      if (t.status === "failed") return send(200, { via: "node", task_id: t.id, error: t.error?.code === "denied" ? "device_denied" : `device_${t.error?.code ?? "failed"}` }), true;
      t.status = "cancelled";
    }
    const devices = [...(s.caps.get(user)?.values() ?? [])].filter((d) => d.caps.includes(CAP_OF[op]));
    if (!devices.length) return send(200, { error: "device_unavailable" }), true;
    const id = "dr_" + randomBytes(8).toString("hex");
    const result = await new Promise<{ items?: unknown[]; error?: string }>((done) => {
      s.pending.set(id, { user, op, expires: now + timeout, answered: false, done });
      state.publish({ type: "device.request", request_id: id, op, args: (b.args as object) ?? {}, expires_at: new Date(now + timeout).toISOString() } as never);
      setTimeout(() => done({ error: "device_offline" }), timeout);
    });
    return send(200, { request_id: id, ...result }), true;
  }
  return false;
}
