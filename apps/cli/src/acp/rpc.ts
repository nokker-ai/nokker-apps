/**
 * JSON-RPC 2.0 sur des lignes JSON (NDJSON), le transport stdio de l'Agent Client Protocol : un message par ligne,
 * requêtes dans les deux sens. Sans dépendance ; stdout ne porte QUE le protocole (journal : cli.log).
 */

export type JsonRpcId = string | number;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Codes d'erreur ACP (schéma v1, `ErrorCode`). */
export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  requestCancelled: -32800,
  authRequired: -32000,
  resourceNotFound: -32002,
} as const;

export class RpcFailure extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

type Message = {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcError;
};

export type RequestHandler = (params: unknown, id: JsonRpcId) => Promise<unknown>;
export type NotificationHandler = (params: unknown) => void | Promise<void>;

export interface RpcPeerOptions {
  write: (line: string) => void;
  onLog?: (level: "info" | "warn" | "error", msg: string) => void;
}

/** Une extrémité de la connexion : `handle(line)` pour chaque ligne reçue, `request`/`notify` pour parler à l'autre. */
export class RpcPeer {
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private requests = new Map<string, RequestHandler>();
  private notifications = new Map<string, NotificationHandler>();
  private buffer = "";
  private closed = false;

  constructor(private readonly opts: RpcPeerOptions) {}

  onRequest(method: string, handler: RequestHandler): this {
    this.requests.set(method, handler);
    return this;
  }

  onNotification(method: string, handler: NotificationHandler): this {
    this.notifications.set(method, handler);
    return this;
  }

  /** Morceau brut de stdin (peut couper une ligne en deux). */
  feed(chunk: string): void {
    this.buffer += chunk;
    for (let i = this.buffer.indexOf("\n"); i !== -1; i = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (line) this.handleLine(line);
    }
  }

  request<T = unknown>(method: string, params: unknown): { id: JsonRpcId; promise: Promise<T> } {
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      if (this.closed) return reject(new RpcFailure(RPC.internalError, "connexion fermée"));
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return { id, promise };
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Fin de stdin : les requêtes sortantes en attente échouent. */
  close(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new RpcFailure(RPC.internalError, "connexion fermée"));
    this.pending.clear();
  }

  private send(msg: Message): void {
    if (this.closed) return;
    this.opts.write(`${JSON.stringify(msg)}\n`);
  }

  private handleLine(line: string): void {
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      this.send({ jsonrpc: "2.0", id: null, error: { code: RPC.parseError, message: "JSON illisible" } });
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    if (msg.method !== undefined) {
      if (msg.id !== undefined && msg.id !== null) void this.handleRequest(msg.method, msg.params, msg.id);
      else void this.handleNotification(msg.method, msg.params);
      return;
    }
    if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcFailure(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
    }
  }

  private async handleRequest(method: string, params: unknown, id: JsonRpcId): Promise<void> {
    const handler = this.requests.get(method);
    if (!handler) {
      this.send({ jsonrpc: "2.0", id, error: { code: RPC.methodNotFound, message: `méthode inconnue : ${method}` } });
      return;
    }
    try {
      const result = await handler(params, id);
      this.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      const e = err instanceof RpcFailure ? err : new RpcFailure(RPC.internalError, err instanceof Error ? err.message : String(err));
      if (!(err instanceof RpcFailure)) this.opts.onLog?.("error", `${method} : ${String(err)}`);
      this.send({ jsonrpc: "2.0", id, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } });
    }
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    const handler = this.notifications.get(method);
    if (!handler) return; // notification inconnue : ignorée (ACP, extensibilité)
    try {
      await handler(params);
    } catch (err) {
      this.opts.onLog?.("error", `${method} : ${String(err)}`);
    }
  }
}
