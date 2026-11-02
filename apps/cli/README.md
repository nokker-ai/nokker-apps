# nokker — terminal client

Terminal client for Nokker Lokkal: a code session in the current folder, against the core (or the `mock-server` for
development). Ink 8 + React 19, `nokker` binary, talks to the core through `@nokker-apps/sdk`.

## Usage

```
nokker                          code session in the current folder (resumes this folder's thread)
nokker -p "request"             one turn, answer on stdout (non-interactive mode)
nokker -p "request" --json      {reply, thread_id, cwd, pending_approvals, refused, cancelled, error, exit_code, cost?}
nokker doctor [--fix]           checks: docker, Lokkal compose, server, authentication, memory, version, git
nokker logs [-f] [-n N] [--since 1h|30m|2d] [--component core|cli]
nokker update [--check] [--version X.Y.Z]
                                updates the core with the install.sh of the target release (sha256 always, cosign if installed),
                                then replaces the binary; --check compares the installed version with the latest lokkal-v* release
nokker backup [--to <dir|s3://bucket/prefix>] [--keep N] [--encrypt]
                                full backup of the install through backup.sh (encryption required for S3)
nokker backup list [--to <dir|s3://…>]
nokker restore <file|s3://…> [--yes]
                                replaces the data of the install with a backup (asks for confirmation without --yes)
nokker import <claude-code|cursor|hermes|openclaw> [--project <dir>] [--apply] [--yes]
                                takes over another agent's install through a one-off kernel container (see below)
nokker acp                      ACP agent (Agent Client Protocol v1) on stdio, for an editor: Zed, JetBrains, Neovim…
nokker --server <url>           server (priority: --server > $NOKKER_SERVER_URL > api_url in lokkal.json > http://127.0.0.1:8742)
nokker --sound                  terminal bell on bubbles (off by default)
nokker --lang en|fr             interface language (otherwise NOKKER_LANG, LC_ALL, LC_MESSAGES, LANG; English by default)
```

### Importing another agent's install

`nokker import <source>` never mounts the other agent's folders into the running kernel. It asks the kernel which paths
the importer reads (`python3 -m nokker import <source> --list-paths`: one JSON line
`{"source", "paths": [{path, kind}], "project_paths": [{path, kind}]}`, relative paths, a fixed list per source), checks
them on the host, shows what will be mounted, then runs a one-off container
(`docker compose run --rm --no-deps --entrypoint python3 <core_service> -m nokker import <source> --home /import
[--project /import-project] --state-dir /opt/data`). The report lands in the kernel state
(`<NOKKER_STATE_DIR>/imports/<source>-<timestamp>/summary.md`, printed after the run, read by
`GET /v1/local/import/report`); the exit code is the container's (1 when the report holds errors).

- Checks done by the CLI whatever the kernel answers: absolute paths, `..` and `:` are refused; so is any path holding a
  credentials, identity or state file (`.credentials.json`, `credentials/`, `auth-profiles`, `identity/`, `devices/`,
  `.env`, `auth.json`, `state.db`, `workspace.zip`, `.openclaw/agents`, `memory/main.sqlite`, case-insensitive); paths
  missing on the host are ignored; a symbolic link leading outside the home folder (or the project) or to a refused file
  is refused; inside a mounted folder, a refused entry is hidden by an empty file or folder mounted over it. Everything
  is mounted read-only (`:ro`); files that may hold secrets in clear (`.claude.json`, agent config files) are only read
  inside the container, never copied or printed on the host.
- Dry run by default. `--apply` runs the dry run first, shows its report, asks `[y/N]` (`[o/N]` in French), then runs
  again with `--apply`; `--yes` skips the question; without a terminal and without `--yes`: exit code 2. The `--apply`
  run gets a terminal when the CLI has one, so the kernel can ask before adding each MCP server; without a terminal no
  MCP server is added (the CLI says so).
