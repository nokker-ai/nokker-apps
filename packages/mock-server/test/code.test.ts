import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { LOCAL_TOKEN, startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
afterEach(async () => {
  await mock?.close();
});
async function boot(code: boolean): Promise<NokkerClient> {
  mock = await startMockServer({ speed: 0.01, code, configDir: null });
  const c = new NokkerClient({ baseUrl: mock.url });
  await c.demoSessionMockExtension();
  return c;
}
const fail = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    if (!(e instanceof NokkerApiError)) return { status: -1 };
    return { status: e.status, code: (e.body as { error?: { code?: string } }).error?.code };
  }
};
const dev = (body: Record<string, unknown>): Promise<Response> =>
  fetch(`${mock.url}/v1/dev/code-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("sessions de code (§7.28)", () => {
  it("drapeau code.enabled éteint : 404 partout", async () => {
    const c = await boot(false);
    expect((await fail(c.listCodeSessions())).status).toBe(404);
    expect((await fail(c.createCodeSession())).status).toBe(404);
    expect((await fail(c.listCodeCredentials())).status).toBe(404);
  });

  it("le jeton local n'est pas un compte : 403 account_required", async () => {
    await boot(true);
    const local = new NokkerClient({ baseUrl: mock.url, token: LOCAL_TOKEN });
    expect(await fail(local.listCodeSessions())).toEqual({ status: 403, code: "account_required" });
  });

  it("ouvrir sans dépôt : mode par défaut, fil du hub du même id, plafond dans la liste", async () => {
    const c = await boot(true);
    expect(await c.listCodeSessions()).toEqual({ sessions: [], limit: 3, modes: ["default", "accept_edits", "plan"], default_mode: "accept_edits", idle_ttl_s: 1800 });
    const s = await c.createCodeSession();
    expect(s).toMatchObject({ status: "active", mode: "accept_edits", workspace: "/workspace", repo: null });
    expect(s.id).toMatch(/^cs_[0-9a-f]{16}$/);
    expect(s.thread_id).toBe(s.id);
    expect((await c.listThreads()).some((t) => t.id === s.id)).toBe(true);
    expect((await c.getCodeSession(s.id)).id).toBe(s.id);
  });

  it("dépôt : URL propre gardée, refus du contrat sans écho d'identifiant", async () => {
    const c = await boot(true);
    const s = await c.createCodeSession({ repo: { url: "https://GIT.example.org/acme/app.git", ref: "main" }, mode: "plan" });
    expect(s.repo).toEqual({ url: "https://git.example.org/acme/app.git", ref: "main", credential: null });
    expect(s.mode).toBe("plan");
    const cases: [Parameters<NokkerClient["createCodeSession"]>[0], string][] = [
      [{ mode: "auto" }, "bad_mode"],
      [{ repo: { url: "http://git.example.org/a/b" } }, "https_required"],
      [{ repo: { url: "https://user:pw@git.example.org/a/b" } }, "credentials_in_url"],
      [{ repo: { url: "https://github.example.com/a/b" } }, "host_not_allowed"],
      [{ repo: { url: "https://git.example.org/a/b?x=1" } }, "bad_url"],
      [{ repo: { url: "https://git.example.org/a/../b" } }, "bad_url"],
      [{ repo: { url: "https://git.example.org/a/b", ref: "-x" } }, "bad_ref"],
      [{ repo: { url: "https://git.example.org/a/b", credential: "FORGE" } }, "credential_missing"],
      [{ repo: { url: "https://git.example.org/a/b", token: "x" } as never }, "secret_value_refused"],
    ];
    for (const [body, code] of cases) expect((await fail(c.createCodeSession(body))).code, code).toBe(code);
  });

  it("identifiant de forge : nom seulement, jamais la valeur relue", async () => {
    const c = await boot(true);
    expect((await fail(c.putCodeCredential("bad name", "v"))).code).toBe("bad_name");
    expect((await fail(c.putCodeCredential("FORGE", ""))).code).toBe("bad_value");
    expect(await c.putCodeCredential("FORGE", ["x-access-token:", "demo"].join(""))).toEqual({ name: "FORGE", set: true });
    const { credentials } = await c.listCodeCredentials();
    expect(credentials.map((x) => x.name)).toEqual(["FORGE"]);
    expect(JSON.stringify(credentials)).not.toContain("demo");
    const s = await c.createCodeSession({ repo: { url: "https://forge.example.net:8443/team/app", credential: "FORGE" } });
    expect(s.repo?.credential).toBe("FORGE");
    expect(await c.deleteCodeCredential("FORGE")).toEqual({ name: "FORGE", deleted: true });
    expect((await fail(c.deleteCodeCredential("FORGE"))).status).toBe(404);
    await dev({ vault: false });
    expect(await fail(c.listCodeCredentials())).toEqual({ status: 503, code: "vault_unavailable" });
  });

  it("plafond, inactivité, fermeture et effacement", async () => {
    const c = await boot(true);
    const [a, b] = [await c.createCodeSession(), await c.createCodeSession()];
    await c.createCodeSession();
    expect((await fail(c.createCodeSession())).code).toBe("session_limit");
    await dev({ idle: [a.id] });
    expect((await c.getCodeSession(a.id)).status).toBe("idle");
    expect(await c.closeCodeSession(a.id)).toEqual({ id: a.id, closed: true, purged: false });
    expect(await c.closeCodeSession(b.id, true)).toEqual({ id: b.id, closed: true, purged: true });
    expect((await fail(c.getCodeSession(a.id))).status).toBe(404);
    expect((await c.listCodeSessions()).sessions).toHaveLength(1);
    expect((await fail(c.getCodeSession("cs_0123456789abcdef"))).code).toBe("not_found");
  });

  it("points de retour hors tour : liste, diff, restauration par carte forte, liste blanche", async () => {
    const c = await boot(true);
    const s = await c.createCodeSession();
    await dev({ idle: [s.id] });
    const listed = await c.callCodeSessionTool(s.id, "checkpoint_list");
    expect("content" in listed && !listed.is_error).toBe(true);
    const points = JSON.parse((listed as { content: string }).content) as { hash: string; short_hash: string; reason: string }[];
    expect(points.map((p) => p.reason)).toEqual(["before patch src/app.py", "before terminal", "session start"]);
    expect((await c.getCodeSession(s.id)).status).toBe("active"); // l'outil rouvre le bac à sable
    const diff = await c.callCodeSessionTool(s.id, "checkpoint_diff", { hash: points[2]!.hash });
    expect(JSON.parse((diff as { content: string }).content).diff).toContain("src/app.py");
    const r = await c.callCodeSessionTool(s.id, "checkpoint_restore", { hash: points[1]!.hash });
    expect(r).toMatchObject({ approval_id: expect.stringMatching(/^appr_/) });
    const card = await c.getApproval((r as { approval_id: string }).approval_id);
    expect(card).toMatchObject({ tool_name: "checkpoint_restore", strength: "strong", status: "pending", thread_id: s.id });
    // La porte peut aussi exécuter tout de suite (200), ou refuser (200 is_error, mode plan).
    await dev({ restore: "direct" });
    const direct = await c.callCodeSessionTool(s.id, "checkpoint_restore", { hash: points[1]!.hash });
    expect(direct).toMatchObject({ is_error: false });
    expect(JSON.parse((direct as { content: string }).content)).toMatchObject({ success: true, restored_to: points[1]!.hash.slice(0, 8) });
    const after = JSON.parse(((await c.callCodeSessionTool(s.id, "checkpoint_list")) as { content: string }).content) as { reason: string }[];
    expect(after[0]!.reason).toBe(`avant retour à ${points[1]!.short_hash.slice(0, 7)}`);
    const plan = await c.createCodeSession({ mode: "plan" });
    const planPoints = JSON.parse(((await c.callCodeSessionTool(plan.id, "checkpoint_list")) as { content: string }).content) as { hash: string }[];
    const refused = await c.callCodeSessionTool(plan.id, "checkpoint_restore", { hash: planPoints[0]!.hash.slice(0, 8) });
    expect(refused).toMatchObject({ is_error: true, content: expect.stringContaining("refusé par le noyau") });
    expect((await fail(c.callCodeSessionTool(s.id, "checkpoint_create" as never))).code).toBe("tool_not_allowed");
    expect((await fail(c.callCodeSessionTool(s.id, "checkpoint_list", [] as never))).code).toBe("bad_arguments");
    await dev({ turn_running: [s.id] });
    expect(await fail(c.callCodeSessionTool(s.id, "checkpoint_list"))).toEqual({ status: 409, code: "turn_running" });
    await c.closeCodeSession(s.id);
    expect((await fail(c.callCodeSessionTool(s.id, "checkpoint_list"))).status).toBe(404);
  });

  it("profil mineur du foyer : 403 minor_not_allowed à l'ouverture, la liste reste lisible", async () => {
    mock = await startMockServer({ speed: 0.01, code: true, household: "minor", configDir: null });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    expect(await fail(c.createCodeSession())).toEqual({ status: 403, code: "minor_not_allowed" });
    expect((await c.listCodeSessions()).sessions).toEqual([]);
  });

  it("clone en échec : 502 clone_failed, rien d'ouvert", async () => {
    const c = await boot(true);
    await dev({ clone: "clone_failed" });
    expect(await fail(c.createCodeSession({ repo: { url: "https://git.example.org/a/b" } }))).toEqual({ status: 502, code: "clone_failed" });
    expect((await c.listCodeSessions()).sessions).toEqual([]);
  });
});
