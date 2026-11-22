/**
 * Relais Home Assistant de RÉFÉRENCE du nœud maison (P10a) : ce que fait le natif (NokkerHome.swift), en TypeScript,
 * pour les tests contre le faux HA et la fausse coque des recettes. Mêmes opérations, mêmes arguments et mêmes
 * résultats que `home-bridge` (OPS), mêmes gardes que l'appareil (packages/sdk/src/home.ts).
 *
 * Le jeton HA n'est donné qu'au constructeur (sur l'appareil : lu dans le trousseau) ; il n'est jamais rendu, jamais
 * journalisé, et jamais dans un résultat.
 */
import { entityAllowed, HA_EVENTS_TIMEOUT_MAX_S, HA_HISTORY_MAX_H, HA_QUERY_SERVICES, HA_TARGETS_MAX, haTargetsCheck, stripCoordinates, type HaError } from "./home.js";
import type { HaOp } from "./node.js";

/** Sous-ensemble de WebSocket (navigateur, Node 22) dont le relais a besoin. */
export interface WsLike {
  send(data: string): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onopen: ((ev: unknown) => void) | null;
}

export class HaRelayError extends Error {
  constructor(readonly code: HaError) {
    super(code);
  }
}

type Pending = { ok: (r: unknown) => void; ko: (e: HaRelayError) => void };

export interface HaRelayOptions {
  /** `ws://…/api/websocket` (ou wss) de la base vérifiée. */
  wsUrl: string;
  token: string;
  entities: readonly string[];
  /** Le Wi-Fi courant est celui déclaré « maison » (relu à chaque tâche). */
  homeWifi: () => boolean;
  open: (url: string) => WsLike;
  timeoutMs?: number;
}

export class HaRelay {
  private ws: WsLike | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private buffer: { seq: number; event: unknown }[] = [];
  private waiters: Array<() => void> = [];
  private subscribed = false;

