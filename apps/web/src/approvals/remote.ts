/** Approbations fortes d'une machine liée, signées depuis app.nokker.ai (LOKKAL §7.3) — fonctions pures. */
import type { RemoteApprovalStatus } from "@nokker-apps/sdk";

export type RemoteTarget = { kind: "id"; machineId: string; approvalId: string } | { kind: "host"; host: string; approvalId: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `/approve/<machine_id>/<approval_id>` (lien de la notification) ou `/approve?host=<nom>.nokker.app&approval=<id>`
 * (lien de la bulle sur la passerelle, qui ne connaît pas son `machine_id`). */
export function remoteTargetFrom(pathname: string, search: string): RemoteTarget | null {
  const m = /^\/approve\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (m) {
    const [machineId, approvalId] = [decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)];
    return ID.test(machineId) && ID.test(approvalId) ? { kind: "id", machineId, approvalId } : null;
  }
  if (pathname !== "/approve" && pathname !== "/approve/") return null;
  const q = new URLSearchParams(search);
  const host = (q.get("host") ?? "").toLowerCase();
  const approvalId = q.get("approval") ?? "";
  return /^[a-z0-9.:-]{3,80}$/.test(host) && ID.test(approvalId) ? { kind: "host", host, approvalId } : null;
}

/** Statut final : plus rien à relever. */
export const isFinal = (s: RemoteApprovalStatus): boolean => s === "approved" || s === "rejected" || s === "expired";

/** Minutes restantes avant expiration (0 si passée). */
export function minutesLeftUntil(expiresAt: string, nowMs: number): number {
  const ms = Date.parse(expiresAt) - nowMs;
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 60_000) : 0;
}
