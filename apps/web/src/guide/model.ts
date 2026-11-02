/**
 * Le Guide (core docs/GUIDE.md) — view model. Build flag `VITE_NOKKER_GUIDE=1`, OFF by default: off, no request to
 * `/v1/guide` is ever made, no « Discover » entry exists and `/guide` in the composer is an ordinary message. The core
 * sends CODES only (ids, statuses, `screen`, `ui`, `command`): the words come from `texts.ts` (fr/en) and `tr()`.
 * `reply` is the one free text; it is shown as text, never as HTML.
 */
import { NokkerApiError, type GuideAnswer, type GuideAskFeature, type GuideFeature, type GuideStatus, type GuideTurn } from "@nokker-apps/sdk";
import { shellLang, tr, type Lang } from "../i18n/index.js";
import { GUIDE_TEXTS, type GuideText } from "./texts.js";

let flag: boolean = import.meta.env?.VITE_NOKKER_GUIDE === "1";

export function guideEnabled(): boolean {
  return flag;
}

/** Tests only. */
export function setGuideForTests(on: boolean): void {
  flag = on;
}

/** Words of a feature in a language. An id the web does not know (a newer core) shows its id, with no sentence. */
export function featureText(id: string, lang: Lang = shellLang()): GuideText {
  const t = GUIDE_TEXTS[id];
  return t ? t[lang === "fr" ? "fr" : "en"] : { name: id, purpose: "", how: "" };
}

export function statusLabel(s: GuideStatus): string {
  switch (s) {
    case "on":
      return tr("Available");
    case "setup":
      return tr("To set up");
    case "off":
      return tr("Not available here yet");
    default:
      return tr("Not for this profile");
  }
}

/** « What I can do », grouped by status; `not_for_you` is left out of the list (it is not an offer). */
export const LIST_GROUPS: Array<{ status: GuideStatus; title: (n: number) => string }> = [
  { status: "on", title: (n) => tr("Available · {0}", n) },
  { status: "setup", title: (n) => tr("To set up · {0}", n) },
  { status: "off", title: (n) => tr("Not available here yet · {0}", n) },
];

export function groupedFeatures(features: readonly GuideFeature[]): Array<{ status: GuideStatus; title: string; features: GuideFeature[] }> {
  return LIST_GROUPS.map((g) => {
    const list = features.filter((f) => f.status === g.status);
    return { status: g.status, title: g.title(list.length), features: list };
  }).filter((g) => g.features.length > 0);
}

/** The cards of the welcome tour: the picks, in the core's order, that the catalogue knows. */
export function introPicks(picks: readonly string[], features: readonly GuideFeature[]): GuideFeature[] {
  return picks.flatMap((id) => features.filter((f) => f.id === id)).slice(0, 3);
}

/** Only an offer is actionable: a feature that is off or not for the profile NEVER gets a button, whatever the core sent. */
export function actionable(f: Pick<GuideAskFeature, "status">): boolean {
  return f.status === "on" || f.status === "setup";
}

/** « Open »: the feature has a screen the web serves (`chat` is always served). */
export function canOpenScreen(f: Pick<GuideAskFeature, "status" | "screen">, served: readonly string[]): boolean {
  return actionable(f) && !!f.screen && (f.screen === "chat" || served.includes(f.screen));
}

/** « Show me »: the core gave a target (it does so only with its `show_me` flag), the web's flag is on, the feature is an offer. */
export function canShowMe(f: Pick<GuideAskFeature, "status" | "ui">, view: { show_me: boolean }, webShowMe: boolean): boolean {
  return actionable(f) && !!f.ui && view.show_me && webShowMe;
}

export function usageText(used: number): string {
  if (used <= 0) return tr("never used");
  return used === 1 ? tr("used once") : tr("used {0} times", used);
}

/** `/guide` or `/guide <question>` typed in the composer: handled here, never sent to the model. */
export function parseGuideCommand(text: string): { question: string } | null {
  const m = /^\/guide(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? { question: (m[1] ?? "").trim() } : null;
}

export const HISTORY_MAX = 6;

export interface GuideMessage {
  role: "user" | "assistant";
  text: string;
  /** Cards of the features an answer cites. */
  features?: GuideAskFeature[];
}

/** The last six messages as the core wants them (`history`). */
export function historyOf(messages: readonly GuideMessage[]): GuideTurn[] {
  return messages.slice(-HISTORY_MAX).map((m) => ({ role: m.role, content: m.text }));
}

export function withAnswer(messages: readonly GuideMessage[], question: string, a: GuideAnswer): GuideMessage[] {
  const added: GuideMessage[] = [{ role: "user", text: question }, { role: "assistant", text: a.reply, features: a.features }];
  return [...messages, ...added].slice(-HISTORY_MAX);
}

/** A translated message for a failed question (never the core's wording). */
export function askErrorText(e: unknown): string {
  const status = e instanceof NokkerApiError ? e.status : 0;
  if (status === 429) return tr("You have asked a lot today: the Guide will answer again tomorrow.");
  if (status === 503) return tr("The Guide has no model available right now.");
  if (status === 400) return tr("Write a question first.");
  return tr("The Guide could not answer. Try again in a moment.");
}
