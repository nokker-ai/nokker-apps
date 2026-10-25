# Changelog

## Unreleased

- Sessions view: title, last turn, working state and cards come from the session list of the kernel when it gives them
  (no extra thread listing); older kernels keep the previous behaviour.
- Changes view: the restore point of the turn is the one the kernel announces (`checkpoint.created`); refusing a file
  created by the turn lets the kernel delete it (a copy stays in a "before rollback" point). Older kernels: list
  comparison and the trash, as before.

## 0.2.0

- **Sessions view**: the coding sessions of the local kernel, those of the open folder first, with their live state
  (working, cards waiting) and cumulated cost; resume a session, start a new one in the open folder.
- **Changes view**: the files written by the last turn, native diff per file, accept or refuse per file. Refusing
  restores the file from the restore point the kernel took before the turn (a strong card, decided in the terminal or
  on the phone); a file created by the turn can be moved to the trash.
- **Live writing**: what the model writes in `write_file` / `patch` streams in the panel and in a read-only editor
  before the tool runs.
- **Context**: files (`@`), problems (quick fix "Fix with Nokker"), last output of the active terminal (shell
  integration), in addition to the selection.
- **Approval notifications** with *Once*, *For this session*, *Reject* for standard cards; never an action on a strong
  card.
- **Status bar**: tier, model and cost of the last turn, cards waiting.
- Labels in English by default, in French when VS Code is in French.
- Packaging ready for publication: icon, README, changelog, `publish:check` dry run (nothing is uploaded).

## 0.1.0

- Chat panel on the coding session of the open folder: live replies, tool calls, approval cards, native diff for
  patches, cost line, send selection, images by `@path`, stop.