  constructor(private readonly o: HaRelayOptions) {}

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let ws: WsLike;
      try {
        ws = this.o.open(this.o.wsUrl);
      } catch {
        return reject(new HaRelayError("ha_unreachable"));
      }
      this.ws = ws;
      const timer = setTimeout(() => (reject(new HaRelayError("ha_unreachable")), this.reset()), this.o.timeoutMs ?? 8000);
      ws.onerror = () => (clearTimeout(timer), reject(new HaRelayError("ha_unreachable")), this.reset());
      ws.onclose = () => (clearTimeout(timer), reject(new HaRelayError("ha_unreachable")), this.reset());
      ws.onmessage = (ev) => {
        let m: { type?: string; id?: number; success?: boolean; result?: unknown; error?: { code?: string }; event?: { data?: { entity_id?: string; old_state?: unknown; new_state?: unknown } } };
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (m.type === "auth_required") return ws.send(JSON.stringify({ type: "auth", access_token: this.o.token }));
        if (m.type === "auth_ok") return clearTimeout(timer), resolve();
        if (m.type === "auth_invalid") return clearTimeout(timer), reject(new HaRelayError("ha_auth_failed")), this.reset();
        if (m.type === "event" && m.event) return this.onEvent(m.event);
        if (m.type === "result" && typeof m.id === "number") {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (!p) return;
          if (m.success) p.ok(m.result);
          else p.ko(new HaRelayError(m.error?.code === "unauthorized" ? "ha_auth_failed" : "ha_error"));
        }
      };
    });
    return this.ready;
  }

  private reset(): void {
    for (const p of this.pending.values()) p.ko(new HaRelayError("ha_unreachable"));
    this.pending.clear();
    try {
      this.ws?.close();
    } catch {
      /* déjà fermé */
    }
    this.ws = null;
    this.ready = null;
    this.subscribed = false;
  }

  close(): void {
    this.reset();
  }

  private async command(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    await this.connect();
    const id = this.nextId++;
    return new Promise((ok, ko) => {
      const t = setTimeout(() => (this.pending.delete(id), ko(new HaRelayError("ha_unreachable"))), this.o.timeoutMs ?? 8000);
      this.pending.set(id, { ok: (r) => (clearTimeout(t), ok(r)), ko: (e) => (clearTimeout(t), ko(e)) });
      this.ws!.send(JSON.stringify({ id, type, ...payload }));
    });
  }

  private onEvent(ev: { data?: { entity_id?: string; old_state?: unknown; new_state?: unknown } }): void {
    const eid = String(ev.data?.entity_id ?? "");
    if (!entityAllowed(eid, this.o.entities)) return;
    const clean = (s: unknown) => (s && typeof s === "object" ? stripCoordinates(s as { entity_id?: unknown; attributes?: unknown }) : s ?? null);
    this.buffer.push({ seq: ++this.seq, event: { ...ev, data: { ...ev.data, old_state: clean(ev.data?.old_state), new_state: clean(ev.data?.new_state) } } });
    if (this.buffer.length > 1000) this.buffer.splice(0, this.buffer.length - 1000);
    for (const w of this.waiters.splice(0)) w();
  }

  private allowedStates(list: unknown): Record<string, unknown>[] {
    return (Array.isArray(list) ? list : []).filter((s) => entityAllowed(String((s as { entity_id?: unknown }).entity_id ?? ""), this.o.entities)).map((s) => stripCoordinates(s as { entity_id?: unknown; attributes?: unknown }) as Record<string, unknown>);
  }

  /** Une tâche de la file : résultat (objet JSON) ou `HaRelayError` (le code part tel quel dans `error.code`). */
  async run(op: HaOp, p: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.o.homeWifi()) throw new HaRelayError("not_home_wifi");
    switch (op) {
      case "ha.states":
        return { states: this.allowedStates(await this.command("get_states")) };
      case "ha.registry": {
        const [areas, devices, entities] = await Promise.all([this.command("config/area_registry/list"), this.command("config/device_registry/list"), this.command("config/entity_registry/list")]);
        const pick = <T extends Record<string, unknown>>(o: T, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
        return {
          areas: (areas as Record<string, unknown>[]).map((a) => pick(a, ["area_id", "name"])),
          devices: (devices as Record<string, unknown>[]).map((d) => pick(d, ["id", "area_id"])),
          entities: (entities as Record<string, unknown>[]).filter((e) => entityAllowed(String(e.entity_id ?? ""), this.o.entities)).map((e) => pick(e, ["entity_id", "area_id", "device_id", "hidden_by", "disabled_by", "platform"])),
        };
      }
      case "ha.call_service":
      case "ha.query": {
        const c = haTargetsCheck(p, this.o.entities);
        if ("error" in c) throw new HaRelayError(c.error);
        const key = `${String(p.domain)}.${String(p.service)}`;
        const query = HA_QUERY_SERVICES.has(key);
        if (op === "ha.call_service" && query) throw new HaRelayError("service_not_allowed");
        if (op === "ha.query" && !query) throw new HaRelayError("service_not_allowed");
        const r = (await this.command("call_service", { domain: p.domain, service: p.service, service_data: p.data ?? {}, target: { entity_id: p.entity_ids }, ...(query ? { return_response: true } : {}) })) as { response?: Record<string, unknown> } | null;
        if (op === "ha.call_service") return { ok: true };
        return { response: Object.fromEntries(Object.entries(r?.response ?? {}).filter(([k]) => entityAllowed(k, this.o.entities))) };
      }
      case "ha.notify": {
        const target = String(p.target ?? ""), message = String(p.message ?? ""), title = String(p.title ?? "");
        if (!message || message.length > 1000 || title.length > 200) throw new HaRelayError("bad_args");
        if (!target.startsWith("notify.") || !entityAllowed(target, this.o.entities)) throw new HaRelayError("entity_not_allowed");
        await this.command("call_service", { domain: "notify", service: "send_message", service_data: { message, ...(title ? { title } : {}) }, target: { entity_id: [target] } });
        return { ok: true };
      }
      case "ha.tracker_see": {
        if (Object.keys(p).some((k) => k !== "dev_id" && k !== "location_name")) throw new HaRelayError("bad_args");
        const dev = p.dev_id, where = p.location_name;
        if (typeof dev !== "string" || typeof where !== "string" || !/^nokker_[a-z0-9_]{1,48}$/.test(dev) || !where || where.length > 40) throw new HaRelayError("bad_args");
        await this.command("call_service", { domain: "device_tracker", service: "see", service_data: { dev_id: dev, location_name: where } });
        return { ok: true };
      }
      case "ha.events": {
        const after = Number(p.after ?? -1), timeout = Math.max(0, Math.min(HA_EVENTS_TIMEOUT_MAX_S, Number(p.timeout ?? HA_EVENTS_TIMEOUT_MAX_S)));
        if (!Number.isFinite(after) || !Number.isFinite(timeout)) throw new HaRelayError("bad_args");
        if (!this.subscribed) {
          await this.command("subscribe_events", { event_type: "state_changed" });
          this.subscribed = true;
        }
        if (after < 0) return { cursor: this.seq, events: [] };
        const fresh = () => this.buffer.filter((e) => e.seq > after);
        if (!fresh().length && timeout > 0) await new Promise<void>((ok) => (this.waiters.push(ok), setTimeout(ok, timeout * 1000)));
        return { cursor: this.seq, events: fresh() };
      }
      case "ha.history":
      case "ha.logbook": {
        // `_period` de home-bridge : 1 à 10 entités permises, `hours` borné à [0,1 ; 168], depuis maintenant.
        const ids = p.entity_ids;
        if (!Array.isArray(ids) || !ids.length || ids.length > HA_TARGETS_MAX) throw new HaRelayError("bad_args");
        if (ids.some((e) => !entityAllowed(String(e), this.o.entities))) throw new HaRelayError("entity_not_allowed");
        const hours = Number(p.hours ?? 24);
        if (!Number.isFinite(hours)) throw new HaRelayError("bad_args");
        const start = new Date(Date.now() - Math.max(0.1, Math.min(hours, HA_HISTORY_MAX_H)) * 3600_000).toISOString();
        const entity_ids = ids.map(String);
        if (op === "ha.history") {
          const got = ((await this.command("history/history_during_period", { start_time: start, entity_ids, minimal_response: true, no_attributes: true, significant_changes_only: false })) ?? {}) as Record<string, unknown>;
          return { history: Object.fromEntries(Object.entries(got).filter(([k, v]) => entityAllowed(k, this.o.entities) && Array.isArray(v)).map(([k, v]) => [k, (v as Record<string, unknown>[]).map((r) => ({ s: r.s ?? null, lu: r.lu ?? r.lc ?? null })).slice(-200)])) };
        }
        const got = ((await this.command("logbook/get_events", { start_time: start, entity_ids })) ?? []) as Record<string, unknown>[];
        const keep = ["when", "entity_id", "state", "name", "message"];
        return { entries: (Array.isArray(got) ? got : []).filter((e) => e && typeof e === "object" && entityAllowed(String(e.entity_id ?? ""), this.o.entities)).map((e) => Object.fromEntries(keep.filter((k) => k in e).map((k) => [k, e[k]]))).slice(-200) };
      }
      default:
        throw new HaRelayError("bad_args");
    }
  }
}

/** `ws(s)://<base>/api/websocket` depuis l'URL de base vérifiée (`haUrlCheck`). */
export const haWsUrl = (base: string): string => `${base.replace(/^http/, "ws")}/api/websocket`;
