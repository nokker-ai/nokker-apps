/**
 * Extension VS Code de Nokker Lokkal : panneau de chat (webview) sur la session de code locale du dossier ouvert, vue
 * des sessions du noyau, revue des écritures du tour, écriture en direct, pièces de contexte (sélection, fichier,
 * problèmes, terminal), notifications de cartes, barre d'état. Branchement seulement : la logique vit dans
 * `controller.ts`, `review.ts`, `sessions.ts`, `context.ts`… (testés sans VS Code).
 */
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { EditorFs } from "@nokker-apps/sdk";
import { ChatController, type StoredDiff } from "./controller.js";
import { resolveServerUrl } from "./connection.js";
import { excerptAround, isImagePath, relativeTo, TerminalLog, type DiagnosticItem } from "./context.js";
import { newNonce, panelHtml } from "./html.js";
import { costLang, webviewStrings, type Translate } from "./i18n.js";
import { livePath, type LiveView } from "./live.js";
import type { FromView, ToView, ViewCard } from "./protocol.js";
import type { ReviewFile } from "./review.js";
import type { SessionRow } from "./sessions.js";
import { cardNotification, statusBar } from "./status.js";

const BEFORE_SCHEME = "nokker-before";
const AFTER_SCHEME = "nokker-after";
const LIVE_SCHEME = "nokker-live";
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

const t: Translate = (message, ...args) => vscode.l10n.t(message, ...args);

const nodeFs: EditorFs = {
  async read(path) {
    try {
      const st = await stat(path);
      if (!st.isFile() || st.size > MAX_DIFF_BYTES) return null;
      const text = await readFile(path, "utf-8");
      return text.includes("\u0000") ? null : text;
    } catch {
      return null;
    }
  },
};

/** Textes servis par schéma (avant/après d'un diff, écriture en direct) : documents en lecture seule. */
class TextDocuments implements vscode.TextDocumentContentProvider {
  private docs = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(key: string, text: string): void {
    this.docs.set(key, text);
    if (this.docs.size > 500) this.docs.delete(this.docs.keys().next().value as string);
  }

  changed(uri: vscode.Uri): void {
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.query) ?? "";
  }

  dispose(): void {
    this.emitter.dispose();
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
      strings: webviewStrings(t),
      lang: costLang(vscode.env.language),
    });
    view.webview.onDidReceiveMessage((m: FromView) => this.onMessage(m));
  }

  post(m: ToView): void {
    void this.view?.webview.postMessage(m);
  }
}

class SessionItem extends vscode.TreeItem {
  constructor(readonly row: SessionRow) {
    super(row.title, vscode.TreeItemCollapsibleState.None);
    const parts: string[] = [];
    if (row.current) parts.push(t("current"));
    if (row.working) parts.push(t("working"));
    if (row.cards) parts.push(row.strongCards ? t("{0} card(s), {1} strong", row.cards, row.strongCards) : t("{0} card(s)", row.cards));
    if (row.cost) parts.push(row.cost);
    if (!row.inFolder) parts.push(t("other folder"));
    this.description = parts.join(" · ");
    this.tooltip = new vscode.MarkdownString(`**${row.title}**\n\n${row.cwd}\n\n\`${row.threadId}\``);
    this.iconPath = new vscode.ThemeIcon(row.working ? "sync~spin" : row.cards ? "bell-dot" : row.current ? "comment-discussion" : "comment");
    this.contextValue = row.inFolder ? "nokker.session" : "nokker.session.other";
    this.command = { command: "nokker.openSession", title: t("Resume this session"), arguments: [row] };
  }
}

class SessionsTree implements vscode.TreeDataProvider<SessionItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly controller: ChatController, private readonly ensure: () => Promise<boolean>) {}
  refresh(): void {
    this.emitter.fire();
  }
  getTreeItem(e: SessionItem): vscode.TreeItem {
    return e;
  }
  async getChildren(): Promise<SessionItem[]> {
    if (!this.controller.sessions) await this.ensure();
    return (this.controller.sessions?.rows() ?? []).map((r) => new SessionItem(r));
  }
}

