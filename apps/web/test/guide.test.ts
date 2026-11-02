import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { NokkerApiError, type GuideFeature } from "@nokker-apps/sdk";
import { setShellLang } from "../src/i18n/index.js";
import { CapabilityList, Cards, FeatureCard, type CardEnv } from "../src/guide/GuideCards.js";
import {
  HISTORY_MAX,
  actionable,
  askErrorText,
  canOpenScreen,
  canShowMe,
  featureText,
  groupedFeatures,
  guideEnabled,
  historyOf,
  introPicks,
  parseGuideCommand,
  setGuideForTests,
  statusLabel,
  usageText,
  withAnswer,
  type GuideMessage,
} from "../src/guide/model.js";
import { GUIDE_IDS, GUIDE_TEXTS } from "../src/guide/texts.js";
import { clearLocalPoint, getLocalPoint, pointLocally } from "../src/showme/local.js";

afterEach(() => {
  setShellLang(null);
  setGuideForTests(false);
  clearLocalPoint();
});

const f = (id: string, status: GuideFeature["status"], extra: Partial<GuideFeature> = {}): GuideFeature => ({ id, status, used: 0, ...extra });
const env = (extra: Partial<CardEnv> = {}): CardEnv => ({ served: ["crew", "account"], coreShowMe: true, webShowMe: true, onOpen: () => undefined, onShowMe: () => undefined, ...extra });

describe("Guide — flag and words", () => {
  it("off by default", () => {
    expect(guideEnabled()).toBe(false);
    setGuideForTests(true);
    expect(guideEnabled()).toBe(true);
  });
  it("the core catalogue has 53 ids, each with a French AND an English name, sentence and gesture", () => {
    expect(GUIDE_IDS).toHaveLength(53);
    expect(new Set(GUIDE_IDS).size).toBe(53);
    for (const id of GUIDE_IDS) {
      const t = GUIDE_TEXTS[id];
      expect(t, id).toBeTruthy();
      for (const lang of ["fr", "en"] as const) {
        expect(t![lang].name.trim(), `${id} ${lang} name`).not.toBe("");
        expect(t![lang].purpose.trim(), `${id} ${lang} purpose`).not.toBe("");
        expect(t![lang].how.trim(), `${id} ${lang} how`).not.toBe("");
      }
      expect(t!.fr.purpose, id).not.toBe(t!.en.purpose);
    }
    expect(Object.keys(GUIDE_TEXTS).sort()).toEqual([...GUIDE_IDS].sort());
  });
  it("words follow the interface language; an unknown id shows its code", () => {
    setShellLang("fr");
    expect(featureText("crew").name).toBe("Crew (agents récurrents)");
    expect(statusLabel("setup")).toBe("À activer");
    expect(statusLabel("off")).toBe("Pas encore disponible ici");
    setShellLang("en");
    expect(featureText("crew").name).toBe("Crew (recurring agents)");
    expect(statusLabel("setup")).toBe("To set up");
    expect(featureText("future_thing")).toEqual({ name: "future_thing", purpose: "", how: "" });
    expect(usageText(0)).toBe("never used");
    expect(usageText(3)).toBe("used 3 times");
  });
});

