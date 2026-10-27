/**
 * Scénario de démonstration du mock-server (BUBBLES.md). TOUTES les valeurs sont fictives et
 * marquées « démo » : aucun chiffre ni résultat ici ne vient d'une vraie machine ou d'un vrai
 * moteur de recherche. Le contenu affiché est en anglais ; les déclencheurs (regex) acceptent le français et l'anglais.
 * Le but est d'exercer le contrat de bout en bout depuis apps/web et la CLI :
 *
 *  - fils permanents General / Infra / Accounting / Recruiting, quelques agents dans Crew ;
 *  - « disque » → bulle monitor qui travaille (glow) puis se stabilise ; action « Proposer une
 *    purge » → carte d'approbation (une action à effet ne s'exécute jamais en direct) ;
 *  - « cherche … » → bulle search, 4 résultats, aperçus §5 remplis après coup (bubble.updated) ;
 *  - « timer 5 min », « lance le backup » (script), « montre la vidéo » (media) ;
 *  - « crée un agent qui … » → carte agent_draft qui se remplit, action « Activer » → Crew ;
 *  - « envoie / déplace / copie la bulle <x> à <session> » → transfert §3 ;
 *  - quelques secondes après la première connexion SSE, la session Compta travaille puis écrit à
 *    Général (§4) : bulle notify sans fil, affichée dans le fil courant.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { argsSha256, type AgentStatus, type AgentTrigger, type Approval, type Bubble, type BubbleKind, type Preview, type SearchResult } from "@nokker-apps/sdk";
import { backgroundTurn, closeBubble, createBubble, registerAction, registerNotifyAction, shareBubble, transferBubble, updateBubble } from "./bubbles.js";
import { MockHttpError } from "./errors.js";
import { createAgentFull, seedRuns } from "./agents.js";
import { proposeHandoff } from "./handoff.js";
import { createPage, updatePage } from "./pages.js";
import { MOCK_USER, hexId, normalize, randomId, type MockState } from "./state.js";

export interface DemoIds {
  general: string;
  infra: string;
  compta: string;
  recrutement: string;
}

// ---------------------------------------------------------------------------------------------
// Graines
// ---------------------------------------------------------------------------------------------

export function seedDemo(state: MockState): DemoIds {
  const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
  const mk = (title: string, members: string[], minutes: number) => {
    const rec = state.createThread(title, { members });
    rec.thread.created_at = ago(minutes + 60 * 24 * 12);
    return rec;
  };
  const recrutement = mk("Recruiting", ["alice"], 180);
  const compta = mk("Accounting", ["alice", "bob"], 95);
  const infra = mk("Infra", ["alice", "bob"], 40);
  const general = mk("General", ["alice"], 3);

  const turn = (id: string, user: string, reply: string, min: number) => {
    const t = state.appendTurn(id, user, reply, { silent: true });
    t.created_at = ago(min);
    state.threads.get(id)!.thread.updated_at = t.created_at;
  };
  turn(recrutement.thread.id, "Chase the recruiters who haven't replied in 10 days.", "3 follow-ups ready (demo), I'll send them tomorrow at 9 am; timer set.", 180);
  turn(compta.thread.id, "Reconcile the October statements once the bank has published them.", "Okay, I'll watch for it and let you know in whichever thread you're in.", 95);
  turn(infra.thread.id, "Did host-1's nightly backup run?", "Yes, finished at 03:12, 0 errors (demo). Log bubble alongside.", 40);
  turn(
    general.thread.id,
    "Hi Nina, shall we catch up tonight?",
    "Sure. Try “disk”, “search how to free up docker space”, “timer 5 min”, “run the backup”, " +
      "“show the video”, “create an agent that chases invoices” or “send the disk bubble to Infra”.",
    3,
  );

  // Bulles déjà présentes dans d'autres fils (pour que le tiroir et les transferts aient de la matière).
  const backup = createBubble(state, infra.thread.id, {
    kind: "script",
    title: "Nightly backup host-1",
    status: "done",
    state: {
      command: "restic backup /srv --tag nightly",
      host: "host-1",
      log_tail: ["demo — snapshot 7f3a2c1e saved", "Files: 18 204 new, 2 113 changed", "Added to the repo: 3.214 GiB", "processed 412 GiB in 2:41"],
      exit_code: 0,
    },
  });
  backup.created_at = ago(40);
  const relance = createBubble(state, recrutement.thread.id, {
    kind: "timer",
    title: "Recruiter follow-ups",
    status: "working",
    state: { label: "Sending follow-ups (demo)", started_at: ago(180), ends_at: new Date(Date.now() + 13 * 3600_000).toISOString() },
  });
  relance.created_at = ago(180);

  // Crew de démo (§9.5) : un agent par état et par type de déclencheur. Un nom avec « échec » ou « fail » échoue toujours.
  const crew: { name: string; role: string; model: string; tools: string[]; trigger: AgentTrigger; status: AgentStatus; runs: number; failedLast?: boolean }[] = [
    { name: "Host-1 disk watch", role: "Watches disk space and proposes a purge above 90%", model: "Apertus 70B", tools: ["infra_disk_usage", "bubble_update"], trigger: { kind: "event", event: "alert:disk-full" }, status: "paused", runs: 2 },
    { name: "Invoice follow-ups", role: "Chases unpaid invoices at D+15", model: "Qwen3 27B", tools: ["mail_draft", "erp_read"], trigger: { kind: "schedule", cron: "0 7 * * 1-5", tz: "Europe/Zurich" }, status: "armed", runs: 5 },
    { name: "Job listing triage", role: "Sorts new job listings for Alice and Bob", model: "Apertus 70B", tools: ["job_search", "session_send"], trigger: { kind: "manual" }, status: "armed", runs: 3 },
    { name: "Memory digest (failing)", role: "Summarises memory health every morning", model: "Qwen3 8B", tools: ["memory_search", "telegram_send"], trigger: { kind: "schedule", cron: "30 6 * * *", tz: "Europe/Zurich" }, status: "failed", runs: 4, failedLast: true },
  ];
  for (const c of crew) {
    const a = createAgentFull(state, { name: `${c.name} (demo)`, role: c.role, model: c.model, tools: c.tools, instructions: c.role, trigger: c.trigger }, "alice");
    a.status = c.status;
    a.created_at = a.updated_at = ago(60 * 24 * 3);
    a.next_run_at = c.status === "armed" && c.trigger.kind === "schedule" ? new Date(Date.now() + 5 * 3600_000).toISOString() : null;
    seedRuns(state, a, c.runs, c.failedLast);
  }
  const ids = { general: general.thread.id, infra: infra.thread.id, compta: compta.thread.id, recrutement: recrutement.thread.id };
  demoIds.set(state, ids);
  return ids;
}

const demoIds = new WeakMap<MockState, DemoIds>();
const demoStarted = new WeakSet<MockState>();

/** Appelé à la première connexion `/v1/events` : la session Compta va travailler puis notifier. */
export function startDemoTimers(state: MockState): void {
  const ids = demoIds.get(state);
  if (!ids || demoStarted.has(state)) return;
  demoStarted.add(state);
  // Un tour « de fond » dans Compta (déclenché par la banque, démo) : le fil travaille ~6 s puis écrit à Général.
  state.later(6_000, () =>
    backgroundTurn(
      state,
      ids.compta,
      "[Relevé bancaire d'octobre publié (démo)]",
      () => "Statement reconciled (demo): 42 entries, one telecom invoice of 89.90 CHF with no entry.",
      {
        sender: null,
        delayMs: 6_000,
        onReply: () =>
          sessionMessage(state, ids.compta, ids.general, "October telecom invoice received (demo): 89.90 CHF, due 31.10. Shall I prepare the entry?", {
            actions: [{ id: "prepare", label: "Prepare the entry", primary: true }],
          }),
      },
    ),
  );
  // Recrutement respire un moment (point vivant dans le tiroir), sans notification.
  state.later(20_000, () => state.setWorking(ids.recrutement, true));
  state.later(27_000, () => state.setWorking(ids.recrutement, false));
}