function reviewStatusLabel(f: ReviewFile): string {
  switch (f.status) {
    case "pending":
      return f.created ? t("created, to review") : t("to review");
    case "accepted":
      return t("accepted");
    case "restoring":
      return t("restoring");
    case "restored":
      return f.created ? t("removed") : t("restored");
    case "failed":
      return t("restore failed");
  }
}

class ChangeItem extends vscode.TreeItem {
  constructor(readonly file: ReviewFile, folder: string | null) {
    super(file.relPath.split("/").pop() ?? file.relPath, vscode.TreeItemCollapsibleState.None);
    const dir = file.relPath.includes("/") ? file.relPath.slice(0, file.relPath.lastIndexOf("/")) : "";
    this.description = [dir, reviewStatusLabel(file)].filter(Boolean).join(" · ");
    this.tooltip = [file.relPath, file.note].filter(Boolean).join("\n");
    this.resourceUri = folder ? vscode.Uri.file(file.path) : undefined;
    this.iconPath = new vscode.ThemeIcon(
      file.status === "accepted" ? "check" : file.status === "restored" ? "discard" : file.status === "restoring" ? "sync~spin" : file.status === "failed" ? "error" : file.created ? "diff-added" : "diff-modified",
    );
    this.contextValue = file.status === "pending" || file.status === "failed" ? "nokker.change.open" : "nokker.change.closed";
    this.command = { command: "nokker.review.openDiff", title: t("Open the diff"), arguments: [file.relPath] };
  }
}

class ChangesTree implements vscode.TreeDataProvider<ChangeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly controller: ChatController) {}
  refresh(): void {
    this.emitter.fire();
  }
  getTreeItem(e: ChangeItem): vscode.TreeItem {
    return e;
  }
  getChildren(): ChangeItem[] {
    return (this.controller.review?.list() ?? []).map((f) => new ChangeItem(f, this.controller.folder));
  }
}

function workspaceFolder(): string | null {
  const active = vscode.window.activeTextEditor?.document.uri;
  const f = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  return f && f.uri.scheme === "file" ? f.uri.fsPath : null;
}

/** Dossiers ouverts, tels quels et résolus (le noyau rend `cwd` résolu). */
function openFolders(): string[] {
  const out = new Set<string>();
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (f.uri.scheme !== "file") continue;
    out.add(f.uri.fsPath);
    try {
      out.add(realpathSync(f.uri.fsPath));
    } catch {
      // dossier disparu
    }
  }
  return [...out];
}

function severityOf(s: vscode.DiagnosticSeverity): DiagnosticItem["severity"] {
  return s === vscode.DiagnosticSeverity.Error ? "error" : s === vscode.DiagnosticSeverity.Warning ? "warning" : s === vscode.DiagnosticSeverity.Information ? "info" : "hint";
}

function diagnosticItem(d: vscode.Diagnostic): DiagnosticItem {
  const code = typeof d.code === "object" && d.code !== null ? String(d.code.value) : d.code !== undefined ? String(d.code) : undefined;
  return {
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    severity: severityOf(d.severity),
    message: d.message,
    ...(d.source ? { source: d.source } : {}),
    ...(code ? { code } : {}),
  };
}

export interface NokkerExtensionApi {
  controller: ChatController;
  /** Pour les essais : dernière notification de carte (texte et boutons). */
  lastCardNotification(): { text: string; actions: string[] } | null;
  /** Pour les essais : textes servis (diffs, écriture en direct) et sorties de terminal captées. */
  liveText(callId: string): string | undefined;
  terminalCaptured(): number;
  /** Pour les essais : un libellé dans la langue de VS Code. */
  translate(message: string): string;
}

