/** `/model` (ticket T2) : liste des modèles de la machine, choix par nom, carte de confirmation, en-tête. */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { LocalSetup } from "@nokker-apps/sdk";
import { formatModels, headerModel, modelChoices, noModelSet, pickModel } from "../src/models.js";
import { parseSlashCommand, helpText } from "../src/commands.js";
import { ConfirmCard } from "../src/ui/ConfirmCard.js";
import { Header } from "../src/ui/Header.js";
import { setLang } from "../src/i18n/index.js";

const setup = (over: Partial<LocalSetup> = {}): LocalSetup => ({
  done: true,
  models: {
    router: { linked: true, account: "alice@example.com", model: "qwen/qwen3.5-397b-a17b" },
    byok: [
      { name: "own", base_url: "https://api.example.com/v1", model: "qwen3.8-27b", ok: true, has_key: true },
      { name: "spare", base_url: "https://spare.example.com/v1", model: null, ok: null, has_key: true },
    ],
    local: [{ runtime: "ollama", url: "http://host.docker.internal:11434", models: ["qwen3:8b"] }],
  },
  default: "byok:own",
  connectors: [],
  channels: [],
  ...over,
});

describe("/model", () => {
  it("dans l'aide et reconnu (plus de « Commande inconnue »)", () => {
    expect(helpText()).toContain("/model [name]");
    expect(parseSlashCommand("/model").kind).toBe("model");
  });

  it("liste le routeur, les entrées byok, les modèles locaux et le défaut", () => {
    const ids = modelChoices(setup()).map((c) => [c.id, c.usable, c.isDefault]);
    expect(ids).toEqual([
      ["router", true, false],
      ["byok:own", true, true],
      ["byok:spare", false, false],
      ["local:http://host.docker.internal:11434|qwen3:8b", true, false],
    ]);
    const text = formatModels(setup());
    expect(text).toContain("router (qwen/qwen3.5-397b-a17b)");
    expect(text).toMatch(/› byok:own \(qwen3\.8-27b\)\s+← default/);
    expect(text).toContain("byok:spare  (no model chosen on this endpoint)");
    expect(text).toContain("local qwen3:8b");
    expect(text).toContain("Default: byok:own.");
    expect(text).toContain("changes the default of the whole machine, after a confirmation");
  });

  it("choix par id ou par nom court ; inconnu, inutilisable", () => {
    expect(pickModel(setup(), "router")).toMatchObject({ kind: "ok", choice: { id: "router" } });
    expect(pickModel(setup(), "own")).toMatchObject({ kind: "ok", choice: { id: "byok:own" } });
    expect(pickModel(setup(), "qwen3:8b")).toMatchObject({ kind: "ok", choice: { kind: "local" } });
    expect(pickModel(setup(), "nope")).toEqual({ kind: "none", query: "nope" });
    expect(pickModel(setup(), "spare").kind).toBe("unusable");
    expect(pickModel(setup({ models: { ...setup().models, router: { linked: false } } }), "router").kind).toBe("unusable");
  });

  it("en-tête : le défaut de la machine, sinon « routage auto »", () => {
    expect(headerModel(setup())).toBe("byok:own · qwen3.8-27b");
    expect(headerModel(setup({ default: "router" }))).toBe("qwen/qwen3.5-397b-a17b");
    expect(headerModel(setup({ default: null }))).toBeNull();
    expect(render(<Header threadLabel="th_1" folder="calc" status="ok" model="byok:own · qwen3.8-27b" />).lastFrame()).toContain("model: byok:own · qwen3.8-27b");
    expect(render(<Header threadLabel="th_1" folder="calc" status="ok" />).lastFrame()).toContain("model: auto routing");
  });

  it("premier lancement : « aucun modèle réglé » seulement si le réglage est lu, sans défaut et sans Router relié", () => {
    expect(noModelSet(setup({ default: null, models: { ...setup().models, router: { linked: false } } }))).toBe(true);
    expect(noModelSet(setup({ default: null, models: { ...setup().models, router: { linked: true, model: "m" } } }))).toBe(false); // relié : les paliers servent
    expect(noModelSet(setup({ default: "router" }))).toBe(false);
    expect(noModelSet(null)).toBe(false); // réglage illisible : on ne l'affirme pas
    expect(render(<Header threadLabel="th_1" folder="calc" status="ok" noModel />).lastFrame()).toContain("no model set");
    expect(render(<Header threadLabel="th_1" folder="calc" status="ok" noModel />).lastFrame()).not.toContain("auto routing");
  });

  it("carte de confirmation : dit que c'est TOUTE la machine ; Entrée ne confirme pas, y oui, n non", async () => {
    const onAnswer = vi.fn();
    const req = { kind: "model" as const, id: "router", title: "router (qwen/qwen3.5-397b-a17b)", current: "byok:own (qwen3.8-27b)" };
    const r = render(<ConfirmCard request={req} busy={false} message={null} onAnswer={onAnswer} />);
    expect(r.lastFrame()).toContain("Change the default model of this machine?");
    expect(r.lastFrame()).toContain("byok:own (qwen3.8-27b) → router (qwen/qwen3.5-397b-a17b)");
    expect(r.lastFrame()).toContain("Every session and every thread of this machine");
    await new Promise((res) => setTimeout(res, 600));
    r.stdin.write("\r");
    await new Promise((res) => setTimeout(res, 30));
    expect(onAnswer).not.toHaveBeenCalled();
    r.stdin.write("y");
    await new Promise((res) => setTimeout(res, 30));
    expect(onAnswer).toHaveBeenCalledWith(true);
    setLang("fr");
    try {
      const f = render(<ConfirmCard request={req} busy={false} message={null} onAnswer={() => {}} />).lastFrame()!;
      expect(f).toContain("Changer le modèle par défaut de cette machine ?");
      expect(formatModels(setup())).toContain("Modèles de cette machine :");
    } finally {
      setLang("en");
    }
  });
});