// ---------------------------------------------------------------------------------------------
// §4 — sessions qui se parlent
// ---------------------------------------------------------------------------------------------

/** §4 + §8 — une session écrit à une autre. Sans `ask` : bloc dans la boîte de `to`. Avec `ask` : le bloc est
 * l'ENTRÉE d'un tour de fond dans `to`, dont la réponse revient à `from` (« [Réponse de la session …] »). Dans
 * les deux cas : `session.message` + bulle `notify` sans fil pour les membres du fil qui reçoit. */
export function sessionMessage(
  state: MockState,
  fromThread: string,
  toThread: string,
  text: string,
  opts: { ask?: boolean; reply?: boolean; actions?: { id: string; label: string; primary?: boolean }[] } = {},
): Bubble {
  const from = state.requireMember(fromThread, MOCK_USER);
  const to = state.requireMember(toThread, MOCK_USER);
  if (from.thread.id === to.thread.id) throw new MockHttpError(400, "un fil ne s'écrit pas à lui-même");
  const clean = text.trim().slice(0, 2000);
  if (!clean) throw new MockHttpError(400, "texte vide");
  const block = `[${opts.reply ? "Réponse de la session" : "Message de la session"} « ${from.thread.title} »] ${clean}`;
  if (!opts.ask) state.pushContext(toThread, block);
  state.publish({ type: "session.message", from_thread: fromThread, to_thread: toThread, text: clean });
  const notify = createBubble(state, null, {
    kind: "notify",
    title: from.thread.title,
    status: "done",
    state: { from_thread: fromThread, from_title: from.thread.title, to_thread: toThread, text: clean.slice(0, 280), approval_id: null, actions: opts.actions ?? [] },
    shared_members: [...new Set([to.thread.owner, ...to.thread.members])],
  });
  state.later(10 * 60_000, () => {
    if (!notify.closed_at) closeBubble(state, notify.id);
  });
  if (opts.ask) {
    backgroundTurn(state, toThread, block, () => `Got it (demo): “${clean.slice(0, 120)}” — I'm on it in ${to.thread.title}.`, {
      onReply: (reply) => sessionMessage(state, toThread, fromThread, reply, { reply: true }),
    });
  }
  return notify;
}