export function activate(context: vscode.ExtensionContext): NokkerExtensionApi {
  const out = vscode.window.createOutputChannel("Nokker", { log: true });
  const docs = new TextDocuments();
  const liveDocs = new TextDocuments();
  const server = resolveServerUrl(vscode.workspace.getConfiguration("nokker").get<string>("serverUrl"));
  out.info(`kernel: ${server.url} (${server.source})`);
  const status = vscode.window.createStatusBarItem("nokker.status", vscode.StatusBarAlignment.Right, 100);
  status.name = "Nokker";
  status.command = "nokker.chat.focus";
  let lastNotification: { text: string; actions: string[] } | null = null;
  const liveOpened = new Set<string>();
  const liveUris = new Map<string, vscode.Uri>();
  const terminalLogs = new Map<vscode.Terminal, TerminalLog>();

  let view: ChatView;
  let sessionsTree: SessionsTree;
  let changesTree: ChangesTree;
  const controller: ChatController = new ChatController(
    {
      post: (m) => view?.post(m),
      log: (level, msg) => (level === "error" ? out.error(msg) : level === "warn" ? out.warn(msg) : out.info(msg)),
      openDiff: async (d: StoredDiff) => openDiff(docs, d.id, d),
      cardAlert: (c: ViewCard) => {
        if (view?.view?.visible) return;
        const n = cardNotification(t, c);
        lastNotification = { text: n.text, actions: n.actions.map((a) => a.label) };
        if (!n.actions.length) {
          // Carte forte : aucune action, seulement où elle attend.
          void vscode.window.showWarningMessage(n.text.slice(0, 300));
          return;
        }
        void vscode.window.showInformationMessage(n.text.slice(0, 300), ...n.actions.map((a) => a.label)).then((pick) => {
          const a = n.actions.find((x) => x.label === pick);
          if (a) void controller.decide(c.id, a.index);
        });
      },
      live: (v: LiveView) => showLive(v),
      status: (s) => {
        const b = statusBar(t, s);
        status.text = b.text;
        status.tooltip = b.tooltip;
        status.show();
      },
      reviewChanged: () => {
        changesTree?.refresh();
        void updateReviewContext();
      },
      sessionsChanged: () => sessionsTree?.refresh(),
      confirmOverwrite: async (rel) => {
        const yes = t("Restore anyway");
        const pick = await vscode.window.showWarningMessage(
          t("You changed {0} after this turn. Restoring it from the restore point overwrites your changes.", rel),
          { modal: true },
          yes,
        );
        return pick === yes;
      },
      trashCreatedFile: async (path, rel) => {
        const yes = t("Move to the trash");
        const pick = await vscode.window.showWarningMessage(
          t("Refuse {0}? This turn created it: it is not in the restore point of the kernel. Nokker can move it to the trash.", rel),
          { modal: true },
          yes,
        );
        if (pick !== yes) return false;
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(path), { useTrash: true });
          return true;
        } catch (err) {
          void vscode.window.showErrorMessage(t("Could not move {0} to the trash: {1}", rel, err instanceof Error ? err.message : String(err)));
          return false;
        }
      },
    },
    {
      serverUrl: server.url,
      folder: workspaceFolder(),
      fs: nodeFs,
      userAgent: `nokker-vscode/${context.extension.packageJSON.version as string}`,
      t,
      lang: costLang(vscode.env.language),
      folders: openFolders,
    },
  );

  let connecting: Promise<boolean> | null = null;
  const ensureConnected = (): Promise<boolean> => (connecting ??= controller.connect());
  sessionsTree = new SessionsTree(controller, ensureConnected);
  changesTree = new ChangesTree(controller);

  function showLive(v: LiveView): void {
    const shown = livePath(v.path) ?? v.name;
    let uri = liveUris.get(v.callId);
    if (!uri) {
      uri = vscode.Uri.from({ scheme: LIVE_SCHEME, path: `/${shown}`, query: v.callId });
      liveUris.set(v.callId, uri);
    }
    liveDocs.set(v.callId, v.discarded ? `${v.text}\n\n${t("(proposal discarded by the model)")}\n` : v.truncated ? `${v.text}\n${t("… live view stopped (too long)")}\n` : v.text);
    liveDocs.changed(uri);
    const auto = vscode.workspace.getConfiguration("nokker").get<boolean>("liveWrite.openEditor", true);
    if (auto && !liveOpened.has(v.callId) && v.text && !v.done) {
      liveOpened.add(v.callId);
      void openLive(v.callId);
    }
    // Suivre la fin du texte dans les éditeurs qui le montrent.
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.toString() === uri.toString()) {
        const last = Math.max(0, ed.document.lineCount - 1);
        ed.revealRange(new vscode.Range(last, 0, last, 0), vscode.TextEditorRevealType.Default);
      }
    }
  }

  async function openLive(callId: string): Promise<void> {
    const uri = liveUris.get(callId);
    if (!uri) return;
    await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside });
  }

  /** Contexte `nokker.reviewFileOpen` : le diff actif est celui d'un fichier de la revue encore à décider. */
  async function updateReviewContext(): Promise<void> {
    const f = activeReviewFile();
    await vscode.commands.executeCommand("setContext", "nokker.reviewFileOpen", !!f && (f.status === "pending" || f.status === "failed"));
  }

  function activeReviewFile(): ReviewFile | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab?.input;
    if (!(input instanceof vscode.TabInputTextDiff) || input.original.scheme !== BEFORE_SCHEME || !input.original.query.startsWith("review:")) return undefined;
    return controller.review?.get(input.original.query.slice("review:".length));
  }

  function reviewTarget(arg: unknown): ReviewFile | undefined {
    if (arg instanceof ChangeItem) return arg.file;
    if (typeof arg === "string") return controller.review?.get(arg);
    return activeReviewFile();
  }

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
      case "openLive":
        void openLive(m.callId);
        return;
      case "pickFile":
        void vscode.commands.executeCommand("nokker.addFile");
        return;
      case "openReview":
        void vscode.commands.executeCommand("nokker.changes.focus");
        return;
    }
  });

  const addFileContext = async (uri: vscode.Uri): Promise<boolean> => {
    const folder = controller.folder;
    const rel = folder ? relativeTo(folder, uri.fsPath) : null;
    if (!rel) {
      void vscode.window.showWarningMessage(t("Nokker: this file is outside the folder of the session."));
      return false;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    const image = isImagePath(rel);
    controller.addContext({
      kind: "file",
      relPath: rel,
      image,
      ...(!image && open?.isDirty ? { unsavedText: open.getText(), languageId: open.languageId } : {}),
    });
    return true;
  };

  const addProblems = (doc: vscode.TextDocument, diagnostics: readonly vscode.Diagnostic[]): boolean => {
    const folder = controller.folder;
    const rel = folder ? relativeTo(folder, doc.uri.fsPath) : null;
    if (!rel) {
      void vscode.window.showWarningMessage(t("Nokker: this file is outside the folder of the session."));
      return false;
    }
    if (!diagnostics.length) {
      void vscode.window.showInformationMessage(t("Nokker: no problem reported for this file."));
      return false;
    }
    const items = [...diagnostics].sort((a, b) => a.range.start.line - b.range.start.line).map(diagnosticItem);
    const lines = Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text);
    controller.addContext({ kind: "diagnostics", relPath: rel, languageId: doc.languageId, items, excerpt: excerptAround(lines, items) });
    return true;
  };

  context.subscriptions.push(
    out,
    status,
    docs,
    liveDocs,
    vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, docs),
    vscode.workspace.registerTextDocumentContentProvider(AFTER_SCHEME, docs),
    vscode.workspace.registerTextDocumentContentProvider(LIVE_SCHEME, liveDocs),
    vscode.window.registerWebviewViewProvider("nokker.chat", view),
    vscode.window.registerTreeDataProvider("nokker.sessions", sessionsTree),
    vscode.window.registerTreeDataProvider("nokker.changes", changesTree),
    vscode.window.tabGroups.onDidChangeTabs(() => void updateReviewContext()),
    vscode.window.onDidStartTerminalShellExecution((e) => {
      // Sortie lue par l'intégration du shell de VS Code, seulement pour les commandes vues ici.
      const log = new TerminalLog(e.execution.commandLine?.value || null);
      terminalLogs.set(e.terminal, log);
      void (async () => {
        try {
          for await (const data of e.execution.read()) log.append(data);
        } catch {
          // flux coupé (terminal fermé)
        }
      })();
    }),
    vscode.window.onDidEndTerminalShellExecution((e) => terminalLogs.get(e.terminal)?.finish(e.exitCode)),
    vscode.window.onDidCloseTerminal((term) => terminalLogs.delete(term)),
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      {
        provideCodeActions(doc, _range, ctx) {
          if (!ctx.diagnostics.length) return [];
          const a = new vscode.CodeAction(t("Fix with Nokker"), vscode.CodeActionKind.QuickFix);
          a.diagnostics = [...ctx.diagnostics];
          a.command = { command: "nokker.fixProblems", title: t("Fix with Nokker"), arguments: [doc.uri, [...ctx.diagnostics]] };
          return [a];
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.commands.registerCommand("nokker.sendSelection", async () => {
      const ed = vscode.window.activeTextEditor;
      const folder = controller.folder;
      if (!ed || ed.selection.isEmpty) {
        void vscode.window.showInformationMessage(t("Nokker: select some lines in a file first."));
        return;
      }
      const rel = folder ? relativeTo(folder, ed.document.uri.fsPath) : null;
      if (!rel) {
        void vscode.window.showWarningMessage(t("Nokker: this file is outside the folder of the session."));
        return;
      }
      const sel = ed.selection;
      const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
      controller.addSelection({ relPath: rel, startLine: sel.start.line + 1, endLine, languageId: ed.document.languageId, text: ed.document.getText(sel) });
      await vscode.commands.executeCommand("nokker.chat.focus");
    }),
    vscode.commands.registerCommand("nokker.addFile", async (uri?: vscode.Uri) => {
      let target = uri instanceof vscode.Uri ? uri : undefined;
      if (!target) {
        const folder = controller.folder;
        if (!folder) return;
        const base = vscode.Uri.file(folder);
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(base, "**/*"), "**/{node_modules,.git,.nokker}/**", 5000);
        const items = files
          .map((f) => ({ label: relativeTo(folder, f.fsPath) ?? f.fsPath, uri: f }))
          .sort((a, b) => a.label.localeCompare(b.label));
        const pick = await vscode.window.showQuickPick(items, { placeHolder: t("File to add to the next message (@)"), matchOnDescription: true });
        target = pick?.uri;
      }
      if (target && (await addFileContext(target))) await vscode.commands.executeCommand("nokker.chat.focus");
    }),
    vscode.commands.registerCommand("nokker.addProblems", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      if (addProblems(ed.document, vscode.languages.getDiagnostics(ed.document.uri))) await vscode.commands.executeCommand("nokker.chat.focus");
    }),
    vscode.commands.registerCommand("nokker.fixProblems", async (uri?: vscode.Uri, diagnostics?: vscode.Diagnostic[]) => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (!target) return;
      const doc = await vscode.workspace.openTextDocument(target);
      const diags = diagnostics?.length ? diagnostics : vscode.languages.getDiagnostics(target);
      if (!addProblems(doc, diags)) return;
      controller.prefill(diags.length > 1 ? t("Fix these problems.") : t("Fix this problem."));
      await vscode.commands.executeCommand("nokker.chat.focus");
    }),
    vscode.commands.registerCommand("nokker.addTerminalOutput", async () => {
      const term = vscode.window.activeTerminal;
      if (!term) {
        void vscode.window.showInformationMessage(t("Nokker: no active terminal."));
        return;
      }
      const log = terminalLogs.get(term);
      if (!log) {
        void vscode.window.showWarningMessage(
          term.shellIntegration
            ? t("Nokker: no command output captured in this terminal yet. Run the command again, then add it.")
            : t("Nokker: the shell integration of VS Code is not active in this terminal, so its output cannot be read."),
        );
        return;
      }
      controller.addContext({ kind: "terminal", name: term.name, commandLine: log.commandLine, exitCode: log.exitCode, output: log.output });
      await vscode.commands.executeCommand("nokker.chat.focus");
    }),
    vscode.commands.registerCommand("nokker.newThread", () => controller.newThread()),
    vscode.commands.registerCommand("nokker.cancel", () => controller.cancel()),
    vscode.commands.registerCommand("nokker.reconnect", () => (connecting = controller.connect())),
    vscode.commands.registerCommand("nokker.refreshSessions", async () => {
      await ensureConnected();
      await controller.sessions?.refresh();
    }),
    vscode.commands.registerCommand("nokker.openSession", async (arg: SessionRow | SessionItem) => {
      const row = arg instanceof SessionItem ? arg.row : arg;
      if (!row) return;
      if (!row.inFolder) {
        const open = t("Open the folder");
        const pick = await vscode.window.showInformationMessage(t("This session works on {0}, which is not open in this window.", row.cwd), open);
        if (pick === open) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(row.cwd), { forceNewWindow: true });
        return;
      }
      await vscode.commands.executeCommand("nokker.chat.focus");
      connecting = controller.openSession(row.threadId, row.cwd);
      await connecting;
      sessionsTree.refresh();
    }),
    vscode.commands.registerCommand("nokker.openLive", (callId: string) => openLive(callId)),
    vscode.commands.registerCommand("nokker.review.openDiff", async (arg?: unknown) => {
      const f = reviewTarget(arg);
      if (f) await openDiff(docs, `review:${f.relPath}`, { ...f, oldText: f.oldText });
    }),
    vscode.commands.registerCommand("nokker.review.accept", (arg?: unknown) => {
      const f = reviewTarget(arg);
      if (f) controller.review?.accept(f.relPath);
    }),
    vscode.commands.registerCommand("nokker.review.refuse", async (arg?: unknown) => {
      const f = reviewTarget(arg);
      if (f) await controller.review?.refuse(f.relPath);
    }),
    vscode.commands.registerCommand("nokker.review.acceptAll", () => controller.review?.acceptAll()),
    { dispose: () => controller.dispose() },
  );
  statusBarInit();
  return {
    controller,
    lastCardNotification: () => lastNotification,
    liveText: (callId) => liveDocs.provideTextDocumentContent(vscode.Uri.from({ scheme: LIVE_SCHEME, path: "/x", query: callId })),
    terminalCaptured: () => [...terminalLogs.values()].filter((l) => l.done).length,
    translate: (message) => t(message),
  };

  function statusBarInit(): void {
    const b = statusBar(t, controller.status);
    status.text = b.text;
    status.tooltip = b.tooltip;
    status.show();
  }
}

/** Diff natif : avant (texte servi) ↔ fichier actuel ; passage seul ou fichier supprimé : diff d'instantanés. */
async function openDiff(
  docs: TextDocuments,
  key: string,
  d: Pick<StoredDiff, "relPath" | "path" | "oldText" | "newText" | "fragment">,
): Promise<void> {
  const left = vscode.Uri.from({ scheme: BEFORE_SCHEME, path: `/${d.relPath}`, query: key });
  docs.set(key, d.oldText ?? "");
  let right: vscode.Uri;
  if (d.fragment || d.newText === "") {
    right = vscode.Uri.from({ scheme: AFTER_SCHEME, path: `/${d.relPath}`, query: `${key}:after` });
    docs.set(`${key}:after`, d.newText);
  } else {
    right = vscode.Uri.file(d.path);
  }
  const what = d.oldText === null ? t("created file") : d.fragment ? t("replaced excerpt") : t("before ↔ now");
  await vscode.commands.executeCommand("vscode.diff", left, right, `${d.relPath} (Nokker: ${what})`, { preview: true });
}

export function deactivate(): void {
  // les abonnements sont libérés par context.subscriptions
}
