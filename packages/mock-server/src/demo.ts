/**
 * Scénario de démonstration du mock-server (BUBBLES.md). TOUTES les valeurs sont fictives et
 * marquées « démo » : aucun chiffre ni résultat ici ne vient d'une vraie machine ou d'un vrai
 * moteur de recherche. Le but est d'exercer le contrat de bout en bout depuis apps/web et la CLI :
 *
 *  - fils permanents Général / Infra / Compta / Ninjob, quelques agents dans Crew ;
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
import { argsSha256, type Approval, type Bubble, type BubbleKind, type Preview, type SearchResult } from "@nokker-apps/sdk";
import { backgroundTurn, closeBubble, createBubble, registerAction, registerNotifyAction, shareBubble, transferBubble, updateBubble } from "./bubbles.js";
import { MockHttpError } from "./errors.js";
import { createPage, updatePage } from "./pages.js";
import { MOCK_USER, hexId, normalize, randomId, type MockState } from "./state.js";

export interface DemoIds {
  general: string;
  infra: string;
  compta: string;
  ninjob: string;
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
  const ninjob = mk("Ninjob", ["alice"], 180);
  const compta = mk("Compta", ["alice", "bob"], 95);
  const infra = mk("Infra", ["alice", "bob"], 40);
  const general = mk("Général", ["alice"], 3);

  const turn = (id: string, user: string, reply: string, min: number) => {
    const t = state.appendTurn(id, user, reply, { silent: true });
    t.created_at = ago(min);
    state.threads.get(id)!.thread.updated_at = t.created_at;
  };
  turn(ninjob.thread.id, "Relance les recruteurs qui n'ont pas répondu depuis 10 jours.", "3 relances prêtes (démo), je les poste demain 9 h ; minuteur posé.", 180);
  turn(compta.thread.id, "Rapproche les relevés d'octobre quand la banque aura publié.", "D'accord, je surveille et je te préviens dans le fil où tu seras.", 95);
  turn(infra.thread.id, "Le backup nocturne de host-1 est passé ?", "Oui, terminé à 03:12, 0 erreur (démo). Bulle de log ci-contre.", 40);
  turn(
    general.thread.id,
    "Salut Nina, on fait le point ce soir ?",
    "Oui. Essaie « disque », « cherche comment libérer de l'espace docker », « timer 5 min », « lance le backup », " +
      "« montre la vidéo », « crée un agent qui relance les factures » ou « envoie la bulle disque à Infra ».",
    3,
  );

  // Bulles déjà présentes dans d'autres fils (pour que le tiroir et les transferts aient de la matière).
  const backup = createBubble(state, infra.thread.id, {
    kind: "script",
    title: "Backup nocturne host-1",
    status: "done",
    state: {
      command: "restic backup /srv --tag nightly",
      host: "host-1",
      log_tail: ["démo — snapshot 7f3a2c1e enregistré", "Files: 18 204 new, 2 113 changed", "Added to the repo: 3.214 GiB", "processed 412 GiB in 2:41"],
      exit_code: 0,
    },
  });
  backup.created_at = ago(40);
  const relance = createBubble(state, ninjob.thread.id, {
    kind: "timer",
    title: "Relances recruteurs",
    status: "working",
    state: { label: "Envoi des relances (démo)", started_at: ago(180), ends_at: new Date(Date.now() + 13 * 3600_000).toISOString() },
  });
  relance.created_at = ago(180);

  const agents: [string, string, string, "idle" | "armed" | "running" | "error", string[]][] = [
    ["Veille disque host-1", "Surveille l'espace disque et propose une purge au-delà de 90 %", "Apertus 70B", "idle", ["infra_disk_usage", "bubble_update"]],
    ["Relances factures", "Relance les factures impayées à J+15", "Qwen3 27B", "running", ["mail_draft", "erp_read"]],
    ["Matching ninjob", "Trie les nouvelles offres pour Alice et Bob", "Apertus 70B", "armed", ["ninjob_search", "session_send"]],
    ["Digest CortHeXis", "Résume la santé du corpus chaque matin", "Qwen3 8B", "error", ["memory_search", "telegram_send"]],
  ];
  for (const [name, role, model, status, tools] of agents) {
    const id = hexId("ag");
    state.agents.set(id, {
      id,
      name: `${name} (démo)`,
      role,
      model,
      tools,
      status,
      created_by: "alice",
      created_at: ago(60 * 24 * 3),
      updated_at: ago(60 * 24 * 3),
      last_run: status === "idle" ? ago(50) : status === "error" ? ago(300) : ago(4),
    });
  }
  const ids = { general: general.thread.id, infra: infra.thread.id, compta: compta.thread.id, ninjob: ninjob.thread.id };
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
      () => "Relevé rapproché (démo) : 42 écritures, une facture Swisscom de 89.90 CHF sans écriture.",
      {
        sender: null,
        delayMs: 6_000,
        onReply: () =>
          sessionMessage(state, ids.compta, ids.general, "Facture Swisscom d'octobre reçue (démo) : 89.90 CHF, échéance 31.10. Je prépare l'écriture ?", {
            actions: [{ id: "prepare", label: "Préparer l'écriture", primary: true }],
          }),
      },
    ),
  );
  // Ninjob respire un moment (point vivant dans le tiroir), sans notification.
  state.later(20_000, () => state.setWorking(ids.ninjob, true));
  state.later(27_000, () => state.setWorking(ids.ninjob, false));
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
    backgroundTurn(state, toThread, block, () => `Reçu (démo) : « ${clean.slice(0, 120)} » — je m'en occupe dans ${to.thread.title}.`, {
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
    "[Action « Préparer l'écriture » demandée depuis la notification]",
    () => "Écriture préparée (démo) : 6510 Téléphonie / 1020 Banque, 89.90 CHF — en attente de ta validation ici.",
    { delayMs: 900 },
  );
});

// Une action à effet (purge) ne s'exécute jamais en direct : elle crée une carte d'approbation.
registerAction("monitor:purge", (state, b) => {
  const threadId = b.thread_id ?? "";
  const args = { host: "host-1", paths: ["/var/lib/docker/overlay2 (images orphelines)", "/var/log/journal (> 14 j)"], dry_run: false };
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
    reason: "Purge proposée depuis la bulle « " + b.title + " » — libérerait ~120 Go (démo).",
    advice: "Avis simulé : images non référencées par un conteneur actif ; journaux au-delà de la rétention.",
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
  return "Purge préparée : ~120 Go (démo). Elle attend ton approbation — carte laiton ci-contre.";
});

/** Bulle `approval` (laiton) qui porte une carte d'approbation dans le fil — la carte elle-même se lit
 * par `/v1/approvals/{id}` (BUBBLES.md §2). */
