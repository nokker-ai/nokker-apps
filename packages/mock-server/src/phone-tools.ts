/**
 * Outils du nœud téléphone (P7b, faux noyau de `nokker/cloud/phone_tools.py`).
 *
 * Tour de démo « lis le texte de l'image » (tour ouvert par la personne) : la dernière image du fil part au téléphone
 * placé par capacité (`ocr` à `on`, en charge, Wi-Fi, nom), `ocr.image {image_url}` avec un blob signé pour LUI. Attente
 * `NOKKER_MOCK_PHONE_WAIT_MS` (20 s par défaut, comme le noyau) ; au-delà, le message assistant porte `phone_tasks` et,
 * à la clôture (fait, échec, expiration), le faux noyau écrit un tour de suite (`origin: "phone_continue"`, jamais
 * rendu par le client). Une tâche annulée n'en produit pas.
 */
import type { PhoneTaskNote } from "@nokker-apps/sdk";
import type { MockState } from "./state.js";
import { enqueuePhoneTask, mediaUrl, phoneMock, placeNode, type Task } from "./phone.js";

const OP_LABELS: Record<string, string> = { "zone.state": "état de zone", "ocr.image": "texte d'une image", "stt.audio": "transcription", "calendar.list": "agenda" };
const OCR_DEADLINE_MS = 600_000;
const waitMs = (): number => Math.max(50, Number(process.env.NOKKER_MOCK_PHONE_WAIT_MS) || 20_000);
const settledOf = (t: Task): boolean => !(t.status === "queued" || t.status === "leased");

async function settle(t: Task, ms: number): Promise<Task> {
  const end = Date.now() + ms;
  while (Date.now() < end && !settledOf(t)) await new Promise((r) => setTimeout(r, 50));
  if (!settledOf(t) && Date.now() > t.deadline) t.status = "expired";
  return t;
}

function resultLine(t: Task, name: string): string {
  const op = OP_LABELS[t.op] ?? t.op;
  if (t.status === "done") {
    let text = "";
    try {
      text = String((JSON.parse(t.result ?? "{}") as { text?: unknown }).text ?? "");
    } catch {
      return `(demo) « ${op} » n'a pas abouti sur le téléphone « ${name} » (réponse illisible du téléphone).`;
    }
    return text.trim() ? `(demo) Texte lu par le téléphone « ${name} » : ${text.slice(0, 400)}` : `(demo) Le téléphone « ${name} » n'a trouvé aucun texte dans l'image.`;
  }
  if (t.status === "failed") return `(demo) « ${op} » n'a pas abouti sur le téléphone « ${name} » (${t.error?.code ?? "raison non précisée"}).`;
  return `(demo) « ${op} » a expiré sans réponse du téléphone « ${name} ».`;
}

/**
 * Rend la réponse du tour et les `phone_tasks` à poser sur le message assistant, ou null si le texte n'est pas une
 * demande de lecture d'image. `pending` (même objet que celui du message) se met à jour à la clôture.
 */
export async function demoOcrImage(
  state: MockState,
  user: string,
  threadId: string,
  hostHeader: string,
  text: string,
  turnImages: { sha256: string; media_type: string }[],
): Promise<{ reply: string; tasks?: PhoneTaskNote[] } | null> {
  if (!/^\s*(?:lis le texte de l'image|read the text in the image)\s*\.?\s*$/i.test(text)) return null;
  if (!phoneMock(state).flags.phone_nodes) return { reply: "(demo) Image text reading is not available." };
  const rec = state.threads.get(threadId);
  const imgs = [...(rec?.turns.flatMap((t) => t.images ?? []) ?? []), ...turnImages];
  const img = imgs.at(-1);
  if (!img) return { reply: "(demo) ocr_no_image : aucune image au rang 1 dans cette conversation ; rien n'a été lu." };
  const node = placeNode(state, user, "ocr");
  if (!node) return { reply: "(demo) phone_unavailable : aucun téléphone de la personne avec « lecture de texte » n'est en ligne ; rien n'a été lu." };
  const bytes = state.images.get(img.sha256);
  if (!bytes) return { reply: "(demo) ocr_no_image : image introuvable." };
  const t = enqueuePhoneTask(state, node.id, "ocr.image", { image_url: mediaUrl(state, node.id, bytes.media_type, bytes.bytes, hostHeader) }, { kind: "turn", thread_id: threadId, turn_index: rec?.turns.length ?? 0 });
  t.deadline = Date.now() + OCR_DEADLINE_MS;
  await settle(t, waitMs());
  if (settledOf(t)) return { reply: resultLine(t, node.name) };
  const note: PhoneTaskNote = { task_id: t.id, op: "ocr.image", machine_id: node.id, name: node.name, status: "pending" };
  void (async () => {
    await settle(t, Math.max(1000, t.deadline - Date.now() + 5000));
    note.status = t.status === "done" || t.status === "failed" || t.status === "cancelled" ? t.status : "expired";
    if (note.status === "cancelled") return state.publishThread(threadId);
    const op = OP_LABELS["ocr.image"];
    const head =
      note.status === "done"
        ? `[Téléphone] Résultat de « ${op} » envoyé par le téléphone « ${node.name} » :`
        : note.status === "failed"
          ? `[Téléphone] « ${op} » n'a pas abouti sur le téléphone « ${node.name} » ; rien n'a été lu.`
          : `[Téléphone] « ${op} » a expiré sans réponse du téléphone « ${node.name} » ; rien n'a été lu.`;
    state.appendTurn(threadId, head, resultLine(t, node.name), { sender: user, origin: "phone_continue" });
    state.publishThread(threadId);
  })();
  return { reply: `(demo) phone_pending : « ${OP_LABELS["ocr.image"]} » attend le téléphone « ${node.name} » ; la lecture est en cours.`, tasks: [note] };
}