describe("Guide — what may be offered", () => {
  it("off and not_for_you are never actionable, whatever the core sends", () => {
    expect(actionable({ status: "on" })).toBe(true);
    expect(actionable({ status: "setup" })).toBe(true);
    expect(actionable({ status: "off" })).toBe(false);
    expect(actionable({ status: "not_for_you" })).toBe(false);
    expect(canOpenScreen({ status: "off", screen: "crew" }, ["crew"])).toBe(false);
    expect(canShowMe({ status: "not_for_you", ui: "attach" }, { show_me: true }, true)).toBe(false);
  });
  it("Open: only a served screen (chat is always served)", () => {
    expect(canOpenScreen({ status: "on", screen: "crew" }, ["crew"])).toBe(true);
    expect(canOpenScreen({ status: "on", screen: "plan" }, ["crew"])).toBe(false);
    expect(canOpenScreen({ status: "on", screen: "chat" }, [])).toBe(true);
    expect(canOpenScreen({ status: "on" }, ["crew"])).toBe(false);
  });
  it("Show me: needs a ui, the core's show_me and the web flag", () => {
    expect(canShowMe({ status: "on", ui: "attach" }, { show_me: true }, true)).toBe(true);
    expect(canShowMe({ status: "on", ui: "attach" }, { show_me: false }, true)).toBe(false);
    expect(canShowMe({ status: "on", ui: "attach" }, { show_me: true }, false)).toBe(false);
    expect(canShowMe({ status: "on" }, { show_me: true }, true)).toBe(false);
  });
  it("groups by status in the order available, to set up, not available; not_for_you is not listed", () => {
    setShellLang("en");
    const g = groupedFeatures([f("a", "off"), f("b", "on"), f("c", "not_for_you"), f("d", "setup"), f("e", "on")]);
    expect(g.map((x) => x.status)).toEqual(["on", "setup", "off"]);
    expect(g[0]!.title).toBe("Available · 2");
    expect(g[0]!.features.map((x) => x.id)).toEqual(["b", "e"]);
  });
  it("the tour keeps the picks in order, three at most, known ones only", () => {
    const feats = [f("a", "on"), f("b", "on"), f("c", "on"), f("d", "on")];
    expect(introPicks(["c", "zz", "a", "b", "d"], feats).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });
});

describe("Guide — /guide and history", () => {
  it("parses /guide with or without a question, not other text", () => {
    expect(parseGuideCommand("/guide")).toEqual({ question: "" });
    expect(parseGuideCommand("  /guide  ")).toEqual({ question: "" });
    expect(parseGuideCommand("/GUIDE comment joindre un PDF ?")).toEqual({ question: "comment joindre un PDF ?" });
    expect(parseGuideCommand("/guidebook")).toBeNull();
    expect(parseGuideCommand("lis /guide")).toBeNull();
    expect(parseGuideCommand("/goal x")).toBeNull();
  });
  it("keeps six messages and sends them as history", () => {
    let m: GuideMessage[] = [];
    for (let i = 0; i < 5; i++) m = withAnswer(m, `q${i}`, { reply: `r${i}`, features: [], point: null });
    expect(m).toHaveLength(HISTORY_MAX);
    expect(historyOf(m)[0]).toEqual({ role: "user", content: "q2" });
    expect(historyOf(m).at(-1)).toEqual({ role: "assistant", content: "r4" });
  });
  it("translated errors for 429 and 503", () => {
    setShellLang("en");
    expect(askErrorText(new NokkerApiError("x", 429, {}))).toMatch(/asked a lot/);
    expect(askErrorText(new NokkerApiError("x", 503, {}))).toMatch(/no model/);
    expect(askErrorText(new Error("boom"))).toMatch(/could not answer/);
  });
});

describe("Guide — cards", () => {
  it("an available feature: name, sentence, Open and Show me, command as code; texts are escaped", () => {
    setShellLang("en");
    const html = renderToStaticMarkup(React.createElement(FeatureCard, { f: { id: "goals", status: "on", screen: "crew", ui: "composer", command: "/goal" }, env: env(), used: 2 }));
    expect(html).toContain("Goals");
    expect(html).toContain("<code>/goal</code>");
    expect(html).toContain(">Open<");
    expect(html).toContain("Show me");
    expect(html).toContain("used 2 times");
  });
  it("a feature to set up shows its gesture; off and not_for_you show no button and no command", () => {
    setShellLang("fr");
    const setup = renderToStaticMarkup(React.createElement(FeatureCard, { f: { id: "telegram", status: "setup", screen: "account" }, env: env() }));
    expect(setup).toContain("À activer");
    expect(setup).toContain("Pour l&#x27;activer");
    expect(setup).toContain("Ouvrir");
    for (const status of ["off", "not_for_you"] as const) {
      const html = renderToStaticMarkup(React.createElement(FeatureCard, { f: { id: "slack", status, screen: "account", ui: "account", command: "/x" }, env: env() }));
      expect(html).not.toContain("<button");
      expect(html).not.toContain("<code>");
      expect(html).not.toContain("guide-how");
    }
  });
  it("no Open button when the screen is not served; no Show me without the flags", () => {
    setShellLang("en");
    const html = renderToStaticMarkup(React.createElement(FeatureCard, { f: { id: "plan", status: "on", screen: "plan", ui: "composer" }, env: env({ coreShowMe: false }) }));
    expect(html).not.toContain("<button");
  });
  it("the list shows the three groups", () => {
    setShellLang("en");
    const html = renderToStaticMarkup(React.createElement(CapabilityList, { features: [f("crew", "on", { screen: "crew" }), f("telegram", "setup"), f("slack", "off"), f("household_minors", "not_for_you")], env: env() }));
    expect(html).toContain('data-group="on"');
    expect(html).toContain('data-group="setup"');
    expect(html).toContain('data-group="off"');
    expect(html).not.toContain("Child profiles");
    expect(renderToStaticMarkup(React.createElement(Cards, { features: [], env: env() }))).toContain("guide-cards");
  });
});

describe("local pointing (Show me from the Guide)", () => {
  it("points, replaces, clears", () => {
    expect(getLocalPoint()).toBeNull();
    pointLocally("attach");
    const a = getLocalPoint()!;
    expect(a.ui).toBe("attach");
    pointLocally("send");
    expect(getLocalPoint()!.n).toBeGreaterThan(a.n);
    clearLocalPoint();
    expect(getLocalPoint()).toBeNull();
  });
});