// Démo : le noyau ferme seulement la notify ; ici on enchaîne un tour dans Compta pour montrer l'action directe.
registerNotifyAction("prepare", (state, b) => {
  if (b.kind !== "notify") return;
  backgroundTurn(
    state,
    b.state.from_thread,
    "[Action “Prepare the entry” requested from the notification]",
    () => "Entry prepared (demo): 6510 Telephony / 1020 Bank, 89.90 CHF — awaiting your approval here.",
    { delayMs: 900 },
  );
});

// Une action à effet (purge) ne s'exécute jamais en direct : elle crée une carte d'approbation.
registerAction("monitor:purge", (state, b) => {
  const threadId = b.thread_id ?? "";
  const args = { host: "host-1", paths: ["/var/lib/docker/overlay2 (orphaned images)", "/var/log/journal (> 14 d)"], dry_run: false };
  const approval: Approval = {
    id: randomId("appr"),
    thread_id: threadId,
    turn_index: state.threads.get(threadId)?.turns.length ?? 0,
    channel: "web",
    tool_name: "infra_disk_purge",
    arguments: args,
    args_sha256: argsSha256(args),
    // DESTRUCTIVE n'accepte QUE `strong` (APPROVALS.md §1) — jamais `standard`.
    effect: "destructive",
    rule: "effect:destructive",
    reason: "Purge proposed from the “" + b.title + "” bubble — would free ~120 GB (demo).",
    advice: "Simulated advice: images not referenced by an active container; logs beyond retention.",
    strength: "strong",
    status: "pending",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    decided_by: null,
    decided_via: null,
    decided_at: null,
    result_summary: null,
    error: null,
  };
  state.approvals.set(approval.id, approval);
  state.publish({ type: "approval.requested", approval });
  approvalBubble(state, approval);
  return "Purge prepared: ~120 GB (demo). It is waiting for your approval — brass card alongside.";
});

/** Bulle `approval` (laiton) qui porte une carte d'approbation dans le fil — la carte elle-même se lit
 * par `/v1/approvals/{id}` (BUBBLES.md §2). */
export function approvalBubble(state: MockState, approval: Approval): Bubble {
  return createBubble(state, approval.thread_id || null, {
    kind: "approval",
    title: `Approve: ${approval.tool_name}`,
    status: "working",
    state: { approval_id: approval.id },
  });
}

/** Après décision : la bulle passe à done/failed puis se ferme. */
export function settleApprovalBubbles(state: MockState, approval: Approval): void {
  for (const b of state.bubbles.values()) {
    if (b.kind !== "approval" || b.closed_at || b.state.approval_id !== approval.id) continue;
    const ok = approval.status === "executed" || approval.status === "approved";
    updateBubble(state, b.id, { status: ok ? "done" : "failed", title: ok ? `Approved: ${approval.tool_name}` : `Rejected: ${approval.tool_name}` });
    state.later(2_500, () => !b.closed_at && closeBubble(state, b.id));
  }
}

// ---------------------------------------------------------------------------------------------
// Aperçus §5 (fictifs) et images re-servies (SVG générés)
// ---------------------------------------------------------------------------------------------