- `--project <dir>` (`claude-code`, `cursor` only; exit code 2 otherwise): the project paths are mounted read-only under
  `/import-project`, for every source, `--apply` included. Writes to the repository happen in the `--apply` run only and
  are listed before the question: `claude-code` mounts `<dir>/.nokker` read-write (created if missing; repository
  skills and the hooks block of `.nokker/settings.json`); `cursor` writes `NOKKER.md` to a temporary host folder (0700)
  mounted on `/import-out` (`--project-out /import-out`), and the CLI copies it to `<dir>/NOKKER.md` only if that file
  still does not exist (exclusive create, never an overwrite; an existing one is a `conflict` in the report). A project
  that is (or contains) the home folder is refused.
- Not followed: a custom `HERMES_HOME`, an OpenClaw `agents.defaults.workspace` outside `~/.openclaw`.
- Not available under WSL yet (paths cannot be checked from Windows): run it inside the distribution.

### Language

Labels are in **English by default**, in French when the language starts with `fr`: `--lang` > `NOKKER_LANG` > `LC_ALL` >
`LC_MESSAGES` > `LANG` (the first non-empty variable wins, as in POSIX; `C`/`POSIX` = English). `NOKKER_LANG=en` forces
English whatever the locale. Tool lines, cards, the cost line (`12.4k tokens · €0.03` / `12,4 k jetons · 0,03 €`), help
texts, `doctor`, `update`, `logs` and the ACP bridge all follow. The source text is English (`t("Once")`,
`src/i18n/index.ts`); translations live in a single catalogue (`src/i18n/fr.ts` and `fr-ops.ts`). `test/i18n.test.ts`
rejects a key without a translation, a dead key, mismatched `{n}` markers, a non-literal key, and any French string or JSX
text hard-coded outside the catalogue. The test suite runs in English; the French tests set the language themselves.

`doctor`, `logs`, `update`, `backup` and `import` explain a missing docker or unknown compose cleanly (no stack trace); `logs --component cli`
and `doctor` work without docker.

### In a session

- Each tool call: `⟳ patch src/app.py (write)` then `✓ patch src/app.py 120 ms`. Effects in plain words: read / write /
  destructive / send / spend / secret. The result preview is folded to 3 lines: `o` (empty input field) or `/out`
  unfolds it; `/tools` unfolds everything. Sub-agents are indented lines.
- Default mode of a local session: `accept_edits` — `write_file`/`patch` inside the folder pass without a card; `terminal`
  commands (tests, build) ask for a local card; destructive effects ask for a "strong-local" card (no "Always"). A
  forbidden command (hardline: `rm -rf /`, mkfs…) is refused without a card: the tool line shows the refusal.
- **"Action to approve" card** (tool, effect, command or path): `1. Once · 2. For this session · 3. Always this command ·
  3b. Always commands starting with this prefix · 4. Reject`; ↑/↓, digits, Enter. For a **test command**
  (`pytest|unittest|npm test|pnpm test|yarn test|go test|cargo test|make test|vitest|jest`) the order becomes
  `1. For this session · 2. Once · 3. Always… · 4. Reject` (the key shown is the key to press). "3"/"3b" show the exact
  rule that will be written to your Nokker settings (`settings.json` in the state folder) before Enter confirms it. No 3
  on a strong or destructive card; the rule sent is always one of the card's `suggested_rules`. Esc does not decide;
  Ctrl+C = reject (then cancels the turn); a 300 s countdown, then an "expired" rejection; a summary line stays in the
  thread. With a core that sends `suggested_rule_kinds` (01.11), "for this session" and "always" name what the rule
  covers: "this tool" (a `delegate` card only offers this one), "this file", "this folder", "commands starting with
  “git commit”", "this exact command"; an older core keeps the labels above.
