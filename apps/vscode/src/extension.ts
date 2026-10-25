/**
 * Extension VS Code de Nokker Lokkal : un panneau de chat (webview) sur la session de code locale du dossier ouvert.
 * Branchement seulement : la logique vit dans `controller.ts` (testée sans VS Code).
 */
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { EditorFs } from "@nokker-apps/sdk";
import { ChatController, type StoredDiff } from "./controller.js";
import { resolveServerUrl } from "./connection.js";
import { newNonce, panelHtml } from "./html.js";
import type { FromView, ToView, ViewCard } from "./protocol.js";
import { relativeTo } from "./selection.js";

const BEFORE_SCHEME = "nokker-avant";
const AFTER_SCHEME = "nokker-apres";
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

const nodeFs: EditorFs = {
  async read(path) {
    try {
      const st = await stat(path);
      if (!st.isFile() || st.size > MAX_DIFF_BYTES) return null;
      const t = await readFile(path, "utf-8");
      return t.includes("\u0000") ? null : t;
    } catch {
      return null;
    }
  },
};

/** Textes « avant » (et « après » d'un passage) des diffs, servis à l'éditeur de diff natif. */
class DiffDocuments implements vscode.TextDocumentContentProvider {
  private docs = new Map<string, string>();
  set(key: string, text: string): void {
    this.docs.set(key, text);
    if (this.docs.size > 500) this.docs.delete(this.docs.keys().next().value as string);
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.query) ?? "";
  }
}

class ChatView implements vscode.WebviewViewProvider {
  view: vscode.WebviewView | undefined;
  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly onMessage: (m: FromView) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, "dist");
    view.webview.options = { enableScripts: true, enableForms: false, localResourceRoots: [media, dist] };
    view.webview.html = panelHtml({
      cspSource: view.webview.cspSource,
      nonce: newNonce((n) => randomBytes(n)),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js")).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css")).toString(),
    });
    view.webview.onDidReceiveMessage((m: FromView) => this.onMessage(m));
  }

  post(m: ToView): void {
    void this.view?.webview.postMessage(m);
  }
}

function workspaceFolder(): string | null {
  const active = vscode.window.activeTextEditor?.document.uri;
  const f = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  return f && f.uri.scheme === "file" ? f.uri.fsPath : null;
}

export interface NokkerExtensionApi {
  controller: ChatController;
}

export function activate(context: vscode.ExtensionContext): NokkerExtensionApi {
  const out = vscode.window.createOutputChannel("Nokker", { log: true });
  const docs = new DiffDocuments();
  const server = resolveServerUrl(vscode.workspace.getConfiguration("nokker").get<string>("serverUrl"));
  out.info(`noyau : ${server.url} (${server.source})`);

  let view: ChatView;
  const controller = new ChatController(
    {
      post: (m) => view?.post(m),
      log: (level, msg) => (level === "error" ? out.error(msg) : level === "warn" ? out.warn(msg) : out.info(msg)),
      openDiff: async (d: StoredDiff) => openDiff(docs, d),
      cardAlert: (c: ViewCard) => {
        if (view?.view?.visible) return;
        const label = c.choices
          ? "Nokker : une action attend ton approbation"
          : c.forwarded
            ? "Nokker : une action forte attend ton téléphone"
            : "Nokker : une action forte est à décider dans le terminal (nokker)";
        void vscode.window.showInformationMessage(`${label} (${c.tool} ${c.target})`.slice(0, 200), "Voir").then((pick) => {
          if (pick) void vscode.commands.executeCommand("nokker.chat.focus");
        });
      },
    },
    { serverUrl: server.url, folder: workspaceFolder(), fs: nodeFs, userAgent: `nokker-vscode/${context.extension.packageJSON.version as string}` },
  );

  let connecting: Promise<boolean> | null = null;
  const ensureConnected = (): Promise<boolean> => (connecting ??= controller.connect());

  view = new ChatView(context, (m) => {
    switch (m.type) {
      case "ready":
        controller.replay();
        void ensureConnected();
        return;
      case "send":
        void controller.send(m.text);
        return;
      case "cancel":
        void controller.cancel();
        return;
      case "decide":
        void controller.decide(m.id, m.index);
        return;
      case "openDiff":
        void controller.openDiff(m.id);
        return;
      case "removeContext":
        controller.removeContext(m.id);
        return;
      case "newThread":
        void controller.newThread();
        return;
      case "reconnect":
        connecting = controller.connect();
        return;
    }
  });

  context.subscriptions.push(
    out,
    vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, docs),
    vscode.workspace.registerTextDocumentContentProvider(AFTER_SCHEME, docs),
    vscode.window.registerWebviewViewProvider("nokker.chat", view),
    vscode.commands.registerCommand("nokker.sendSelection", async () => {
      const ed = vscode.window.activeTextEditor;
      const folder = controller.folder;
      if (!ed || ed.selection.isEmpty) {
        void vscode.window.showInformationMessage("Nokker : sélectionne d'abord des lignes dans un fichier.");
        return;
      }
      const rel = folder ? relativeTo(folder, ed.document.uri.fsPath) : null;
      if (!rel) {
        void vscode.window.showWarningMessage("Nokker : ce fichier est hors du dossier de la session.");
        return;
      }
      const sel = ed.selection;
      const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
      controller.addSelection({
        relPath: rel,
        startLine: sel.start.line + 1,
        endLine,
        languageId: ed.document.languageId,
        text: ed.document.getText(sel),
      });
      await vscode.commands.executeCommand("nokker.chat.focus");
    }),
    vscode.commands.registerCommand("nokker.newThread", () => controller.newThread()),
    vscode.commands.registerCommand("nokker.cancel", () => controller.cancel()),
    vscode.commands.registerCommand("nokker.reconnect", () => (connecting = controller.connect())),
    { dispose: () => controller.dispose() },
  );
  return { controller };
}

async function openDiff(docs: DiffDocuments, d: StoredDiff): Promise<void> {
  const left = vscode.Uri.from({ scheme: BEFORE_SCHEME, path: `/${d.relPath}`, query: `${d.id}` });
  docs.set(d.id, d.oldText ?? "");
  let right: vscode.Uri;
  if (d.fragment || d.newText === "") {
    // Passage seul (le fichier entier n'a pas pu être relu), ou fichier supprimé : diff d'instantanés.
    right = vscode.Uri.from({ scheme: AFTER_SCHEME, path: `/${d.relPath}`, query: `${d.id}:apres` });
    docs.set(`${d.id}:apres`, d.newText);
  } else {
    right = vscode.Uri.file(d.path);
  }
  const what = d.oldText === null ? "fichier créé" : d.fragment ? "passage remplacé" : "avant ↔ maintenant";
  await vscode.commands.executeCommand("vscode.diff", left, right, `${d.relPath} (Nokker : ${what})`, { preview: true });
}

export function deactivate(): void {
  // les abonnements sont libérés par context.subscriptions
}
