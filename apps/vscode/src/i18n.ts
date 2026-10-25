/**
 * Libellés de l'extension : anglais par défaut, français quand VS Code est en français (`vscode.env.language` qui
 * commence par `fr`). Le texte source est l'anglais, la traduction vient de `l10n/bundle.l10n.fr.json` (l10n de VS Code,
 * `vscode.l10n.t`). Ici, rien ne dépend de l'API VS Code : la fonction de traduction est injectée (`vscode.l10n.t` dans
 * l'extension, `english` ou `fromBundle(...)` dans les tests).
 */
import {
  EDITOR_TEXTS_FR,
  STRONG_PHONE_TEXT,
  strongCardText,
  type Approval,
  type CostLang,
  type EditorTexts,
  type LocalChoice,
  type LocalToolEffect,
} from "@nokker-apps/sdk";

export type Translate = (message: string, ...args: Array<string | number | boolean>) => string;

/** `{0}`, `{1}`… remplacés par les arguments (même règle que `vscode.l10n.t`). */
export function formatMessage(message: string, args: ReadonlyArray<string | number | boolean>): string {
  return message.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
}

export const english: Translate = (message, ...args) => formatMessage(message, args);

/** Traduction par un paquet `{source anglaise: traduction}` (format de `bundle.l10n.<langue>.json`). */
export function fromBundle(bundle: Record<string, string>): Translate {
  return (message, ...args) => formatMessage(bundle[message] ?? message, args);
}

/** Langue des montants et des jetons (SDK) : `fr` si VS Code est en français, sinon `en`. */
export function costLang(vscodeLanguage: string | undefined): CostLang {
  return (vscodeLanguage ?? "").toLowerCase().startsWith("fr") ? "fr" : "en";
}

export function effectLabel(t: Translate, effect: LocalToolEffect | string | null | undefined): string {
  switch (effect) {
    case "read":
      return t("read");
    case "write":
      return t("write");
    case "destructive":
      return t("destructive");
    case "send_external":
      return t("send");
    case "spend":
      return t("spend");
    case "secret":
      return t("secret");
    default:
      return effect ? String(effect) : t("unknown");
  }
}

/** Libellé d'un choix de carte (mêmes choix et même ordre que le client terminal, `localChoices` du SDK). */
export function choiceLabel(t: Translate, c: Pick<LocalChoice, "id" | "key">, toolName: string): string {
  const file = toolName !== "terminal";
  switch (c.id) {
    case "once":
      return t("Once");
    case "session":
      return t("For this session");
    case "always":
      if (c.key === "3b") return file ? t("Always this folder (rule)") : t("Always commands starting with this prefix");
      return file ? t("Always this file (rule)") : t("Always this command");
    case "reject":
      return t("Reject");
  }
}

/** Texte d'une carte forte à la place des boutons : `strongCardText` du SDK décide (téléphone seulement si `forwarded`). */
export function strongText(t: Translate, a: Pick<Approval, "forwarded">): string {
  return strongCardText(a) === STRONG_PHONE_TEXT ? t("Strong action: it waits for your phone.") : t("Strong action: decide it in the terminal (`nokker`).");
}

/** Textes produits par la session du SDK (notices, aperçu d'un appel fermé par sa carte). */
export function editorTexts(t: Translate): EditorTexts {
  return {
    ...EDITOR_TEXTS_FR,
    subagentStarted: (goal) => t("Sub-agent started: {0}", goal),
    subagentFinished: (status, commits) => (commits ? t("Sub-agent finished ({0}): {1} commit(s)", status, commits) : t("Sub-agent finished ({0})", status)),
    imageSkipped: t("Image not read: the model has no vision."),
    approvedExecuted: t("Approved: run by the kernel."),
    executionFailed: t("Run failed."),
    cardExpired: t("Card expired: not run."),
    rejected: t("Rejected: not run."),
  };
}

/** Libellés du panneau (webview), calculés côté extension et passés à la page (attribut `data-strings`). */
export function webviewStrings(t: Translate): Record<string, string> {
  return {
    you: t("You"),
    nokker: t("Nokker"),
    connecting: t("Connecting to the kernel…"),
    placeholder: t("Ask Nokker… (Enter sends, Shift+Enter adds a line)"),
    message: t("Message"),
    send: t("Send"),
    stop: t("Stop"),
    addFile: t("Add a file (@)"),
    thread: t("thread {0}"),
    viewDiff: t("View diff: {0}"),
    viewCreated: t("View created file: {0}"),
    excerpt: t("(excerpt)"),
    preview: t("Preview"),
    cardTitle: t("Action to approve"),
    ruleTitle: t("Rule written to your Nokker settings: {0}"),
    approved: t("✓ Approved"),
    rejectedCard: t("✗ Rejected"),
    expired: t("⌛ Expired (rejected)"),
    cancelled: t("Cancelled"),
    decidedElsewhere: t("Decided elsewhere"),
    turnStopped: t("Turn stopped."),
    remove: t("Remove {0}"),
    liveOpen: t("Open the live view"),
    liveTruncated: t("… live view stopped (too long)"),
    liveDiscarded: t("Proposal discarded."),
    writing: t("writing {0}"),
    review: t("{0} file(s) changed in this turn"),
    reviewOpen: t("Review the changes"),
  };
}
