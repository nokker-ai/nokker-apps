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

exports.run = async function run() {
  const proj = process.env.NOKKER_E2E_PROJ;
  const ext = vscode.extensions.getExtension("nokker.nokker-vscode");
  assert.ok(ext, "extension introuvable");
  let controller;

  await step("activation, commandes et vue", async () => {
    const exported = await ext.activate();
    controller = exported.controller;
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ["nokker.sendSelection", "nokker.newThread", "nokker.cancel", "nokker.reconnect", "nokker.chat.focus"]) assert.ok(cmds.includes(c), c);
    await vscode.commands.executeCommand("nokker.chat.focus");
  });

  await step("connexion au noyau par le jeton local, session du dossier", async () => {
    await until(() => controller.threadId);
    assert.equal(controller.folder, proj);
    const s = await api("/v1/local/sessions");
    assert.ok(s.sessions.some((x) => x.thread_id === controller.threadId && x.cwd === proj));
  });

  await step("envoyer la sélection : fichier + lignes", async () => {
    const doc = await vscode.workspace.openTextDocument(join(proj, "src", "app.py"));
    const ed = await vscode.window.showTextDocument(doc);
    ed.selection = new vscode.Selection(0, 0, 1, 16);
    await vscode.commands.executeCommand("nokker.sendSelection");
    assert.deepEqual(controller.contextLabels(), ["src/app.py:1-2"]);
  });

  await step("un tour avec cartes (décidées par l'API comme un téléphone) puis diff natif", async () => {
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
    const diffs = controller.knownDiffs();
    assert.equal(diffs.length, 1);
    await controller.openDiff(diffs[0].id);
    const tab = await until(() =>
      vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputTextDiff && t.input.original.scheme === "nokker-avant"),
    );
    const left = await vscode.workspace.openTextDocument(tab.input.original);
    assert.match(left.getText(), /return a - b/);
    assert.equal(tab.input.modified.fsPath, join(proj, "src", "app.py"));
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

  await step("nouveau fil", async () => {
    const before = controller.threadId;
    await vscode.commands.executeCommand("nokker.newThread");
    await until(() => controller.threadId !== before && controller.threadId);
  });
};