const images = new Map<string, string>();

function svgImage(seed: string, label: string, kind: "cover" | "favicon"): string {
  const sha = createHash("sha256").update(`${kind}:${seed}`).digest("hex");
  if (!images.has(sha)) {
    const h = parseInt(sha.slice(0, 2), 16) * 1.4;
    const h2 = (h + 60) % 360;
    const esc = label.replace(/[<&>"]/g, "");
    images.set(
      sha,
      kind === "favicon"
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="hsl(${h} 55% 45%)"/><text x="16" y="22" font-family="sans-serif" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">${esc.slice(0, 1).toUpperCase()}</text></svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="252" viewBox="0 0 480 252"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 45% 22%)"/><stop offset="1" stop-color="hsl(${h2} 50% 12%)"/></linearGradient></defs><rect width="480" height="252" fill="url(#g)"/><circle cx="400" cy="60" r="90" fill="hsl(${h2} 60% 50%)" opacity=".18"/><rect x="28" y="150" width="240" height="10" rx="5" fill="#fff" opacity=".22"/><rect x="28" y="170" width="170" height="10" rx="5" fill="#fff" opacity=".14"/><text x="28" y="120" font-family="sans-serif" font-size="26" font-weight="700" fill="#fff" opacity=".9">${esc.slice(0, 26)}</text><text x="28" y="226" font-family="monospace" font-size="13" fill="#fff" opacity=".55">demo preview</text></svg>`,
    );
  }
  return signImagePath(sha);
}

/** §9.3 — URL signée `?exp=<epoch>&sig=<hmac-sha256 tronqué à 32 hex>`, TTL 24 h ; secret propre au processus
 * (comme le noyau sans `NOKKER_PREVIEWS_SIGN_SECRET`). */
const IMG_SECRET = randomBytes(32);
export const IMG_SIGN_TTL_S = 24 * 3600;

function imgSig(sha: string, exp: number): string {
  return createHmac("sha256", IMG_SECRET).update(`${sha}:${exp}`).digest("hex").slice(0, 32);
}

export function signImagePath(sha: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + IMG_SIGN_TTL_S;
  return `/v1/previews/img/${sha}?exp=${exp}&sig=${imgSig(sha, exp)}`;
}

export function verifyImageSignature(sha: string, exp: string | null, sig: string | null, now = Date.now()): boolean {
  const e = Number(exp);
  if (!sig || !Number.isInteger(e) || e < Math.floor(now / 1000)) return false;
  const want = Buffer.from(imgSig(sha, e));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function previewImage(sha: string): string | undefined {
  return images.get(sha);
}

const PRESETS: Record<string, { site_name: string; title: string; description: string; kind: Preview["kind"] }> = {};

export function fakePreview(url: string): Preview {
  let host = "example.com";
  try {
    host = new URL(url).hostname;
  } catch {
    /* url invalide : on garde l'hôte par défaut */
  }
  const preset = PRESETS[url];
  const site = preset?.site_name ?? host.replace(/^www\./, "");
  const title = preset?.title ?? `Page on ${site}`;
  return {
    url,
    final_url: url,
    title,
    site_name: site,
    description: preset?.description ?? `Mock preview of ${site} (mock-server demo).`,
    image: svgImage(url, site, "cover"),
    favicon: svgImage(host, site, "favicon"),
    excerpt:
      (preset?.description ?? "") +
      " Demo excerpt: in the real core, this text comes from Trafilatura (up to 1,200 characters) and the image is re-served by /v1/previews/img/.",
    lang: "en",
    kind: preset?.kind ?? "article",
    embed: null,
    fetched_at: new Date().toISOString(),
  };
}

function searchResultsFor(query: string): SearchResult[] {
  const q = normalize(query);
  const disk = /disque|espace|docker|purge|stockage|disk|space|storage/.test(q);
  const base: [string, string, string, string, Preview["kind"]][] = disk
    ? [
        ["https://docs.docker.com/engine/manage-resources/pruning/", "Clean up unused Docker objects", "docker system prune, dangling images, unmounted volumes…", "docs.docker.com", "doc"],
        ["https://wiki.archlinux.org/title/Systemd/Journal", "Limit the systemd journal size", "SystemMaxUse=, journalctl --vacuum-time=14d…", "wiki.archlinux.org", "doc"],
        ["https://unix.stackexchange.com/questions/disk-usage", "Find what is filling a disk", "ncdu, du -xh --max-depth=1, deleted files still held open (lsof +L1)…", "unix.stackexchange.com", "article"],
        ["https://github.com/bootandy/dust", "dust — a more readable du", "Colour-coded tree of the heaviest directories, very fast.", "github.com", "repo"],
      ]
    : [
        [`https://en.wikipedia.org/wiki/${encodeURIComponent(query.slice(0, 40))}`, `${capitalize(query)} — overview`, `Overview of “${query}” (demo).`, "en.wikipedia.org", "article"],
        ["https://www.youtube.com/watch?v=demo", `${capitalize(query)} in 6 minutes`, "Explainer video (demo, no call to the third-party site).", "youtube.com", "video"],
        ["https://github.com/search", `Repositories around “${query}”`, "Related open-source projects (demo).", "github.com", "repo"],
        ["https://news.ycombinator.com/", `Discussion: ${query}`, "Experience reports and links (demo).", "news.ycombinator.com", "article"],
      ];
  return base.map(([url, title, snippet, site, kind]) => {
    PRESETS[url] = { site_name: site, title, description: snippet, kind };
    return { url, title, snippet: `${snippet} (demo)`, site, preview: null };
  });
}

// ---------------------------------------------------------------------------------------------
// Interprétation du chat de démo
// ---------------------------------------------------------------------------------------------

export interface DemoTurn {
  reply: string;
  /** Lancé après la réponse (création/animation des bulles). */
  after?: () => void;
  triggersApproval?: boolean;
}

const KIND_ALIASES: [RegExp, BubbleKind][] = [
  [/recherche|search/, "search"],
  [/minuteur|timer|chrono|stopwatch/, "timer"],
  [/script|log|backup/, "script"],
  [/video|media|image/, "media"],
  [/agent|carte|card/, "agent_draft"],
  [/notif|message/, "notify"],
  [/monitor|surveillance|disque|disk|gpu|cpu/, "monitor"],
];

function findBubble(state: MockState, threadId: string, term: string): Bubble | undefined {
  const n = normalize(term).replace(/^(de |du |des |la |le |les |the )/, "");
  const candidates = [...state.bubbles.values()]
    .filter((b) => b.closed_at === null && (b.thread_id === threadId || b.thread_id === null))
    .reverse();
  const byTitle = candidates.find((b) => normalize(b.title).includes(n));
  if (byTitle) return byTitle;
  const kind = KIND_ALIASES.find(([re]) => re.test(n))?.[1];
  return kind ? candidates.find((b) => b.kind === kind) : undefined;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function interpretDemo(
  state: MockState,
  threadId: string,
  text: string,
  turn: { turnId: string; context: string[] } = { turnId: `${threadId}:0`, context: [] },
): DemoTurn {
  const n = normalize(text);

  // 1) Transfert / partage demandé dans le chat (§3) — AVANT la démo d'approbation « envoie ».
  const trFr = n.match(/^(?:peux-tu |tu peux )?(envoie|envoyer|deplace|deplacer|copie|copier|partage|partager|mets|mettre)\s+(?:la |cette )?bulle\s+(.+?)\s+(?:a|vers|dans|avec|sur)\s+(?:la session |le fil |la |le |l )?(.+?)\s*[.!]?$/);
  // Anglais : « send the disk bubble to Infra » ou « move bubble disk to Infra ».
  const trEn = n.match(/^(?:(?:can|could) you |please )*(send|move|copy|share|put)\s+(?:the |this )?(?:bubble\s+(.+?)|(.+?)\s+bubble)\s+(?:to|into|in|with)\s+(?:the )?(?:session |thread )?(.+?)\s*[.!?]?$/);
  const tr = trFr ? ([trFr[0], trFr[1], trFr[2], trFr[3]] as string[]) : trEn ? [trEn[0], trEn[1], trEn[2] ?? trEn[3], trEn[4]] : null;
  if (tr) {
    const [, verb, term, target] = tr as [string, string, string, string];
    const bubble = findBubble(state, threadId, term);
    const dest = state.findThreadByTitle(target);
    if (!bubble) return { reply: `I can't find an open “${term}” bubble here.` };
    if (!dest) return { reply: `I don't know a session “${target}”.` };
    if (/^(?:partag|share)/.test(verb)) {
      shareBubble(state, bubble.id, { threads: [...bubble.shared_with.threads, dest.thread.id] });
      return { reply: `Bubble “${bubble.title}” shared with ${dest.thread.title} (it stays here, ${dest.thread.title} sees it read-only).` };
    }
    const mode = /^cop/.test(verb) ? "copy" : "move";
    transferBubble(state, bubble.id, dest.thread.id, mode);
    return {
      reply:
        mode === "copy"
          ? `Copy of “${bubble.title}” sent to ${dest.thread.title}: it is in its context now.`
          : `Bubble “${bubble.title}” moved to ${dest.thread.title}: it leaves this thread and enters its context.`,
    };
  }

  // 2) Message à une autre session : « dis à Compta que … »
  const say = n.match(/^(?:(?:dis|ecris|demande)\s+(?:a|au|aux)|tell|ask|message|write to)\s+(?:the )?(?:(?:la )?session |(?:le )?fil |thread )?(\S{3,})\s+(?:que |de |that |to )?(.+)$/);
  if (say) {
    const dest = state.findThreadByTitle(say[1]!);
    if (dest && dest.thread.id !== threadId) {
      const ask = /^(?:demande|ask)/.test(n);
      // Texte d'origine (avec accents) : on reprend la fin du message après le nom du fil.
      const raw = text.slice(text.toLowerCase().indexOf(say[1]!.slice(0, 3)) + say[1]!.length).replace(/^\s*(que|de|that|to)\s+/i, "").trim();
      state.later(400, () => sessionMessage(state, threadId, dest.thread.id, raw || say[2]!, { ask }));
      return { reply: `Message passed on to the ${dest.thread.title} session${ask ? "; it will reply here" : ""}.` };
    }
  }

  // 2b) Page (§10) : « crée/fais une page <titre> » → bulle artifact ; « modifie la page » → version suivante.
  const pg = n.match(/^(?:peux-tu |tu peux |(?:can|could) you |please )?(?:cree|creer|fais|faire|ecris|ecrire|genere|create|make|write|generate|build)\s+(?:moi\s+|me\s+)?(?:une?\s+|an?\s+)?page(?:\s+(?:web|html))?\s*(.*)$/);
  if (pg) {
    const raw = text.replace(/^.*?page(?:\s+(?:web|html))?\s*(?:de |sur |pour |about |on |for |called |titled |named |:)?\s*/i, "").trim();
    const title = capitalize(raw || "Demo page").slice(0, 60);
    const slug = normalize(title).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
    return {
      reply: `I'm preparing the page “${title}” (${slug}.html): it shows in the bubble, private until you publish it.`,
      after: () => void createPage(state, threadId, `${slug}.html`, title),
    };
  }
  if (/^(?:modifie|mets a jour|change|refais|update|change|edit|redo|rewrite|modify)\s+(?:la\s+|the\s+)?page/.test(n)) {
    const page = [...state.pages.values()].filter((p) => p.thread_id === threadId).pop();
    if (!page) return { reply: "I don't have a page in this session yet: ask me for one (“create a page …”)." };
    return { reply: `I'm updating “${page.title}”: the bubble refreshes by itself.`, after: () => updatePage(state, page.id, turn.turnId) };
  }

  // X21 : « passe le relais à l'atelier pour le dépôt site : … » → bulle handoff (machine hors ligne si « portable »).
  const ho =
    n.match(/passe(?:r)? le relais (?:a |au |a l )?(\S+)(?: pour le depot (\S+))?\s*[:,]?\s*(.*)$/) ??
    n.match(/(?:hand(?: it| this| over)? off|pass the baton|hand over) to (?:the )?(\S+)(?: for (?:the )?(?:repo|repository) ([^\s:,]+))?\s*[:,]?\s*(.*)$/);
  if (ho) {
    const machine = ho[1]!.charAt(0).toUpperCase() + ho[1]!.slice(1);
    const repo = ho[2] ?? "site";
    proposeHandoff(state, threadId, { kind: "repo", name: repo, task: ho[3]?.trim() || "fix the failing test", machine, online: !/portable|laptop/.test(ho[1]!) });
    return { reply: `This work needs the “${repo}” repository, which lives on “${machine}”. I suggest handing it off: nothing leaves without your approval.` };
  }

  // 3) Création d'agent → carte agent_draft
  if (/(cree|creer|nouvel?|create|new|make)\s+(un\s+|an?\s+)?agent/.test(n)) {
    const tail = text.replace(/^.*?agent\s*/i, "").replace(/^(qui|pour|that|which|who|to|for)\s+/i, "").trim();
    const role = capitalize(tail || "General-purpose assistant");
    const nm = normalize(tail);
    const name = /factur|invoice|bill/.test(nm) ? "Invoice chaser" : /veill|surveil|watch|monitor/.test(nm) ? "Watcher" : /mail|courrier/.test(nm) ? "Mailer" :
      /offre|recrut|emploi|job|hiring/.test(nm) ? "Job hunter" : /disque|infra|serveur|disk|server/.test(nm) ? "Infra guardian" : "New agent";
    const tools = [
      ...(/factur|compta|invoice|account/.test(nm) ? ["erp_read", "mail_draft"] : []),
      ...(/mail|relan|remind|chase|follow/.test(nm) ? ["mail_draft"] : []),
      ...(/cherch|veill|web|search|watch/.test(nm) ? ["web_search"] : []),
      ...(/disque|infra|serveur|disk|server/.test(nm) ? ["infra_disk_usage"] : []),
      "session_send",
    ];
    return {
      reply: "I'm preparing the agent card; check it, then activate it and it will move to Crew.",
      after: () => {
        const b = createBubble(state, threadId, {
          kind: "agent_draft",
          title: `New agent: ${name}`,
          status: "working",
          state: { name, role: "", model: "", tools: [], fill: 0.2 },
        });
        state.later(700, () => !b.closed_at && updateBubble(state, b.id, { state: { role, fill: 0.55 } }));
        state.later(1_400, () => !b.closed_at && updateBubble(state, b.id, { state: { model: "Apertus 70B (demo)", tools: [...new Set(tools)], fill: 0.85 } }));
        state.later(2_000, () => {
          if (b.closed_at) return;
          b.actions = [{ id: "activate", label: "Activate agent", primary: true }];
          updateBubble(state, b.id, { state: { fill: 1 }, status: "idle" });
        });
      },
    };
  }

  // 4) Recherche web → bulle search + aperçus après coup
  const search = text.match(/^\s*(?:cherche|recherche|trouve|search(?: for)?|find|look up|look for)(?:-moi| me)?\s+(.+?)\s*\??$/i);
  if (search) {
    const query = search[1]!;
    return {
      reply: `Searching “${query}” — sources arrive in the violet bubble, with their preview.`,
      after: () => {
        const results = searchResultsFor(query);
        const call_id = hexId("call");
        const t0 = Date.now();
        state.publish({ type: "tool.call", thread_id: threadId, turn_id: turn.turnId, call_id, name: "web_search", args_preview: JSON.stringify({ q: query }).slice(0, 200) });
        const b = createBubble(state, threadId, {
          kind: "search",
          title: capitalize(query).slice(0, 60),
          status: "working",
          state: { query, took_ms: 0, engines: ["demo"], results: results.map((r) => ({ ...r })) },
        });
        state.later(500, () => {
          if (b.closed_at || b.kind !== "search") return;
          state.publish({ type: "tool.result", thread_id: threadId, turn_id: turn.turnId, call_id, name: "web_search", is_error: false, ms: Date.now() - t0 });
          const withPrev = b.state.results.map((r, i) => (i < 2 ? { ...r, preview: fakePreview(r.url) } : r));
          updateBubble(state, b.id, { state: { results: withPrev, took_ms: 184 } });
        });
        state.later(1_100, () => {
          if (b.closed_at || b.kind !== "search") return;
          updateBubble(state, b.id, { state: { results: b.state.results.map((r) => ({ ...r, preview: r.preview ?? fakePreview(r.url) })) }, status: "done" });
        });
      },
    };
  }

  // 5) Disque → monitor qui travaille puis se stabilise
  if (/disque|espace disque|stockage|disk|storage|\bdf\b/.test(n)) {
    return {
      reply: "Checking host-1's disk (demo) — the cyan bubble breathes while the measurement runs.",
      after: () => {
        const t0 = Date.now();
        const values = [84, 86.5, 88, 89.6, 90.7, 91.2, 91.3];
        const b = createBubble(state, threadId, {
          kind: "monitor",
          title: "Disk host-1 /",
          status: "working",
          state: { target: "host-1:/ (demo)", metric: "disk_used", value: values[0]!, unit: "%", max: 100, series: [[t0, values[0]!]], items: [] },
        });
        values.slice(1).forEach((v, i) => {
          state.later(650 * (i + 1), () => {
            if (b.closed_at || b.kind !== "monitor") return;
            const series = [...(b.state.series ?? []), [t0 + 60_000 * (i + 1), v] as [number, number]];
            updateBubble(state, b.id, { state: { value: v, series } });
          });
        });
        state.later(650 * values.length + 200, () => {
          if (b.closed_at) return;
          b.actions = [{ id: "purge", label: "Propose a purge", primary: true }];
          updateBubble(state, b.id, {
            title: "Disk host-1 / — 91% (stable)",
            status: "done",
            state: {
              items: [
                { label: "/var/lib/docker", value: "412 GB" },
                { label: "/mnt/share", value: "238 GB" },
                { label: "/var/log/journal", value: "19 GB" },
              ],
            },
          });
        });
      },
    };
  }

  // 6) Minuteur
  const timer = n.match(/(?:timer|minuteur|chrono|stopwatch)\s*(?:de\s*|of\s*|for\s*)?(\d+)?\s*(s|sec|secondes?|seconds?|min|minutes?|h|heures?|hours?)?/);
  if (timer) {
    const qty = Number(timer[1] ?? 5);
    const unit = timer[2] ?? "min";
    const ms = /^s/.test(unit) ? qty * 1000 : /^h/.test(unit) ? qty * 3600_000 : qty * 60_000;
    const label = `${qty} ${/^s/.test(unit) ? "s" : /^h/.test(unit) ? "h" : "min"}`;
    return {
      reply: `${label} timer set.`,
      after: () => {
        const started = new Date();
        const b = createBubble(state, threadId, {
          kind: "timer",
          title: `Timer ${label}`,
          status: "working",
          created_by: MOCK_USER,
          state: { label: `Timer ${label}`, started_at: started.toISOString(), ends_at: new Date(started.getTime() + ms).toISOString() },
        });
        state.later(ms, () => !b.closed_at && updateBubble(state, b.id, { status: "done" }));
      },
    };
  }

  // 7) Script
  if (/\blance\b|\brun\b|script|backup|sauvegarde/.test(n)) {
    return {
      reply: "Running the backup on host-1 (demo); the log tail scrolls in the blue bubble.",
      after: () => {
        const lines = [
          "demo — open repository",
          "using parent snapshot 7f3a2c1e",
          "scan finished in 4.2s: 18 312 files, 412 GiB",
          "[0:10] 12.4% 51.1 GiB / 412 GiB",
          "[0:24] 47.9% 197 GiB / 412 GiB",
          "[0:39] 81.0% 334 GiB / 412 GiB",
          "[0:47] 100.0% 412 GiB / 412 GiB",
          "Added to the repo: 1.032 GiB",
          "snapshot 9b41d0aa saved",
        ];
        const b = createBubble(state, threadId, {
          kind: "script",
          title: "Backup host-1 (on demand)",
          status: "working",
          state: { command: "restic backup /srv --tag manual", host: "host-1", log_tail: [], exit_code: null },
        });
        lines.forEach((line, i) => {
          state.later(450 * (i + 1), () => {
            if (b.closed_at || b.kind !== "script") return;
            const done = i === lines.length - 1;
            updateBubble(state, b.id, {
              state: { log_tail: [...b.state.log_tail, line].slice(-40), ...(done ? { exit_code: 0 } : {}) },
              ...(done ? { status: "done" as const } : {}),
            });
          });
        });
      },
    };
  }

  // 8) Média
  if (/video|media|apercu|preview|teaser|montre|show/.test(n)) {
    return {
      reply: "Here is the teaser preview (demo).",
      after: () => {
        const url = "https://nokker.ai/demo/teaser.mp4";
        PRESETS[url] = { site_name: "nokker.ai", title: "Teaser Nokker — Knocks for you", description: "42 s cut (demo).", kind: "video" };
        const p = fakePreview(url);
        createBubble(state, threadId, {
          kind: "media",
          title: "Nokker teaser (42 s)",
          status: "idle",
          state: { url, mime: "video/mp4", poster: p.image, preview: p },
        });
      },
    };
  }

  // 9) Démo d'approbation historique (CLIENT-API.md) — « envoie … »
  if (/envoie|\bsend\b/.test(n)) {
    return {
      reply:
        "I\'m preparing the action, but I need your approval before sending anything outside — " +
        "card sent, approve it (or refuse) so I can continue.",
      triggersApproval: true,
    };
  }

  // 10) Réponse par défaut : montre que le contexte reçu (bulle, message de session) est pris en compte — le
  // noyau l'injecte dans l'entrée du tour (`[Contexte reçu]…[/Contexte]`), le mock le cite dans la réponse.
  if (turn.context.length) {
    return { reply: `Got it — I now have in context: ${turn.context.map((c) => c.slice(0, 160)).join("; ")}` };
  }
  return { reply: `Nina (demo) received: “${text}”. Simulated reply, no tool called.` };
}

export { hexId };