- Esc on a streamed answer: the core drops the partial text (`reset`) and ends the turn on its final answer ("Annulé à
  ta demande."); the client shows only that answer, then "turn cancelled". `/cancel` when nothing runs: the core still
  acknowledges with the thread id, and `running: false` makes the client say "No turn in progress." (an older core
  without `running`: the previous reading).
- `strong` card (web): decided on the phone; the CLI no longer signs with its software key (refused by the core).
- What you type during "connecting…" is queued and sent once the session is open (`/confirm`, `/quit` and `/help` run
  immediately). The header truncates the thread title to 32 characters; a card's countdown shows "24 h", "59 min", then
  "m:ss".
- Esc during a turn = `POST /v1/threads/{id}/cancel` (the core stops the turn), not just the display.
- **Cost per turn**: under each turn, a discreet line taken from the `turn.cost` event (published just before
  `turn.done`): `· 12.4k tokens · €0.03`, or tokens only when the model has no price in the core's catalogue (never a
  guessed price; the currency is the catalogue's, several currencies are joined with "+"). `/cost` shows the session
  (thread and sub-agents) and the UTC day, read from `GET /v1/local/cost`; on anything but a local core: "not available
  on this server". Formatting is shared with the web app: `formatCostLine` in the SDK. With `-p --json`, the `cost` field
  copies the event (without `type`). The mock publishes a `turn.cost` in EUR on every turn.
- Commands: `/sessions` (folders), `/threads`, `/goto`, `/thread [title]` (new thread; `/new` is reserved for the core's
  episode boundary), `/init`, `/export`, `/cost`, `/cancel` (aliases `/pause`, `/stop`), `/out`, `/tools`, `/bubbles`, `/bubble`, `/send`, `/ask`, `/approvals`,
  `/confirm <TOTP>`, `/login`, `/help`, `/quit`, and, **in a code session** (elsewhere: "available in a code session
  (nokker in a folder)"):

  | Command | Core tool | Rendering |
  |---|---|---|
  | `/diff [hash\|n]` | `checkpoint_diff` | green/red diff in the thread, truncated to 300 lines (the rest is mentioned) |
  | `/checkpoints` | `checkpoint_list` | short hash, time, reason, files (no. 1 = the most recent); the reason is translated from the core's stable code (`reason_codes[hash]`: `before_<tool>` → "before <tool>", `before_rollback`, `manual`, `auto`, `session_start`, `other`), the core's text when it gives no code |
  | `/rollback [hash\|n]` | `checkpoint_restore {safe:true}` | "Action to approve" card (the same card as a destructive command), then restored / kept files; without an argument: the latest checkpoint |
  | `/skills [name]` | `skill_list` / `skill_view` | trust state of the repository skills first, then a table by family (`[project]` = repository skill) / rendered Markdown body |
  | `/skills trust` | `POST /v1/local/skills/trust` | reopens the trust card (see below) |
  | `/plan` | `todo` | bullet list with state (`[x]` done, `[~]` in progress, `[ ]` to do) |
  | `/agents [id]` | `delegate_status` + `subagent.*` events | id, state, (background), truncated goal, last tool, duration, commits, result; with an id (or a prefix): everything, including the full result |
  | `/agents cancel <id\|all>` | `delegate_cancel` / `POST /v1/threads/{id}/cancel` | `all` stops every sub-agent of the thread (and the turn in progress); a single one: see "Limits" |
  | `/memory [note]` | `memory {action: list\|view}` + `GET /v1/local/memory` | learned notes (kind, scope, origin, always in context or recalled), sections of the instruction files, state of the long-term memory / one note or section |
  | `/mode [name]` | `GET\|PUT /v1/local/sessions/{thread}/mode` | without a name: the mode chosen for the session, the mode in effect (stricter when the repository's `.nokker/settings.json` or a team imposes one) and the list (`default`, `accept_edits`, `auto`, `plan`); with a name: changes it for this session and its sub-agents only, until the core restarts. "Unknown mode" / "refused: the repository or a team imposes a stricter mode" on a 400. The status line shows `mode: plan` (or `mode: auto → default` when restricted), updated by the `session.mode` event, whoever changed it |
  | `/memory forget <note>` | `memory {action: forget}` | confirmation card (y/Enter, n/Esc), then the forget; in `default` mode the forget (WRITE) also goes through a core card; a section of a file cannot be forgotten (edit the file) |

### `@` references in a message

Before sending, `@path` tokens (relative to the session folder, preceded by a space or the start of the line) are expanded:
a text file is inlined in a delimited block (100 KB per file, 300 KB in total, truncated beyond with a mention); an image
(png, jpeg, webp, gif; 4 per message, 5 MB each) is sent as `attachments: [{path}]` (the core reads it in the session
folder, LOKKAL.md §7.6); a folder is listed (depth 2, 200 entries, `.git` and `node_modules` skipped); `@http(s)://…` is
never downloaded, the message just asks the model to read it with its `web_fetch` tool. A path leaving the folder (`..`,
absolute outside, symlink) is refused; an `@` matching nothing (mail address…) stays as typed. Tab completes the last
`@path` of the line. `nokker -p` expands them too. `/init` asks the agent to write or complete `AGENTS.md`; `/export
[md|html] [file]` writes the whole thread (tool calls excluded: the core does not serve them).

### Repository skills: trust card

A repository's skills (`.nokker/skills/<family>/<skill>/SKILL.md`) are instructions written by a third party: the core
ignores them until the user has trusted THIS folder and THIS fingerprint (sha256 of the whole tree). When the
`POST /v1/local/sessions` response carries `skills.project: "untrusted"`, or on the `skill.untrusted` event (the tree
changed during the session), the CLI opens a "Trust this repository's skills?" card: root, number of skills, full
fingerprint. `y` = `POST /v1/local/skills/trust {thread_id, sha256}` (409: the tree changed since it was read, a new card
follows); Enter NEVER means trust, and the card ignores keys during its first 500 ms (a command being typed does not
answer it); `n`/Esc = nothing (the skills stay ignored, `/skills trust` later). One card per fingerprint. A core without
repository skills (`local.project_skills` flag off: no `skills` key) or a resumed session (the core only gives the state
when the session opens): `/skills` says so.

### Local tool-call route

`POST /v1/local/tools/call {thread_id, name, arguments}` (local token; local session threads only, otherwise 404). Core
allow-list `checkpoint_list|checkpoint_diff|checkpoint_create|checkpoint_restore|skill_list|skill_view|todo`, plus
`memory` (`local.project_memory` flag), `delegate_status` and `delegate_cancel` (local server; `delegate_cancel` since core
03c3164, older cores answer 403); any other name: 403; `todo` is read-only: `arguments` must be `{}`, otherwise 400; `delegate_status` without `wait_s`, otherwise 400; 409 if
a turn is running on the thread, the CLI shows "a turn is in progress, try again afterwards" (for `/agents`, the state then
comes from the events).
`200 {content, is_error}` if the tool is allowed (READ/WRITE); a refusal by a rule or by plan mode is also a
`200 {content, is_error: true}`; `202 {approval_id}` if the effect needs a card (`checkpoint_restore`: DESTRUCTIVE): the
card follows the normal path (`approval.requested`, `GET /v1/local/approvals`, `decide`) and the result (a rejected card
included: `is_error: true`) arrives in ONE `tool.result {thread_id, approval_id, content, is_error}` event, with no model
turn and no other event.
`content` is the tool's result text as is (shapes measured on the core): `checkpoint_list` = a BARE JSON list
`[{hash, short_hash, timestamp, reason, files_changed, insertions, deletions, thread_id?, turn_index?, tool?}]` (the last
three: core of 25.10, when the checkpoint is tied to a turn; `/checkpoints` then shows "turn n") (the CLI also accepts
`{checkpoints}`); `checkpoint_diff` = `{stat, diff, message?}`; `checkpoint_restore` =
`{success, restored_files, skipped_user_edits}`; `skill_list` = `{skills:[…]}`; `skill_view` = Markdown; `todo` =
`{todos, revision, summary}`; `memory list` = `{project, notes:[{name, kind, scope, title, origin, derived_from, created,
links, in_core}], sources:[{path, sections:[{name, title, in_core}]}]}`, `view` = the note (`text`) or the section
(`source`), `forget` = `{forgotten}`; `delegate_status` = `{children:[{child_id, thread_id, goal, elapsed_s, status:
queued|running|stopping|completed|failed|interrupted, last_tool?, exit_reason?, summary?, worktree?, tokens?, cost?}],
running, finished, unknown?}`. `checkpoint_create` answers 202 (card) until it becomes a 200 in accept_edits: the CLI
handles both. The card of a direct call has `channel: "local-direct"`; the `tool.result` has no `call_id` (matched by
`approval_id`). Errors: 400 (invalid arguments) and 403 (tool not callable directly): the CLI shows `error.message` as is.
The path lives in `LOCAL_TOOL_CALL_PATH` (`packages/sdk/src/client.ts`); SDK: `callLocalTool(threadId, name, args)`. The
mock simulates 3 checkpoints, 4 skills and a 3-step plan.

### Non-interactive mode and usage errors

An unknown argument or flag (`nokker status`) exits with "unknown argument: … (nokker --help)" on stderr, code 2. Without
a terminal (stdin or stdout not a TTY) the TUI never starts: "interactive mode needs a terminal; use nokker -p "…"",
code 2.

In a local session nobody can decide a card: any effect the core has not already covered with a rule is **refused by
default** (unattended mode) and listed in `refused` (`tool`, `effect`, `target`). Cards of an ordinary thread stay
`pending` (`pending_approvals`).

Exit codes of `nokker -p`, read from the core's `turn.done` (fields of the 01.11 core; an older core sends none of them,
so only the CLI's own `refused` list counts):

| Code | When |
|------|------|
| 0 | the turn finished |
| 3 | an effect was refused: `turn.done.refused` (deny rule, plan mode, hardline command, invariant) or a card the CLI rejected (`refused` not empty) |
| 4 | the turn failed: `turn.done.error {code, message}`, code `tier_unavailable`, `provider_error`, `max_calls`, `stopped` or `internal_error` |
| 130 | the turn was cancelled (`turn.done.cancelled`) |
| 1 | client error (connection, authentication…) |

When several apply, the first of **4 > 130 > 3** wins: a failure says more than a cancellation, a cancellation more than
a refusal. With `--json`, the output carries `error` (`{code, message}` or `null`) and `exit_code`; without it, the
reply goes to stdout and the failure ("Turn failed (provider_error): …") or cancellation to stderr.

## Editors: `nokker acp`

`nokker acp` speaks the **Agent Client Protocol** (v1, the stable version of the official SDK `@agentclientprotocol/sdk`
2.0.2: JSON-RPC 2.0, one JSON message per line on stdin/stdout; nothing else on stdout, the log goes to `cli.log`). It
bridges to the core's local API, with the same token as the CLI:

| ACP | Core |
|---|---|
| `initialize` | protocol 1; `loadSession`, images, embedded context, `session/list`; no authentication method (local token) |
| `session/new {cwd}` | `POST /v1/local/sessions {cwd}` (new thread for the editor's folder); outside the roots: a clear `-32602` error |
| `session/load`, `session/list` | `GET /v1/local/sessions`, history replayed from `GET /v1/threads/{id}` |
| `session/prompt` | streamed `POST /v1/chat/completions` → `agent_message_chunk` (additions only); images → `attachments` (§7.6); embedded file → context block; file link → `@path` |
| `tool_call` / `tool_call_update` | `tool.call` / `tool.result`: `kind` from the tool and the effect, `locations`, redacted `rawInput`, `diff` content for `patch`/`write_file` (file read before and after, otherwise the replaced passage) |
| `session/request_permission` | local card (`GET /v1/local/approvals`), options = the same choices as the CLI (`allow_once` = once, `allow_always` = for the session / always + rule, `reject_once` = reject), decision `POST /v1/local/approvals/{id}/decide`; one decision per card, at most 25 per turn; the request is withdrawn with `$/cancel_request` if the card is decided elsewhere or expires |
| strong card | never offered to the editor: the call says where it waits — "Strong action: it waits for your phone." if the core forwarded it to nokker.ai (`forwarded`, `approval.forwarded`, linked machine), otherwise "Strong action: decide it in the terminal (`nokker`)."; the text changes if it goes to the phone afterwards |
| `session/cancel` | `POST /v1/threads/{id}/cancel`, answer `stopReason: "cancelled"` |
| `/cost`, `/diff [hash]`, `/plan`, `/checkpoints` | announced commands (`available_commands_update`), without a model turn (`GET /v1/local/cost`, `POST /v1/local/tools/call`); `/plan` → `plan` update |

An ACP request lasts until all its follow-ups are done: on the core, a card hands control back to the model ("waiting for
approval"); the decision answers immediately (`202`, `continuation: running|queued`) and the core queues the tool, then a
follow-up turn, on the thread, behind the turn that raised the card (a rejection starts nothing: `200`,
`continuation: none`). The approved call closes on the executor's `tool.result` (same `call_id`, with `approval_id`): its
real output. `session/prompt` only answers once no card is open, no decision is in flight, and no approved tool is
waiting for its result or follow-up turn. A cost line under each turn (`_12.4k tokens · €0.03_`, turned off with
`NOKKER_ACP_COST_LINE=0`) and the turn's cost in `_meta.nokker.cost` of the answer. MCP servers offered by the editor are
ignored (connectors live in the core).

**Zed** (`agent: open settings` → External Agents → Add Custom Agent, or directly in `settings.json`):

```json
{
  "agent_servers": {
    "Nokker": {
      "type": "custom",
      "command": "nokker",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Then "New Thread" → Nokker in the Agent panel. Use an absolute path if `nokker` is not in Zed's `PATH`
(`~/.nokker/bin/nokker` with the installer); another core: `"args": ["acp", "--server", "http://127.0.0.1:18742"]`.
Protocol log on the Zed side: `dev: open acp logs`; on the Nokker side: `nokker logs --component cli`.

## Sign-in

1. Local server (127.0.0.1/localhost) and a local token present (at `token_path` in lokkal.json, otherwise
   `~/.config/nokker/local-token`): the token is sent as `Authorization: Bearer` (no enrolment; checked by a call,
   otherwise falls back to 2).
2. Otherwise, device flow: P-256 key (keychain or 0600 file), enrolment with a declared `user` (`$NOKKER_USER`, otherwise
   the system user). If the device is `pending`, the **code** is shown and the CLI waits for the confirmation (on the
   host, or `/confirm <TOTP>` / `NOKKER_TOTP` with `-p`), then opens the 12 h session.

## Variables and files

| Name | Role |
|---|---|
| `NOKKER_SERVER_URL` | server (default `http://127.0.0.1:8742`; the dev mock runs on 4310) |
| `NOKKER_LANG` | `en` or `fr`; takes precedence over the system locale (`--lang` takes precedence over it) |
| `NOKKER_CONFIG_DIR_OVERRIDE` | replaces `~/.config/nokker` (tests, isolation) |
| `NOKKER_USER` | user declared at device enrolment |
| `NOKKER_TOTP` | confirms the device immediately in `-p` mode |
| `token_path` (lokkal.json) | local token written by the core (0600), e.g. `~/.nokker/state/local-token`; otherwise `~/.config/nokker/local-token` |
| `settings.json` (core state folder) | `{"permissions": {"mode", "allow", "ask", "deny"}}`; "Always" adds an `allow` rule to it (with the compose: `~/.nokker/state/settings.json`) |
| `~/.config/nokker/lokkal.json` (Windows: `%USERPROFILE%\.config\nokker`, Linux/macOS: `$XDG_CONFIG_HOME/nokker` if set) | written as 0600 by install.sh (schema below; `install_dir`, and `wsl_distro` on Windows) |
| `~/.config/nokker/cli.log` | client log (`nokker logs --component cli`) |

### lokkal.json

The config folder is the same on all 3 OSes (the installer's). Old locations are still READ as a fallback (macOS
`~/Library/Application Support/nokker`, Windows `%APPDATA%\nokker`); `doctor` warns if it finds a file there.

```json
{"compose": "/abs/docker-compose.yml", "project": "nokker", "version": "0.1.0", "core_service": "core",
 "api_url": "http://127.0.0.1:8742", "web_url": "http://127.0.0.1:7420",
 "token_path": "/abs/.nokker/state/local-token", "env_file": "/abs/.nokker/.env", "install_dir": "/abs/.nokker"}
```

lokkal.json has 9 keys: the 8 above (required; compose, token_path, env_file absolute) plus `install_dir` (path of
`~/.nokker`, always written by install.sh, required under WSL), and the optional `wsl_distro` (Windows). A missing key
gives a clear message (`doctor`, `logs`, `update`, `backup`). The API port is not fixed (`NOKKER_API_PORT`): install.sh writes the
real one into `api_url`. `doctor` also checks `GET <web_url>/healthz`. `logs` = `docker compose -p <project> -f <compose>
logs <core_service>`.

### Windows (WSL 2)

Lokkal runs in WSL 2; `nokker.exe` is in `%LOCALAPPDATA%\Nokker\bin`, `lokkal.json` in `%USERPROFILE%\.config\nokker\`.
With `"wsl_distro": "<distro>"`: `compose`, `env_file` and `install_dir` are Linux paths, `token_path` is a UNC path
(`\\wsl.localhost\<distro>\home\…\local-token`) read as is, and `update`, `logs` and the docker check of `doctor` go
through `wsl.exe -d <distro> -- …` (`update` runs the downloaded installer through `wslpath -u`, `backup` =
`wsl.exe -d <distro> -- sh <install_dir>/backup.sh …`, the passphrase crossing over through `WSLENV`).
`api_url`/`web_url` on 127.0.0.1 work as is. Elsewhere, `install_dir` (`~/.nokker`) is also written.

### update

`nokker update [--version X.Y.Z]`: the target is `--version` or the latest `lokkal-v*` release. The CLI does NOT run the
installer already on disk (the one of the INSTALLED version): it downloads `install.sh` from the target release
(`https://github.com/nokker-ai/nokker/releases/download/lokkal-v<version>/install.sh`) with its `.sha256` and
`.sigstore.json`, into a 0700 temporary folder. The sha256 is ALWAYS checked; the signature is checked with
`cosign verify-blob` (same identity and issuer as install.sh: the `lokkal-images.yml` workflow on a `lokkal-v` tag,
`https://token.actions.githubusercontent.com`) if `cosign` is installed, otherwise the output says it was NOT verified. A
wrong or missing checksum, or a bad signature, stops everything: nothing is run. Then
`sh <install.sh> --update --version <target> [--dir <install_dir>]`. A release without `install.sh` falls back to
rewriting `NOKKER_VERSION=<target>` in `env_file`, then `docker compose -p … pull && up -d`. Either way it waits for
`/healthz`. A downgrade asked with `--version` is refused (migrations only go forward). It ends by replacing the binary with
`nokker-<os>-<arch>` from the same release: `.sha256` (`sha256sum` output) REQUIRED, plus `cosign verify-blob --bundle` if
`cosign` is installed (failure = no replacement); written next to it, then an atomic `rename` (Windows:
`nokker.exe.new`). Without a network, `--check` says so and exits normally.

### backup and restore

`nokker backup`, `nokker backup list` and `nokker restore` run `backup.sh` (laid down by install.sh): `<install_dir>/backup.sh`
from lokkal.json, otherwise `~/.nokker/backup.sh`; `--dir <install_dir>` is passed when lokkal.json gives it. Options map
one to one (`--to`, `--keep`, `--encrypt`, restore `<file|s3://…>`; relative folders are made absolute) and the exit code
is backup.sh's.

- **S3 is always encrypted**: `--to s3://…` without `--encrypt` is refused (code 2). S3 credentials are backup.sh's:
  `NOKKER_BACKUP_S3_ENDPOINT`, `NOKKER_BACKUP_S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, in the environment or
  `~/.nokker/backup.env`. `--keep` only prunes folder targets.
- **Passphrase** (encrypted backup, restore of a `.enc`): asked on the terminal without echo (twice for a backup), never
  accepted as an argument, handed to backup.sh through `NOKKER_BACKUP_PASSPHRASE`. If that variable is already set, it is
  used as is. Required with no terminal: clear error, code 2.
- **restore** replaces the data of the install: without `--yes` the CLI asks for an explicit confirmation (no terminal:
  code 2), then calls backup.sh with `--yes`. A backup made by a newer version is refused by backup.sh until
  `nokker update --version <that version>`.

Rules: `tool` or `tool(pattern)`, a case-sensitive fnmatch pattern compared with the whole command (`terminal`) or with the
normalised path (`write_file`, `read_file`, `patch`). Core order: deny, plan, ask, allow, mode.

## Standalone binary

```
pnpm -C apps/cli build:bin                 # dist/nokker-{linux-x64,linux-arm64,darwin-x64,darwin-arm64,windows-x64.exe,windows-arm64.exe} + .sha256
bash apps/cli/scripts/build-bin.sh linux-x64
```

`bun build --compile` (bun ≥ 1.4, `$BUN` or `~/.bun/bin/bun`) via `scripts/build-bin.ts`: `react-devtools-core` (a static
import of Ink, useless outside DEV) is replaced by an empty module; the version is fixed at compile time
(`$NOKKER_RELEASE_VERSION`, otherwise package.json). install.sh puts it in `~/.nokker/bin/nokker`.

## Development

```
pnpm -C packages/mock-server dev       # MOCK_PORT=4320 NOKKER_CONFIG_DIR_OVERRIDE=/tmp/cfg to overwrite nothing
pnpm -C apps/cli start -- --server http://127.0.0.1:4320
pnpm -C apps/cli typecheck && pnpm -C apps/cli test
```

Mock: `MOCK_LOCAL_ROOTS` (roots separated by `:`, accepts everything by default), `MOCK_MIN_CLIENT_VERSION`,
`MOCK_DEVICE_PENDING=1` (devices stay `pending` until TOTP `000000`), `MOCK_PROJECT_MEMORY=0` (`memory` tool off, like the
core flag), `MOCK_PROJECT_SKILLS=1` (repository skills read, fingerprint computed like the core, trust stored in
`settings.json`). In a local session, "fix the test X" (or the French "corrige le test X") triggers read_file →
search_files → patch → pytest → `rm -rf build` (card); "rm -rf /" triggers a hardline card; "sub-agent" (or "sous-agent")
triggers a foreground sub-agent, "background" (or "en arrière-plan") two background sub-agents (`delegate_status`,
cancelling the thread).

### Limits (missing core routes)

- Stopping ONE background sub-agent: needs a core that allows `delegate_cancel` on `POST /v1/local/tools/call` (core
  03c3164 and later). On an older core (403), `POST /v1/threads/{id}/cancel` does not recognise a `<parent>/sa-<id>`
  thread (the id contains a `/`): the CLI then suggests `/agents cancel all`.
- Trust state of the skills of a resumed session: only given by the response that opens it. Reopening the thread
  (`POST /v1/local/sessions {cwd, resume}`, accepted by the core of 25.10) would return it, but replaces the thread's code
  source (sandbox): the CLI does not do it and shows it as "unknown".

### Measuring pty driver (`test/pty_drive.py`)

Step-by-step mode (`pty_drive.py '<json>'`, see the header) and scenario mode, which plays a task end to end without ever
replaying a decision:

```
python3 apps/cli/test/pty_drive.py --task "fix the test add" --server http://127.0.0.1:4320 \
  --cwd /work/project --config-dir /tmp/cfg --max-decisions 3 --decide 1
# -> {"cards":[{"t":3.1,"tool":"terminal","command":"pytest -q …"}],"turns_user":1,"duration_s":9.4,"final_text":"…","bounded":false,"error":null}
```

Cards are detected ONLY through `GET /v1/local/approvals` (a new id = one decision, never two for the same id); the card's
rendering is awaited on the screen delta since the detection, never on the cumulative buffer; beyond `--max-decisions` it
stops (`bounded: true`) without deciding; it ends when no card is waiting any more and the screen has been silent for
`--idle` s (12). `--decide` is the key sent (1 or 2: the order depends on the card, see test commands). `turns_user` and
`final_text` are read from `GET /v1/threads/{id}`. Never point it at the real core without a bound.
