/**
 * « Show me » mode — mock of core docs/SHOW-ME.md (flag `show_me`, off by default like the core: option `showMe` or
 * `MOCK_SHOW_ME=1`). ONE open `pointer` bubble per thread, updated at each step. Answers `done` / `lost` are a turn of
 * the thread (202 `{accepted, thread_id, closed}`); before it the state goes `waiting: true` (or the bubble closes on
 * the last announced step), then « Nina » posts the next step.
 */
import type { Bubble, PointerState, PointerTarget } from "@nokker-apps/sdk";
import { closeBubble, createBubble, registerAction, registerActionPrelude, updateBubble } from "./bubbles.js";
import type { MockState } from "./state.js";

const ACTIONS = [
  { id: "done", label: "Fait", primary: true },
  { id: "lost", label: "Je ne trouve pas" },
];

interface Step {
  target: PointerTarget;
  caption: string;
}

/** Guide of each pointer bubble (mock only: the core asks the model for the next step). */
const guides = new Map<string, Step[]>();
const french = new Set<string>();

function title(step: number, steps: number): string {
  return steps > 1 ? `Étape ${step} sur ${steps}` : "Repère";
}

function stateOf(steps: Step[], i: number): PointerState {
  const many = steps.length > 1;
  return { target: steps[i]!.target, caption: steps[i]!.caption, step: many ? i + 1 : null, steps: many ? steps.length : null, waiting: false, answer: null };
}

/** Latest image attached to the thread (newest turn first), as the core's `image: 1`. */
function latestImage(state: MockState, threadId: string): { sha256: string; media_type: string; name: string } | null {
  const turns = state.threads.get(threadId)?.turns ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const imgs = turns[i]!.images ?? [];
    const im = imgs[imgs.length - 1];
    if (im) return { sha256: im.sha256, media_type: im.media_type, name: im.name ?? "" };
  }
  return null;
}

/** « show me how to attach » → two steps on the interface; « show me on the screenshot » → one step on the last image. */
export function startGuide(state: MockState, threadId: string, onImage: boolean, fr = false): Bubble | null {
  let steps: Step[];
  if (onImage) {
    const img = latestImage(state, threadId);
    if (!img) return null;
    steps = [{ target: { kind: "image", ...img, x: 72, y: 18 }, caption: fr ? "Clique sur ce bouton" : "Click this button" }];
  } else {
    steps = [
      { target: { kind: "ui", ui: "attach" }, caption: fr ? "Clique sur le trombone pour joindre ton PDF" : "Click the paperclip to attach your PDF" },
      { target: { kind: "ui", ui: "send" }, caption: fr ? "Puis envoie ton message" : "Then send your message" },
    ];
  }
  const open = [...state.bubbles.values()].find((b) => b.kind === "pointer" && b.thread_id === threadId && !b.closed_at);
  if (open) {
    guides.set(open.id, steps);
    if (fr) french.add(open.id);
    updateBubble(state, open.id, { title: title(1, steps.length), state: stateOf(steps, 0) as unknown as Record<string, unknown>, status: "idle" });
    return state.bubbles.get(open.id) ?? null;
  }
  const b = createBubble(state, threadId, { kind: "pointer", title: title(1, steps.length), state: stateOf(steps, 0), status: "idle", actions: ACTIONS });
  guides.set(b.id, steps);
  if (fr) french.add(b.id);
  return b;
}

function isLast(b: Bubble): boolean {
  if (b.kind !== "pointer") return false;
  return b.state.steps !== null && b.state.step === b.state.steps;
}

registerActionPrelude("pointer", (state, b, actionId) => {
  if (b.kind !== "pointer") return {};
  const last = actionId === "done" && isLast(b);
  if (last) closeBubble(state, b.id);
  else updateBubble(state, b.id, { state: { waiting: true, answer: actionId } });
  return { closed: last };
});

registerAction("pointer:done", (state, b) => {
  if (b.kind !== "pointer") return "Noted.";
  const steps = guides.get(b.id) ?? [];
  const i = (b.state.step ?? 1) - 1;
  const fr = french.has(b.id);
  if (b.state.steps === null || i + 1 >= steps.length) return fr ? "Bravo, c'est fait." : "Well done, that's it.";
  updateBubble(state, b.id, { title: title(i + 2, steps.length), state: stateOf(steps, i + 1) as unknown as Record<string, unknown>, status: "idle" });
  return fr ? `Bien. Étape ${i + 2} : ${steps[i + 1]!.caption.toLowerCase()}.` : `Good. Step ${i + 2}: ${steps[i + 1]!.caption.toLowerCase()}.`;
});

registerAction("pointer:lost", (state, b) => {
  if (b.kind !== "pointer") return "Noted.";
  updateBubble(state, b.id, { state: { waiting: false, answer: null } });
  return french.has(b.id) ? "Regarde où pointe la flèche : elle est en surbrillance sur ton écran." : "Look where the arrow points: it is highlighted on your screen.";
});
