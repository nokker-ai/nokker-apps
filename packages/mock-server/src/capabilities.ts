/**
 * `GET /v1/capabilities` (core docs/CLIENT-API.md §Capacités, 6aaccb4), mock : `MOCK_CAPABILITIES=1`, sinon 404 (le
 * web garde alors ses sondes d'avant, comme face à un noyau plus ancien). Les drapeaux suivent ceux du mock ; contrat
 * b33c304 : 32 drapeaux, ceux d'un compte us_ (packs, code, presence…) faux pour le propriétaire Lokkal ; r37 :
 * `pay` vrai pour lui aussi quand le service de paiement est monté (own_card), `pay_agent` suit son drapeau.
 */
import { cloudByokOn } from "./cloud-byok.js";
import { connectorsMultiOn, connectorsOAuthOn } from "./connectors-multi.js";
import type { MockState } from "./state.js";

export function capabilitiesOn(): boolean {
  return process.env.MOCK_CAPABILITIES === "1";
}

export function mockCapabilities(state: MockState, local: boolean): { version: 1; mode: "cloud" | "lokkal"; features: Record<string, boolean> } {
  const cloud = !local;
  const household = state.household !== "off";
  const f: Record<string, boolean> = {
    account: cloud,
    agents: true,
    approvals: true,
    billing: cloud,
    cloud_byok: cloud && cloudByokOn(),
    code: cloud && state.code,
    connectors_multi: cloud && connectorsMultiOn(),
    connectors_oauth: cloud && connectorsOAuthOn(),
    consolidation: cloud && state.consolidation,
    family_calendar: false,
    glance: true,
    guide: state.guide,
    house: cloud && state.houseRoom && household,
    household: cloud && household,
    household_paper: false,
    learning: cloud,
    local,
    local_cost: local,
    long_memory: cloud,
    operate: true,
    packs: cloud && state.packsWeb,
    pay: state.payments,
    pay_agent: state.payAgent !== "off",
    plan: true,
    presence: cloud && state.whoDoesWhat,
    share: true,
    show_me: state.showMe,
    speech: state.tts,
    sso: cloud && state.sso,
    steer: true,
    team: cloud,
    threads: true,
    turn_cost: true,
    who_does_what: cloud && state.whoDoesWhat,
  };
  const features = Object.fromEntries(Object.keys(f).sort().map((k) => [k, f[k]!]));
  return { version: 1, mode: local ? "lokkal" : "cloud", features };
}
