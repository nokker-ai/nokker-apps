# Nokker for VS Code

A Nokker Lokkal coding session inside VS Code: a chat panel on the open folder, against the kernel that runs on your
machine. Same session, same permission rules and same approval cards as the `nokker` command in a terminal.

> **Marketplace: soon.** The extension is not published on the Visual Studio Marketplace or Open VSX yet; install it
> from a `.vsix` package built locally (see [Build, test, package](#build-test-package)).

Labels follow the language of VS Code: English by default, French when VS Code is in French.

## Requirements

- Nokker Lokkal installed and running on this machine (the installer writes `~/.config/nokker/lokkal.json`).
- A **trusted** folder under one of the roots declared to Lokkal. Problems with the connection: run `nokker doctor`
  in a terminal.

## Features

### Session panel

- **Session of the open folder**: the panel resumes the most recent session of the folder (`GET /v1/local/sessions`),
  or opens one (`POST /v1/local/sessions {cwd}`). "+" starts a new session in the same folder.
- **Live replies**, tool calls with their effect (`read`, `write`, `destructive`…), a folded preview of the result,
  sub-agents indented, and a cost line under each turn (`12.4k tokens · €0.03`, tokens only when the model has no
  price). Amounts come from the kernel as they are, never converted.
- **Stop** (or Escape in the input box) cancels the turn (`POST /v1/threads/{id}/cancel`).

### Sessions view

All the coding sessions of the local kernel, those of the open folder first: title, live state (working, cards
waiting, strong cards among them) and cumulated cost (`GET /v1/local/cost?thread_id=`). Click a session of this folder
to resume it (its history is replayed); a session of another folder offers to open that folder in a new window. A
session opened elsewhere (for example by `nokker` in a terminal) shows up as soon as it runs a turn.

### Reviewing the changes of a turn

- **Changes view**: the files written by the last turn (`write_file`, `patch`), each with its native diff
  (before ↔ now), and **Accept** / **Refuse** per file — inline in the view, or from the title bar of the diff.
- **Refuse** restores the file from the **restore point the kernel took before the turn** (see the checkpoints
  documentation: one point before the first non-read tool call of each turn). The extension calls
  `checkpoint_restore {hash, file}`; restoring is destructive, so the kernel asks for a **strong card**, which is
  never decided in VS Code: it waits in the terminal (`nokker`), or on your phone when the machine is linked to a
  nokker.ai account. Rejecting that card keeps the file.
- A file **created** by the turn is not in the restore point. A kernel that links its restore points to turns deletes it
  itself (same strong card), after a fresh "before rollback" point that keeps a copy; with an older kernel, refusing it
  moves it to the trash, after you confirm.

### Live writing

While the model writes a file, its proposal streams in (`tool.input.delta`): the last lines scroll under the tool
call in the panel, and a **read-only editor** opens beside the current one with the whole text as it grows
(setting `nokker.liveWrite.openEditor`). Nothing is written to disk before the tool runs: the approval card stays the
gate.

### Context for the next message

Everything comes from the editor, never made up:

- **Selection** (editor context menu, `Ctrl+Alt+N` / `Cmd+Alt+N`): file and lines, as a context block.
- **Files** (`@` button, explorer or editor context menu, "Add a file to the message"): a saved file is sent as
  `@path` (the kernel reads it in the session folder); a file with unsaved changes is sent with its current text;
  an image (png, jpeg, webp, gif) is attached by path. Typing `@capture.png` in the message attaches it too.
- **Problems**: the **Fix with Nokker** quick fix on a diagnostic adds the problems (message, source, code) with the
  real lines around them, and fills the input with "Fix this problem." — press Enter to send. "Add the problems of
  this file" does the same for every problem of the active file.
- **Terminal**: "Add the last terminal output" adds the last command of the active terminal, its exit code and its
  last lines (ANSI sequences removed). The output is read through VS Code's terminal shell integration; without it,
  the extension says so instead of guessing.

Each piece shows as a chip above the input box and can be removed before sending.

### Approval cards

- In the panel: the same choices in the same order as the terminal client — *Once*, *For this session*, *Always
  this command* (the exact rule is shown), *Always commands starting with…*, *Reject*; for a test command, *For this
  session* comes first.
- **Notifications** when the panel is hidden: *Once*, *For this session*, *Reject* for a standard card.
- A **strong card** has no button anywhere in VS Code (panel or notification): the extension only says where it
  waits — "waits for your phone" when the kernel forwarded it to your account, otherwise "decide it in the terminal
  (`nokker`)".
- At most one decision per card and 25 per turn.

### Status bar

Tier, model and cost of the last turn, a spinner while a turn runs, and the number of cards waiting. Click to open
the panel.

## Connection and token

The extension reads **exactly the same files as the `nokker` CLI** (shared code):

- kernel: setting `nokker.serverUrl` (machine scope, never synced) > `$NOKKER_SERVER_URL` > `api_url` of
  `~/.config/nokker/lokkal.json` > `http://127.0.0.1:8742`;
- local token: `token_path` of `lokkal.json`, otherwise `~/.config/nokker/local-token`.

The token is **never** stored in VS Code settings (Settings Sync copies them between machines) and is only sent to a
kernel on the loopback interface (`127.0.0.1`, `localhost`). It never leaves the extension host: the panel has
neither the token nor network access.

## Security of the panel

- Strict Content Security Policy: `default-src 'none'`, one script (nonce), one stylesheet served by VS Code,
  `connect-src 'none'`, no inline style or script, nothing remote.
- Every text from the kernel is set with `textContent` (minimal Markdown built as nodes, never HTML).
- The extension requires a trusted workspace. It sends no telemetry.

## Settings

| Setting | Default | |
|---|---|---|
| `nokker.serverUrl` | empty | address of the local kernel (machine scope) |
| `nokker.liveWrite.openEditor` | `true` | open live writes in a read-only editor beside the current one |

## Build, test, package

```sh
pnpm install --frozen-lockfile
pnpm --filter nokker-vscode build            # dist/extension.cjs + dist/webview.js (esbuild, no runtime dependency)
pnpm --filter nokker-vscode test             # unit tests (vitest, against the mock server)
pnpm --filter nokker-vscode test:electron    # real VS Code under xvfb (@vscode/test-electron)
pnpm --filter nokker-vscode package          # nokker-vscode-<version>.vsix, local only
pnpm --filter nokker-vscode publish:check    # dry run of a publication: package + checks, nothing is uploaded
code --install-extension apps/vscode/nokker-vscode-0.2.0.vsix
```

`test:electron` starts the mock server with real writes, opens a throw-away folder in VS Code with the extension in
development mode, and checks: activation, commands and views, labels, connection by the local token, the Sessions
view, send selection, the quick fix on a problem, the last terminal output, a turn with two cards decided through the
API, the live editor, the native diff, refusing a file (strong card decided "in the terminal", file restored on disk),
a new session and resuming the first one. VS Code version: `$NOKKER_VSCODE_VERSION` (default `stable`; also run on
1.95.3, the declared minimum). `NOKKER_E2E_LOCALE=fr` runs it with VS Code in French; it needs the French language
pack once:

```sh
.vscode-test/vscode-linux-x64-<version>/bin/code --extensions-dir .vscode-test/extensions-fr \
  --install-extension ms-ceintl.vscode-language-pack-fr
```

`NOKKER_E2E_SHOT=<file.png>` (xvfb screen `-s "-screen 0 1400x900x24"`) saves screenshots of the panel.

`publish:check` builds the package and verifies what both registries require, offline: the `vsce package` checks,
the files in the package (no sources, source maps or `node_modules`), the icon, `engines.vscode`, no runtime
dependency, and the pre-upload checks of `ovsx` (publisher, name, version, license; `ovsx publish` has no dry-run
mode). Publishing itself needs a publisher account and is not done by any script here.

## Files

| File | Role |
|---|---|
| `src/extension.ts` | VS Code wiring: views, commands, native diff, live editor, notifications, status bar |
| `src/controller.ts` | logic of the extension, without the VS Code API (tested against the mock server) |
| `src/sessions.ts` | Sessions view model |
| `src/review.ts` | review of the writes of a turn, restore point, per-file restore |
| `src/live.ts` | live writing (`tool.input.delta`) |
| `src/context.ts` | context pieces: selection, files, problems, terminal output |
| `src/status.ts` | status bar and card notifications |
| `src/i18n.ts` | labels (`vscode.l10n`), translated choices and strong-card text |
| `src/connection.ts` | kernel and token, through the CLI code (`apps/cli/src/lokkal.ts`) |
| `src/webview/` | panel (DOM, Markdown as a tree) |
| `src/html.ts` | page and CSP |
| `l10n/`, `package.nls*.json` | French translations |
| `packages/sdk/src/editor-session.ts` | a turn seen from an editor, shared with `nokker acp` |
