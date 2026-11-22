import { afterEach, describe, expect, it } from "vitest";
import { localChoices, type Approval } from "@nokker-apps/sdk";
import { approvalTarget, choiceLabel } from "../src/approval-model.js";
import { setWorkspaceView } from "../src/toolview.js";
import { setLang } from "../src/i18n/index.js";

const card = (over: Partial<Approval> = {}): Approval => ({
  id: "appr_1", thread_id: "th_1", turn_index: 0, channel: "cli", tool_name: "terminal", arguments: { command: "cd /workspace && python -m pytest -q" },
  args_sha256: "", effect: "write", rule: "effect:write", reason: "r", advice: null, strength: "standard", status: "pending",
  created_at: "", expires_at: new Date(Date.now() + 300_000).toISOString(), decided_by: null, decided_via: null, decided_at: null,
  result_summary: null, error: null, suggested_rules: ["terminal(cd /workspace && python -m pytest -q)", "terminal(cd /workspace*)"],
  suggested_rule_kinds: ["exact", "prefix"], ...over,
});

afterEach(() => {
  setWorkspaceView(null);
  setLang("en");
});

describe("carte : la commande et le libellé de la règle disent le même chemin", () => {
  it("le montage du bac est réécrit dans les deux ; la règle envoyée au noyau reste brute", () => {
    setWorkspaceView("/srv/projets/calc"); // dossier de la session, montage par défaut /workspace
    const a = card();
    expect(approvalTarget(a)).toBe("cd /srv/projets/calc && python -m pytest -q");
    const choices = localChoices(a);
    // « Toujours » : le choix dont la règle est un préfixe (3b) ; la première règle proposée est la commande exacte.
    const always = choices.find((c) => c.id === "always" && c.ruleKind === "prefix")!;
    expect(always.rule).toBe("terminal(cd /workspace*)");
    expect(choiceLabel(always, "terminal")).toBe("Always commands starting with “cd /srv/projets/calc”");
    const session = { id: "session" as const, key: "2", ruleKind: "prefix" as const, scopeRule: "terminal(cd /workspace*)" };
    expect(choiceLabel(session, "terminal")).toContain("“cd /srv/projets/calc”");
    // Même chemin dans la carte et dans le libellé.
    expect(approvalTarget(a)).toContain("cd /srv/projets/calc");
    // La règle stockée / envoyée reste `cd /workspace*` : c'est ce que le noyau compare.
    expect(session.scopeRule).toBe("terminal(cd /workspace*)");
    expect(JSON.stringify(always)).not.toContain("/srv/projets");
  });
  it("sans session de code (aucune réécriture) : tel quel partout", () => {
    setWorkspaceView(null);
    const a = card();
    expect(approvalTarget(a)).toBe("cd /workspace && python -m pytest -q");
    expect(choiceLabel(localChoices(a).find((c) => c.id === "always" && c.ruleKind === "prefix")!, "terminal")).toBe("Always commands starting with “cd /workspace”");
  });
  it("en français", () => {
    setLang("fr");
    setWorkspaceView("/srv/projets/calc");
    expect(choiceLabel(localChoices(card()).find((c) => c.id === "always" && c.ruleKind === "prefix")!, "terminal")).toBe("Toujours les commandes qui commencent par « cd /srv/projets/calc »");
  });
});
