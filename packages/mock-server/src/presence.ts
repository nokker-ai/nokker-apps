/**
 * « Who does what » — mock of core docs/WHO-DOES-WHAT.md (flag `who_does_what`, off by default like the core:
 * option `whoDoesWhat` or `MOCK_WHO_DOES_WHAT=1`; off → 404). Read only (anything but GET → 405).
 * Entries: the threads of the mock that work (or sit in a session), the agents of the mock (paused → "paused"), three
 * fictitious Crew agents showing the other statuses, and the house agents when the house room is on. A household member
 * who is not the payer gets `read_only` (`MOCK_HOUSEHOLD=member|minor`).
 */
import type { PresenceEntry, PresenceStatus, PresenceView } from "@nokker-apps/sdk";
import { householdMinor, householdOf } from "./household.js";
import type { MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;
const ORDER: PresenceStatus[] = ["awaiting_approval", "blocked", "working", "paused", "idle"];

export async function handlePresence(state: MockState, user: string, method: string, path: string, send: Send): Promise<boolean> {
  if (path !== "/v1/presence") return false;
  if (!state.whoDoesWhat) return send(404, { error: { code: "not_found", message: "not found" } }), true;
  if (method !== "GET") return send(405, { error: { code: "read_only", message: "vue en lecture seule" } }), true;
  const mk = (e: Omit<PresenceEntry, "since"> & { since?: string | null }): PresenceEntry => ({ since: null, ...e });
  const entries: PresenceEntry[] = [];
  for (const rec of state.threads.values()) {
    const t = rec.thread;
    if (t.origin) continue;
    entries.push(mk({ id: t.id, kind: "thread", name: t.title, status: t.working ? "working" : "idle", activity: t.working ? (t.last_snippet ? { code: "snippet", text: t.last_snippet } : { code: "thinking" }) : t.last_snippet ? { code: "snippet", text: t.last_snippet } : null, since: t.updated_at, goal: null, target: { type: "thread", id: t.id } }));
  }
  for (const a of state.agents.values()) {
    entries.push(mk({ id: `agent:${a.id}`, kind: "agent", name: a.name, role: a.role, status: a.status === "paused" ? "paused" : "idle", activity: a.status === "paused" ? { code: "agent_paused" } : null, target: { type: "agent", id: a.id } }));
  }
  entries.push(
    mk({ id: "agent:demo-courrier", kind: "agent", name: "Courrier (demo)", role: "Mail triage", status: "awaiting_approval", activity: { code: "approval", tool: "mail_envoyer" }, target: { type: "agent", id: "demo-courrier" } }),
    mk({ id: "agent:demo-veille", kind: "agent", name: "Veille (demo)", role: "Morning brief", status: "working", activity: { code: "tool", tool: "web_search" }, target: { type: "agent", id: "demo-veille" } }),
    mk({ id: "agent:demo-sauvegarde", kind: "agent", name: "Sauvegarde (demo)", role: "Nightly backup", status: "blocked", activity: { code: "run_failed" }, target: { type: "agent", id: "demo-sauvegarde" } }),
  );
  if (state.houseRoom) {
    const minor = householdMinor(state, user);
    for (const [slug, name, role, adults] of [["intendant", "Intendant", "Answers the household", false], ["maison", "Maison", "Lights and heating", false], ["courrier", "Courrier", "Household mail", true], ["agenda", "Agenda", "Calendar", false]] as const) {
      if (minor && adults) continue;
      entries.push(mk({ id: `house:${slug}`, kind: "house", name, role, status: "idle", activity: null, target: { type: "house", id: slug } }));
    }
  }
  entries.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (b.since ?? "").localeCompare(a.since ?? ""));
  const counts = Object.fromEntries(ORDER.map((s) => [s, entries.filter((e) => e.status === s).length])) as Record<PresenceStatus, number>;
  const h = householdOf(state);
  const m = h.mode === "off" ? undefined : h.members.get(user);
  const view: PresenceView = {
    viewer: { household: !!m, payer: !!m && m.payer, read_only: !!m && !m.payer },
    entries,
    counts,
    next_waiting: entries.find((e) => e.status === "awaiting_approval")?.id ?? null,
  };
  return send(200, view), true;
}
