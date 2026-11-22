import React from "react";
import { cardTarget, faceTarget, isCommandTool } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";

/** La FACE d'une carte : ce qui va partir, sur une ligne monospace, sans dépliage. Le champ `target` du noyau (lisible, caviardé,
 * 200 caractères au plus), tel quel, rogné à 120 caractères visibles ; jamais `arguments`. Rien si `target` est absent. */
export function ApprovalTargetLine({ approval }: { approval: { tool_name: string; target?: unknown } }): React.ReactElement | null {
  const full = cardTarget(approval);
  if (!full) return null;
  return (
    <p className="approval-target" data-approval-target>
      <span className="eyebrow">{isCommandTool(approval.tool_name) ? tr("Will run") : tr("Target")}</span>
      <code className="mono" title={full}>{faceTarget(full)}</code>
    </p>
  );
}

/** Le texte entier dans « Détails », seulement s'il a été rogné sur la face. */
export function ApprovalTargetFull({ approval }: { approval: { target?: unknown } }): React.ReactElement | null {
  const full = cardTarget(approval);
  if (!full || faceTarget(full) === full) return null;
  return (
    <>
      <dt>{tr("Target")}</dt>
      <dd className="mono approval-target-full" data-approval-target-full>{full}</dd>
    </>
  );
}
