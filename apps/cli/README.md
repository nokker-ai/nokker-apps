# nokker — terminal client

Terminal client for Nokker Lokkal: a code session in the current folder, against the core (or the `mock-server` for
development). Ink 8 + React 19, `nokker` binary, talks to the core through `@nokker-apps/sdk`.

## Usage

```
nokker                          code session in the current folder (resumes this folder's thread)
nokker -p "request"             one turn, answer on stdout (non-interactive mode)
nokker -p "request" --json      {reply, thread_id, cwd, pending_approvals, refused, cancelled, cost?}
nokker doctor [--fix]           checks: docker, Lokkal compose, server, authentication, memory, version, git
nokker logs [-f] [-n N] [--since 1h|30m|2d] [--component core|cli]
nokker update [--check]         updates the core (install.sh --update, otherwise env_file + compose pull/up), then replaces the binary;
                                --check compares the installed version with the latest lokkal-v* release
nokker acp                      ACP agent (Agent Client Protocol v1) on stdio, for an editor: Zed, JetBrains, Neovim…
nokker --server <url>           server (priority: --server > $NOKKER_SERVER_URL > api_url in lokkal.json > http://127.0.0.1:8742)
nokker --sound                  terminal bell on bubbles (off by default)
nokker --lang en|fr             interface language (otherwise NOKKER_LANG, LC_ALL, LC_MESSAGES, LANG; English by default)
```

### Language

Labels are in **English by default**, in French when the language starts with `fr`: `--lang` > `NOKKER_LANG` > `LC_ALL` >
`LC_MESSAGES` > `LANG` (the first non-empty variable wins, as in POSIX; `C`/`POSIX` = English). `NOKKER_LANG=en` forces
English whatever the locale. Tool lines, cards, the cost line (`12.4k tokens · €0.03` / `12,4 k jetons · 0,03 €`), help
texts, `doctor`, `update`, `logs` and the ACP bridge all follow. The source text is English (`t("Once")`,
`src/i18n/index.ts`); translations live in a single catalogue (`src/i18n/fr.ts` and `fr-ops.ts`). `test/i18n.test.ts`
rejects a key without a translation, a dead key, mismatched `{n}` markers, a non-literal key, and any French string or JSX
text hard-coded outside the catalogue. The test suite runs in English; the French tests set the language themselves.

`doctor`, `logs` and `update` explain a missing docker or unknown compose cleanly (no stack trace); `logs --component cli`
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
  thread.
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
  episode boundary), `/cost`, `/cancel`, `/out`, `/tools`, `/bubbles`, `/bubble`, `/send`, `/ask`, `/approvals`,
  `/confirm <TOTP>`, `/login`, `/help`, `/quit`, and, **in a code session** (elsewhere: "available in a code session
  (nokker in a folder)"):

  | Command | Core tool | Rendering |
  |---|---|---|
  | `/diff [hash\|n]` | `checkpoint_diff` | green/red diff in the thread, truncated to 300 lines (the rest is mentioned) |
  | `/checkpoints` | `checkpoint_list` | short hash, time, reason, files (no. 1 = the most recent) |
  | `/rollback [hash\|n]` | `checkpoint_restore {safe:true}` | "Action to approve" card (the same card as a destructive command), then restored / kept files; without an argument: the latest checkpoint |
  | `/skills [name]` | `skill_list` / `skill_view` | trust state of the repository skills first, then a table by family (`[project]` = repository skill) / rendered Markdown body |
  | `/skills trust` | `POST /v1/local/skills/trust` | reopens the trust card (see below) |
  | `/plan` | `todo` | bullet list with state (`[x]` done, `[~]` in progress, `[ ]` to do) |
  | `/agents [id]` | `delegate_status` + `subagent.*` events | id, state, (background), truncated goal, last tool, duration, commits, result; with an id (or a prefix): everything, including the full result |
  | `/agents cancel <id\|all>` | `delegate_cancel` / `POST /v1/threads/{id}/cancel` | `all` stops every sub-agent of the thread (and the turn in progress); a single one: see "Limits" |
  | `/memory [note]` | `memory {action: list\|view}` + `GET /v1/local/memory` | learned notes (kind, scope, origin, always in context or recalled), sections of the instruction files, state of the long-term memory / one note or section |
  | `/memory forget <note>` | `memory {action: forget}` | confirmation card (y/Enter, n/Esc), then the forget; in `default` mode the forget (WRITE) also goes through a core card; a section of a file cannot be forgotten (edit the file) |

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
`memory` (`local.project_memory` flag) and `delegate_status` (local server); any other name (including `delegate_cancel`):
403; `todo` is read-only: `arguments` must be `{}`, otherwise 400; `delegate_status` without `wait_s`, otherwise 400; 409 if
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
gives a clear message (`doctor`, `logs`, `update`). The API port is not fixed (`NOKKER_API_PORT`): install.sh writes the
real one into `api_url`. `doctor` also checks `GET <web_url>/healthz`. `logs` = `docker compose -p <project> -f <compose>
logs <core_service>`.

### Windows (WSL 2)

Lokkal runs in WSL 2; `nokker.exe` is in `%LOCALAPPDATA%\Nokker\bin`, `lokkal.json` in `%USERPROFILE%\.config\nokker\`.
With `"wsl_distro": "<distro>"`: `compose`, `env_file` and `install_dir` are Linux paths, `token_path` is a UNC path
(`\\wsl.localhost\<distro>\home\…\local-token`) read as is, and `update`, `logs` and the docker check of `doctor` go
through `wsl.exe -d <distro> -- …` (`update` = `wsl.exe -d <distro> -- sh <install_dir>/install.sh --update`).
`api_url`/`web_url` on 127.0.0.1 work as is. Elsewhere, `install_dir` (`~/.nokker`) is also written:
`<install_dir>/install.sh --update` is preferred.

### update

`nokker update`: `install.sh --update` if it sits next to the compose (or `~/.nokker/install.sh`), otherwise it rewrites
`NOKKER_VERSION=<target>` in `env_file`, then runs `docker compose -p … pull && up -d` and waits for `/healthz`. It ends by
replacing the binary with `nokker-<os>-<arch>` from the `lokkal-v<version>` release: `.sha256` (`sha256sum` output)
REQUIRED, plus `cosign verify-blob --bundle` if `cosign` is installed (failure = no replacement); written next to it, then
an atomic `rename` (Windows: `nokker.exe.new`). Without a network, `--check` says so and exits normally.

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

- Stopping ONE background sub-agent: `delegate_cancel` is not in the allow-list of `POST /v1/local/tools/call` (403), and
  `POST /v1/threads/{id}/cancel` does not recognise a `<parent>/sa-<id>` thread (the id contains a `/`). The CLI tries
  `delegate_cancel`, then suggests `/agents cancel all`.
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