export function approvalBubble(state: MockState, approval: Approval): Bubble {
  return createBubble(state, approval.thread_id || null, {
    kind: "approval",
    title: `Approuver : ${approval.tool_name}`,
    status: "working",
    state: { approval_id: approval.id },
  });
}

/** Après décision : la bulle passe à done/failed puis se ferme. */
export function settleApprovalBubbles(state: MockState, approval: Approval): void {
  for (const b of state.bubbles.values()) {
    if (b.kind !== "approval" || b.closed_at || b.state.approval_id !== approval.id) continue;
    const ok = approval.status === "executed" || approval.status === "approved";
    updateBubble(state, b.id, { status: ok ? "done" : "failed", title: ok ? `Approuvé : ${approval.tool_name}` : `Refusé : ${approval.tool_name}` });
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
        : `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="252" viewBox="0 0 480 252"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 45% 22%)"/><stop offset="1" stop-color="hsl(${h2} 50% 12%)"/></linearGradient></defs><rect width="480" height="252" fill="url(#g)"/><circle cx="400" cy="60" r="90" fill="hsl(${h2} 60% 50%)" opacity=".18"/><rect x="28" y="150" width="240" height="10" rx="5" fill="#fff" opacity=".22"/><rect x="28" y="170" width="170" height="10" rx="5" fill="#fff" opacity=".14"/><text x="28" y="120" font-family="sans-serif" font-size="26" font-weight="700" fill="#fff" opacity=".9">${esc.slice(0, 26)}</text><text x="28" y="226" font-family="monospace" font-size="13" fill="#fff" opacity=".55">aperçu démo</text></svg>`,
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
  let host = "exemple.ch";
  try {
    host = new URL(url).hostname;
  } catch {
    /* url invalide : on garde l'hôte par défaut */
  }
  const preset = PRESETS[url];
  const site = preset?.site_name ?? host.replace(/^www\./, "");
  const title = preset?.title ?? `Page sur ${site}`;
  return {
    url,
    final_url: url,
    title,
    site_name: site,
    description: preset?.description ?? `Aperçu fictif de ${site} (démo du mock-server).`,
    image: svgImage(url, site, "cover"),
    favicon: svgImage(host, site, "favicon"),
    excerpt:
      (preset?.description ?? "") +
      " Extrait de démonstration : dans le noyau réel, ce texte vient de Trafilatura (≤ 1 200 caractères) et l'image est re-servie par /v1/previews/img/.",
    lang: "fr",
    kind: preset?.kind ?? "article",
    embed: null,
    fetched_at: new Date().toISOString(),
  };
}

function searchResultsFor(query: string): SearchResult[] {
  const q = normalize(query);
  const disk = /disque|espace|docker|purge|stockage/.test(q);
  const base: [string, string, string, string, Preview["kind"]][] = disk
    ? [
        ["https://docs.docker.com/engine/manage-resources/pruning/", "Nettoyer les objets Docker inutilisés", "docker system prune, images orphelines, volumes non montés…", "docs.docker.com", "doc"],
        ["https://wiki.archlinux.org/title/Systemd/Journal", "Limiter la taille du journal systemd", "SystemMaxUse=, journalctl --vacuum-time=14d…", "wiki.archlinux.org", "doc"],
        ["https://unix.stackexchange.com/questions/disk-usage", "Trouver ce qui remplit un disque", "ncdu, du -xh --max-depth=1, fichiers supprimés encore ouverts (lsof +L1)…", "unix.stackexchange.com", "article"],
        ["https://github.com/bootandy/dust", "dust — un du plus lisible", "Arbre des répertoires les plus lourds, en couleur, très rapide.", "github.com", "repo"],
      ]
    : [
        [`https://fr.wikipedia.org/wiki/${encodeURIComponent(query.slice(0, 40))}`, `${capitalize(query)} — présentation`, `Vue d'ensemble de « ${query} » (démo).`, "fr.wikipedia.org", "article"],
        ["https://www.youtube.com/watch?v=demo", `${capitalize(query)} en 6 minutes`, "Vidéo explicative (démo, aucun appel au site tiers).", "youtube.com", "video"],
        ["https://github.com/search", `Dépôts autour de « ${query} »`, "Projets open source liés (démo).", "github.com", "repo"],
        ["https://news.ycombinator.com/", `Discussion : ${query}`, "Retours d'expérience et liens (démo).", "news.ycombinator.com", "article"],
      ];
  return base.map(([url, title, snippet, site, kind]) => {
    PRESETS[url] = { site_name: site, title, description: snippet, kind };
    return { url, title, snippet: `${snippet} (démo)`, site, preview: null };
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
  [/minuteur|timer|chrono/, "timer"],
  [/script|log|backup/, "script"],
  [/video|media|image/, "media"],
  [/agent|carte/, "agent_draft"],
  [/notif|message/, "notify"],
  [/monitor|surveillance|disque|gpu|cpu/, "monitor"],
];

function findBubble(state: MockState, threadId: string, term: string): Bubble | undefined {
  const n = normalize(term).replace(/^(de |du |des |la |le |les )/, "");
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
  const tr = n.match(/^(?:peux-tu |tu peux )?(envoie|envoyer|deplace|deplacer|copie|copier|partage|partager|mets|mettre)\s+(?:la |cette )?bulle\s+(.+?)\s+(?:a|vers|dans|avec|sur)\s+(?:la session |le fil |la |le |l )?(.+?)\s*[.!]?$/);
  if (tr) {
    const [, verb, term, target] = tr as unknown as [string, string, string, string];
    const bubble = findBubble(state, threadId, term);
    const dest = state.findThreadByTitle(target);
    if (!bubble) return { reply: `Je ne trouve pas de bulle « ${term} » ouverte ici.` };
    if (!dest) return { reply: `Je ne connais pas de session « ${target} ».` };
    if (/^partag/.test(verb)) {
      shareBubble(state, bubble.id, { threads: [...bubble.shared_with.threads, dest.thread.id] });
      return { reply: `Bulle « ${bubble.title} » partagée avec ${dest.thread.title} (elle reste ici, ${dest.thread.title} la voit en lecture).` };
    }
    const mode = /^cop/.test(verb) ? "copy" : "move";
    transferBubble(state, bubble.id, dest.thread.id, mode);
    return {
      reply:
        mode === "copy"
          ? `Copie de « ${bubble.title} » envoyée à ${dest.thread.title} : c'est dans son contexte maintenant.`
          : `Bulle « ${bubble.title} » déplacée vers ${dest.thread.title} : elle part de ce fil et entre dans son contexte.`,
    };
  }

  // 2) Message à une autre session : « dis à Compta que … »
  const say = n.match(/^(?:dis|ecris|demande)\s+(?:a|au|aux)\s+(?:la session |le fil )?(\S+)\s+(?:que |de )?(.+)$/);
  if (say) {
    const dest = state.findThreadByTitle(say[1]!);
    if (dest && dest.thread.id !== threadId) {
      const ask = /^demande/.test(n);
      // Texte d'origine (avec accents) : on reprend la fin du message après le nom du fil.
      const raw = text.slice(text.toLowerCase().indexOf(say[1]!.slice(0, 3)) + say[1]!.length).replace(/^\s*(que|de)\s+/i, "").trim();
      state.later(400, () => sessionMessage(state, threadId, dest.thread.id, raw || say[2]!, { ask }));
      return { reply: `Message transmis à la session ${dest.thread.title}${ask ? " ; elle va répondre ici" : ""}.` };
    }
  }

  // 2b) Page (§10) : « crée/fais une page <titre> » → bulle artifact ; « modifie la page » → version suivante.
  const pg = n.match(/^(?:peux-tu |tu peux )?(?:cree|creer|fais|faire|ecris|ecrire|genere)\s+(?:moi\s+)?(?:une?\s+)?page(?:\s+(?:web|html))?\s*(.*)$/);
  if (pg) {
    const raw = text.replace(/^.*?page(?:\s+(?:web|html))?\s*(?:de |sur |pour |:)?\s*/i, "").trim();
    const title = capitalize(raw || "Page de démo").slice(0, 60);
    const slug = normalize(title).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
    return {
      reply: `Je prépare la page « ${title} » (${slug}.html) : elle s'affiche dans la bulle, privée tant que tu ne la publies pas.`,
      after: () => void createPage(state, threadId, `${slug}.html`, title),
    };
  }
  if (/^(?:modifie|mets a jour|change|refais)\s+(?:la\s+)?page/.test(n)) {
    const page = [...state.pages.values()].filter((p) => p.thread_id === threadId).pop();
    if (!page) return { reply: "Je n'ai pas encore de page dans cette session : demande-m'en une (« crée une page … »)." };
    return { reply: `Je mets à jour « ${page.title} » : la bulle se rafraîchit toute seule.`, after: () => updatePage(state, page.id) };
  }

  // 3) Création d'agent → carte agent_draft
  if (/(cree|creer|nouvel?)\s+(un\s+)?agent/.test(n)) {
    const tail = text.replace(/^.*?agent\s*/i, "").replace(/^(qui|pour)\s+/i, "").trim();
    const role = capitalize(tail || "Assistant généraliste");
    const nm = normalize(tail);
    const name = /factur/.test(nm) ? "Relanceur factures" : /veill|surveil/.test(nm) ? "Veilleur" : /mail|courrier/.test(nm) ? "Courrier" :
      /offre|ninjob|recrut|emploi/.test(nm) ? "Chasseur d'offres" : /disque|infra|serveur/.test(nm) ? "Gardien infra" : "Nouvel agent";
    const tools = [
      ...(/factur|compta/.test(nm) ? ["erp_read", "mail_draft"] : []),
      ...(/mail|relan/.test(nm) ? ["mail_draft"] : []),
      ...(/cherch|veill|web/.test(nm) ? ["web_search"] : []),
      ...(/disque|infra|serveur/.test(nm) ? ["infra_disk_usage"] : []),
      "session_send",
    ];
    return {
      reply: "Je prépare la carte de l'agent ; vérifie-la puis active-la, elle partira dans Crew.",
      after: () => {
        const b = createBubble(state, threadId, {
          kind: "agent_draft",
          title: `Nouvel agent : ${name}`,
          status: "working",
          state: { name, role: "", model: "", tools: [], fill: 0.2 },
        });
        state.later(700, () => !b.closed_at && updateBubble(state, b.id, { state: { role, fill: 0.55 } }));
        state.later(1_400, () => !b.closed_at && updateBubble(state, b.id, { state: { model: "Apertus 70B (démo)", tools: [...new Set(tools)], fill: 0.85 } }));
        state.later(2_000, () => {
          if (b.closed_at) return;
          b.actions = [{ id: "activate", label: "Activer l'agent", primary: true }];
          updateBubble(state, b.id, { state: { fill: 1 }, status: "idle" });
        });
      },
    };
  }

  // 4) Recherche web → bulle search + aperçus après coup
  const search = text.match(/^\s*(?:cherche|recherche|trouve)(?:-moi)?\s+(.+?)\s*\??$/i);
  if (search) {
    const query = search[1]!;
    return {
      reply: `Je cherche « ${query} » — les sources arrivent dans la bulle violette, avec leur aperçu.`,
      after: () => {
        const results = searchResultsFor(query);
        const call_id = hexId("call");
        const t0 = Date.now();
        state.publish({ type: "tool.call", thread_id: threadId, turn_id: turn.turnId, call_id, name: "web_search", args_preview: JSON.stringify({ q: query }).slice(0, 200) });
        const b = createBubble(state, threadId, {
          kind: "search",
          title: capitalize(query).slice(0, 60),
          status: "working",
          state: { query, took_ms: 0, engines: ["démo"], results: results.map((r) => ({ ...r })) },
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
  if (/disque|espace disque|stockage|\bdf\b/.test(n)) {
    return {
      reply: "Je regarde le disque de host-1 (démo) — la bulle cyan respire tant que la mesure tourne.",
      after: () => {
        const t0 = Date.now();
        const values = [84, 86.5, 88, 89.6, 90.7, 91.2, 91.3];
        const b = createBubble(state, threadId, {
          kind: "monitor",
          title: "Disque host-1 /",
          status: "working",
          state: { target: "host-1:/ (démo)", metric: "disk_used", value: values[0]!, unit: "%", max: 100, series: [[t0, values[0]!]], items: [] },
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
          b.actions = [{ id: "purge", label: "Proposer une purge", primary: true }];
          updateBubble(state, b.id, {
            title: "Disque host-1 / — 91 % (stable)",
            status: "done",
            state: {
              items: [
                { label: "/var/lib/docker", value: "412 Go" },
                { label: "/mnt/share", value: "238 Go" },
                { label: "/var/log/journal", value: "19 Go" },
              ],
            },
          });
        });
      },
    };
  }

  // 6) Minuteur
  const timer = n.match(/(?:timer|minuteur|chrono)\s*(?:de\s*)?(\d+)?\s*(s|sec|secondes?|min|minutes?|h|heures?)?/);
  if (timer) {
    const qty = Number(timer[1] ?? 5);
    const unit = timer[2] ?? "min";
    const ms = /^s/.test(unit) ? qty * 1000 : /^h/.test(unit) ? qty * 3600_000 : qty * 60_000;
    const label = `${qty} ${/^s/.test(unit) ? "s" : /^h/.test(unit) ? "h" : "min"}`;
    return {
      reply: `Minuteur de ${label} posé.`,
      after: () => {
        const started = new Date();
        const b = createBubble(state, threadId, {
          kind: "timer",
          title: `Minuteur ${label}`,
          status: "working",
          created_by: MOCK_USER,
          state: { label: `Minuteur ${label}`, started_at: started.toISOString(), ends_at: new Date(started.getTime() + ms).toISOString() },
        });
        state.later(ms, () => !b.closed_at && updateBubble(state, b.id, { status: "done" }));
      },
    };
  }

  // 7) Script
  if (/\blance\b|script|backup|sauvegarde/.test(n)) {
    return {
      reply: "Je lance le backup sur host-1 (démo) ; la queue du log défile dans la bulle bleue.",
      after: () => {
        const lines = [
          "démo — open repository",
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
          title: "Backup host-1 (à la demande)",
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
  if (/video|media|apercu|teaser|montre/.test(n)) {
    return {
      reply: "Voilà l'aperçu du teaser (démo).",
      after: () => {
        const url = "https://nokker.ai/demo/teaser.mp4";
        PRESETS[url] = { site_name: "nokker.ai", title: "Teaser Nokker — Knocks for you", description: "Montage de 42 s (démo).", kind: "video" };
        const p = fakePreview(url);
        createBubble(state, threadId, {
          kind: "media",
          title: "Teaser Nokker (42 s)",
          status: "idle",
          state: { url, mime: "video/mp4", poster: p.image, preview: p },
        });
      },
    };
  }

  // 9) Démo d'approbation historique (CLIENT-API.md) — « envoie … »
  if (/envoie/.test(n)) {
    return {
      reply:
        "Je prépare l'action mais j'ai besoin de ton approbation avant d'envoyer quoi que ce soit à l'extérieur — " +
        "carte envoyée, approuve-la (ou refuse) pour que je continue.",
      triggersApproval: true,
    };
  }

  // 10) Réponse par défaut : montre que le contexte reçu (bulle, message de session) est pris en compte — le
  // noyau l'injecte dans l'entrée du tour (`[Contexte reçu]…[/Contexte]`), le mock le cite dans la réponse.
  if (turn.context.length) {
    return { reply: `Bien reçu — j'ai maintenant en contexte : ${turn.context.map((c) => c.slice(0, 160)).join(" ; ")}` };
  }
  return { reply: `Nina (démo) a reçu : « ${text} ». Réponse simulée, aucun outil appelé.` };
}

export { hexId };
