/**
 * Le Guide (core docs/GUIDE.md, flag `guide`; off → 404). The core sends CODES only (ids, statuses, screens, ui targets,
 * numbers): the client words them. `reply` is the one free text (the model's answer), shown as text, never as HTML.
 *
 *   GET  /v1/guide        → GuideView
 *   POST /v1/guide/intro  → { seen: true }
 *   POST /v1/guide/ask    → GuideAnswer   (400 empty, 429 guide_quota, 503 guide_model_missing)
 */

export type GuideProfile = "solo" | "household" | "lokkal";
export type GuideStatus = "on" | "setup" | "off" | "not_for_you";

export interface GuideFeature {
  id: string;
  status: GuideStatus;
  /** Uses counted by the core (a number, never content). */
  used: number;
  /** A `ViewId` of the web: deep link. */
  screen?: string;
  /** Interface element a « show me » can point at. */
  ui?: string;
  /** Command to type (`/goal`, `nokker import`). */
  command?: string;
}

export interface GuideView {
  profile: GuideProfile;
  show_me: boolean;
  features: GuideFeature[];
  intro: { seen: boolean; picks: string[] };
  next: string | null;
  catalog_tokens: number;
}

export type GuideAskFeature = Omit<GuideFeature, "used">;

export interface GuideTurn {
  role: "user" | "assistant";
  content: string;
}

export interface GuideAnswer {
  reply: string;
  features: GuideAskFeature[];
  point: { ui: string; feature: string } | null;
}
