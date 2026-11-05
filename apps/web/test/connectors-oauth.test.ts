import { afterEach, describe, expect, it } from "vitest";
import type { MultiConnector } from "@nokker-apps/sdk";
import { captureOAuthReturn, captureVoucher, cleanAccountUrl, forgetVoucher, readOAuthReturn, recallVoucher, takeOAuthReturn } from "../src/account/links.js";
import { buildPasswordKindRequest, connectLabelKey, connectorAddress, entryOf, labelProblem, oauthAccounts, oauthReturnKey, shownKinds } from "../src/connectors/ConnectorsMulti.js";

const c = (o: Partial<MultiConnector>): MultiConnector => ({ id: "x", kind: "mail", label: "x", default: false, state: "ok", access: "owner", ...o });
const presets = {
  mail: [], calendar: [],
  kinds: ["mail", "calendar", "contacts", "files", "tasks"] as MultiConnector["kind"][],
  oauth: [
    { provider: "microsoft", services: ["mail", "calendar", "contacts", "files", "tasks"] as MultiConnector["kind"][], enabled: true },
    { provider: "google", services: ["calendar", "contacts", "tasks"] as MultiConnector["kind"][], enabled: true },
    { provider: "google", services: ["files"] as MultiConnector["kind"][], enabled: true, picker: { developer_key: "k", app_id: "1" } },
  ],
};

// Le test tourne sans DOM : un sessionStorage en mémoire, pour que « rien n'est capturé » ait un sujet.
const store = new Map<string, string>();
(globalThis as { sessionStorage?: unknown }).sessionStorage ??= {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
afterEach(() => forgetVoucher());

describe("retour OAuth et adresse", () => {
  it("lit done / error, nettoie les valeurs, ignore une nature inconnue", () => {
    expect(readOAuthReturn("?oauth=done&provider=microsoft&account=oa_abcdefgh23&missing=contacts,bogus,tasks")).toEqual({ status: "done", provider: "microsoft", code: null, account: "oa_abcdefgh23", missing: ["contacts", "tasks"] });
    expect(readOAuthReturn("?oauth=error&code=denied&provider=google")).toMatchObject({ status: "error", code: "denied", provider: "google" });
    expect(readOAuthReturn("?oauth=error&code=<script>")).toMatchObject({ code: null });
    expect(readOAuthReturn("?billing=success")).toBeNull();
    captureOAuthReturn("?oauth=done&provider=google");
    expect(takeOAuthReturn()?.provider).toBe("google");
    expect(takeOAuthReturn()).toBeNull();
  });

  it("`?oauth=error&code=denied` n'est pas pris pour un code d'essai ; l'adresse est nettoyée", () => {
    captureVoucher("?oauth=error&code=denied");
    expect(recallVoucher()).toBe("");
    captureVoucher("?code=ESSAI2026");
    expect(recallVoucher()).toBe("ESSAI2026");
    expect(cleanAccountUrl("?oauth=done&provider=google&account=oa_abcdefgh23&missing=tasks&keep=1", "#t")).toBe("/?keep=1#t");
  });

  it("messages du retour", () => {
    expect(oauthReturnKey({ status: "done", provider: "google", code: null, account: null, missing: [] })).toBe("cmOAuthDone");
    expect(oauthReturnKey({ status: "error", provider: null, code: "already_linked_elsewhere", account: null, missing: [] })).toBe("cmOAuthElsewhere");
    expect(oauthReturnKey({ status: "error", provider: null, code: "inconnu", account: null, missing: [] })).toBe("cmOAuthFailed");
  });
});

describe("écran OAuth", () => {
  it("natures affichées, comptes groupés, entrée de Drive à part", () => {
    expect(shownKinds({ presets })).toEqual(["mail", "calendar", "contacts", "files", "tasks"]);
    expect(shownKinds({ presets: { mail: [], calendar: [] } })).toEqual(["mail", "calendar"]);
    const oa = (id: string, state: "ok" | "reconnect" = "ok") => ({ id, email: `${id}@x.example`, state, connectors: 2 });
    const list = [
      c({ id: "1", kind: "mail", auth: "oauth", provider: "microsoft", oauth_account: oa("oa_m") }),
      c({ id: "2", kind: "calendar", auth: "oauth", provider: "microsoft", oauth_account: oa("oa_m", "reconnect") }),
      c({ id: "3", kind: "files", auth: "oauth", provider: "google", oauth_account: oa("oa_d") }),
      c({ id: "4", kind: "mail", auth: "password" }),
      c({ id: "5", kind: "mail", access: "read", auth: "oauth", provider: "google", owner: { account_id: "a", name: "camille" } }),
    ];
    const g = oauthAccounts(list);
    expect(g.map((x) => [x.id, x.kinds, x.state])).toEqual([["oa_m", ["mail", "calendar"], "reconnect"], ["oa_d", ["files"], "ok"]]);
    expect(entryOf({ presets }, g[1]!)?.picker).toBeTruthy();
    expect(entryOf({ presets }, { provider: "google", kinds: ["calendar"] })?.picker).toBeUndefined();
    expect(connectLabelKey(presets.oauth[0]!)).toBe("cmConnectMicrosoft");
    expect(connectLabelKey(presets.oauth[2]!)).toBe("cmConnectDrive");
    // Google éteint : le noyau envoie l'entrée Drive sans `picker`, elle reste « Connecter Google Drive ».
    expect(connectLabelKey({ provider: "google", services: ["files"], enabled: false } as never)).toBe("cmConnectDrive");
    expect(connectLabelKey({ provider: "google", services: ["calendar"], enabled: false } as never)).toBe("cmConnectGoogle");
  });

  it("adresse affichée : jamais le nom d'origine d'un iCal (il resterait après un renommage)", () => {
    expect(connectorAddress({ settings: { mode: "ical", label: "QA agenda B" } })).toBe("");
    expect(connectorAddress({ settings: { mode: "caldav", url: "https://dav.example/c", username: "alex" } })).toBe("alex");
    expect(connectorAddress({ settings: { auth: "oauth", provider: "google", email: "alex@gmail.example" } })).toBe("alex@gmail.example");
  });

  it("contacts / tâches sans OAuth ; nom en forme d'id d'une nouvelle nature refusé", () => {
    const f = (o: Record<string, string>) => (n: string) => o[n] ?? "";
    expect(buildPasswordKindRequest("contacts", f({ mode: "carddav", url: "https://dav.example/ab", username: "alex", secret: "s" }))).toEqual({ kind: "contacts", settings: { mode: "carddav", username: "alex", url: "https://dav.example/ab" }, secret: "s" });
    expect(buildPasswordKindRequest("contacts", f({ mode: "carddav", url: "http://dav.example", username: "alex", secret: "s" }))).toBeNull();
    expect(buildPasswordKindRequest("tasks", f({ mode: "icloud", username: "alex@icloud.example", secret: "s", label: "Courses" }))).toEqual({ kind: "tasks", label: "Courses", settings: { mode: "icloud", username: "alex@icloud.example" }, secret: "s" });
    expect(labelProblem("ct_abcdefghij")).toBe("errBadLabel");
    expect(labelProblem("tk_0123456789")).toBe("errBadLabel");
  });
});
