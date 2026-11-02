/**
 * What a person reads when a request fails: the network, the rate limit or a server failure in plain words, the
 * server's own message for a refusal that explains itself (4xx). Never a route or a raw status line.
 */
import { NokkerApiError } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";

export type ErrorKind = "network" | "rate_limited" | "signed_out" | "server" | "refused" | "other";

function bodyError(body: unknown): { code?: string; message?: string } {
  let b = body;
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch {
      return {};
    }
  }
  const e = (b as { error?: unknown } | null | undefined)?.error;
  if (typeof e === "string") return { code: e };
  if (!e || typeof e !== "object") return {};
  const { code, message } = e as { code?: unknown; message?: unknown };
  return { code: typeof code === "string" ? code : undefined, message: typeof message === "string" ? message : undefined };
}

export function errorKind(err: unknown): ErrorKind {
  if (err instanceof NokkerApiError) {
    if (err.status === 429) return "rate_limited";
    if (err.status === 401) return "signed_out";
    if (err.status >= 500) return "server";
    if (err.status >= 400) return "refused";
    return "other";
  }
  // fetch() rejects with a TypeError when the network is down, the DNS fails or the connection is cut.
  if (err instanceof TypeError || (typeof navigator !== "undefined" && navigator.onLine === false)) return "network";
  return "other";
}

export function userErrorText(err: unknown): string {
  switch (errorKind(err)) {
    case "network":
      return tr("Cannot reach Nokker: check your connection.");
    case "rate_limited":
      return tr("Too many requests at once: try again in a moment.");
    case "signed_out":
      return tr("Your session has ended: sign in again.");
    case "server": {
      // A failed turn (error chunk in the stream) or a 5xx carries the core's own short message: keep it when it reads.
      const e = err as NokkerApiError;
      const { message } = bodyError(e.body);
      return message && message.length <= 200 && !message.includes("\n") ? tr("Nokker had a problem: {0}", message) : tr("Nokker had a problem ({0}). Try again in a moment.", e.status);
    }
    case "refused": {
      const e = err as NokkerApiError;
      const { message } = bodyError(e.body);
      return message ?? tr("Request refused ({0}).", e.status);
    }
    default:
      return String(err instanceof Error ? err.message : err);
  }
}
