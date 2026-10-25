// Suite exécutée DANS VS Code (hôte d'extensions). Pas de mocha : `run()` lève à la première attente déçue.
const vscode = require("vscode");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("délai dépassé");
    await wait(25);
  }
}

async function api(path, init = {}) {
  const token = readFileSync(join(process.env.NOKKER_CONFIG_DIR_OVERRIDE, "local-token"), "utf-8").trim();
  const res = await fetch(`${process.env.NOKKER_SERVER_URL}${path}`, {
    method: init.method || "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  return res.json();
}

function shot(file) {
  require("node:child_process").execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-video_size", "1400x900", "-i", process.env.DISPLAY, "-frames:v", "1", file]);
}

async function step(name, fn) {
  const t0 = Date.now();
  await fn();
  console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
}

const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs);

exports.run = async function run() {
  const proj = process.env.NOKKER_E2E_PROJ;
  const fr = process.env.NOKKER_E2E_LOCALE === "fr";
  const ext = vscode.extensions.getExtension("nokker.nokker-vscode");
  assert.ok(ext, "extension introuvable");
  let exported;
  let controller;

  await step("activation, commandes et vues", async () => {
    exported = await ext.activate();
    controller = exported.controller;
    const cmds = await vscode.commands.getCommands(true);
    for (const c of [
      "nokker.sendSelection",
      "nokker.addFile",
      "nokker.addProblems",
      "nokker.fixProblems",
      "nokker.addTerminalOutput",
      "nokker.newThread",
      "nokker.cancel",
      "nokker.reconnect",
      "nokker.refreshSessions",
      "nokker.openSession",
      "nokker.review.accept",
      "nokker.review.refuse",
      "nokker.review.acceptAll",
      "nokker.chat.focus",
      "nokker.changes.focus",
      "nokker.sessions.focus",
    ])
      assert.ok(cmds.includes(c), c);
    await vscode.commands.executeCommand("nokker.chat.focus");
  });

  await step(`libellés : ${fr ? "français (VS Code en fr)" : "anglais par défaut"}`, async () => {
    assert.equal(vscode.env.language.startsWith("fr"), fr, `langue de VS Code : ${vscode.env.language}`);
    assert.equal(exported.translate("Send"), fr ? "Envoyer" : "Send");
    assert.equal(exported.translate("Strong action: it waits for your phone."), fr ? "Action forte : elle attend ton téléphone." : "Strong action: it waits for your phone.");
  });

  await step("connexion au noyau par le jeton local, session du dossier", async () => {
    await until(() => controller.threadId);
    assert.equal(controller.folder, proj);
    const s = await api("/v1/local/sessions");
    assert.ok(s.sessions.some((x) => x.thread_id === controller.threadId && x.cwd === proj));
  });

  await step("vue Sessions : la session du dossier, affichée", async () => {
    await vscode.commands.executeCommand("nokker.sessions.focus");
    await vscode.commands.executeCommand("nokker.refreshSessions");
    const rows = await until(() => controller.sessions && controller.sessions.rows().length && controller.sessions.rows());
    assert.equal(rows[0].threadId, controller.threadId);
    assert.equal(rows[0].current, true);
    assert.equal(rows[0].inFolder, true);
    await vscode.commands.executeCommand("nokker.chat.focus");
  });

  await step("envoyer la sélection : fichier + lignes", async () => {
    const doc = await vscode.workspace.openTextDocument(join(proj, "src", "app.py"));
    const ed = await vscode.window.showTextDocument(doc);
    ed.selection = new vscode.Selection(0, 0, 1, 16);
    await vscode.commands.executeCommand("nokker.sendSelection");
    assert.deepEqual(controller.contextLabels(), ["src/app.py:1-2"]);
  });

  await step("problèmes : quick fix « corriger avec Nokker » → pièce de contexte", async () => {
    const uri = vscode.Uri.file(join(proj, "src", "app.py"));
    const coll = vscode.languages.createDiagnosticCollection("e2e");
    const diag = new vscode.Diagnostic(new vscode.Range(1, 11, 1, 16), "add returns a - b", vscode.DiagnosticSeverity.Error);
    diag.source = "e2e";
    coll.set(uri, [diag]);
    const actions = await until(async () => {
      const got = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", uri, new vscode.Range(1, 11, 1, 16), vscode.CodeActionKind.QuickFix.value);
      return got && got.find((a) => a.command && a.command.command === "nokker.fixProblems") && got;
    });
    const fix = actions.find((a) => a.command && a.command.command === "nokker.fixProblems");
    assert.equal(fix.title, fr ? "Corriger avec Nokker" : "Fix with Nokker");
    await vscode.commands.executeCommand(fix.command.command, ...fix.command.arguments);
    assert.deepEqual(controller.contextLabels(), ["src/app.py:1-2", fr ? "Problèmes : src/app.py (1)" : "Problems: src/app.py (1)"]);
    coll.dispose();
    // Retirée avant le tour (le scénario du mock n'en a pas besoin).
    controller.removeContext(controller.contextItems()[1].id);
  });

  await step("terminal actif : dernière sortie lue par l'intégration du shell (sinon, dit pourquoi)", async () => {
    const term = vscode.window.createTerminal({ name: "e2e", shellPath: "/bin/bash", cwd: proj });
    term.show();
    const si = await until(() => term.shellIntegration, 15000).catch(() => null);
    if (!si) {
      console.log("    (intégration du shell non activée dans ce bash : étape vérifiée par les essais unitaires seulement)");
      term.dispose();
      return;
    }
    si.executeCommand("echo nokker-e2e-$((40+2))");
    await until(() => exported.terminalCaptured() > 0, 10000);
    await vscode.commands.executeCommand("nokker.addTerminalOutput");
    const item = controller.contextItems().find((c) => c.kind === "terminal");
    assert.ok(item, "pièce terminal absente");
    assert.match(item.output, /nokker-e2e-42/);
    controller.removeContext(item.id);
    term.dispose();
  });

  let callId = null;
  await step("un tour avec cartes (décidées par l'API comme un téléphone), écriture en direct, diff natif", async () => {
    const decided = new Set();
    let stop = false;
    const pump = (async () => {
      while (!stop) {
        const { approvals } = await api("/v1/local/approvals");
        for (const a of approvals.filter((x) => x.thread_id === controller.threadId && !decided.has(x.id))) {
          decided.add(a.id);
          if (process.env.NOKKER_E2E_SHOT) {
            await vscode.commands.executeCommand("workbench.action.closeAllEditors");
            await wait(1200);
            shot(process.env.NOKKER_E2E_SHOT.replace(/\.png$/, `-carte${decided.size}.png`));
          }
          await api(`/v1/local/approvals/${a.id}/decide`, { method: "POST", body: { decision: a.strength === "strong" ? "reject" : "approve", scope: "once" } });
        }
        if (decided.size >= 2) return; // borne : deux cartes dans ce scénario, jamais plus
        await wait(25);
      }
    })();
    await controller.send("corrige le test add");
    stop = true;
    await pump;
    assert.equal(decided.size, 2);
    // Écriture en direct : l'éditeur en lecture seule s'ouvre (à côté, sans prendre le focus) sur ce que le modèle propose.
    const liveTab = await until(() => tabs().find((t) => t.input instanceof vscode.TabInputText && t.input.uri.scheme === "nokker-live"), 5000).catch(() => {
      throw new Error(`vue en direct absente ; onglets : ${tabs().map((t) => (t.input && t.input.uri ? t.input.uri.toString() : t.label)).join(", ")}`);
    });
    callId = liveTab.input.uri.query;
    assert.match(exported.liveText(callId), /Somme de a et b/);
    const liveDoc = await vscode.workspace.openTextDocument(liveTab.input.uri);
    assert.match(liveDoc.getText(), /Somme de a et b/);
    // Diff natif du patch : avant (texte servi) ↔ fichier réel.
    const diffs = controller.knownDiffs();
    assert.equal(diffs.length, 1);
    await controller.openDiff(diffs[0].id);
    const tab = await until(() => tabs().find((t) => t.input instanceof vscode.TabInputTextDiff && t.input.original.scheme === "nokker-before"));
    const left = await vscode.workspace.openTextDocument(tab.input.original);
    assert.match(left.getText(), /return a - b/);
    assert.equal(tab.input.modified.fsPath, join(proj, "src", "app.py"));
    assert.match(readFileSync(join(proj, "src", "app.py"), "utf-8"), /return a \+ b/);
  });

  await step("revue : diff du fichier, refuser = retour au point du tour (carte forte décidée au terminal)", async () => {
    await vscode.commands.executeCommand("nokker.changes.focus");
    const review = controller.review;
    assert.ok(review, "pas de revue");
    assert.deepEqual(review.list().map((f) => [f.relPath, f.status]), [["src/app.py", "pending"]]);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("nokker.review.openDiff", "src/app.py");
    await until(() => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t && t.input instanceof vscode.TabInputTextDiff && t.input.original.query === "review:src/app.py";
    });
    // Refuser depuis le diff actif (bouton de la barre de titre du diff).
    await vscode.commands.executeCommand("nokker.review.refuse");
    const f = await until(() => review.get("src/app.py").approvalId && review.get("src/app.py"));
    assert.equal(f.status, "restoring");
    const card = (await api("/v1/local/approvals")).approvals.find((a) => a.id === f.approvalId);
    assert.equal(card.tool_name, "checkpoint_restore");
    assert.equal(card.strength, "strong");
    // La carte forte n'a aucun bouton dans le panneau.
    assert.ok(controller.openCards().some((c) => c.id === f.approvalId && c.choices === null));
    await api(`/v1/local/approvals/${f.approvalId}/decide`, { method: "POST", body: { decision: "approve", scope: "once" } });
    await until(() => review.get("src/app.py").status === "restored");
    assert.match(readFileSync(join(proj, "src", "app.py"), "utf-8"), /return a - b/);
  });

  if (process.env.NOKKER_E2E_SHOT) {
    // Capture d'écran facultative (relecture visuelle du panneau) : NOKKER_E2E_SHOT=<fichier.png>, écran xvfb ≥ 1280x800.
    await step("capture du panneau", async () => {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.commands.executeCommand("nokker.chat.focus");
      await wait(1500);
      shot(process.env.NOKKER_E2E_SHOT);
    });
  }

  await step("nouveau fil, puis reprise du premier depuis la vue Sessions", async () => {
    const before = controller.threadId;
    await vscode.commands.executeCommand("nokker.newThread");
    await until(() => controller.threadId !== before && controller.threadId);
    await controller.sessions.refresh();
    const row = controller.sessions.rows().find((r) => r.threadId === before);
    assert.ok(row);
    await vscode.commands.executeCommand("nokker.openSession", row);
    await until(() => controller.threadId === before);
  });
};
