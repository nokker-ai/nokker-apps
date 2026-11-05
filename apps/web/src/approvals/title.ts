/**
 * Title of an `approval` bubble for the person (core p2/approval-bubble: the kernel titles it with the raw tool name):
 * what is decided, in the interface language, never `pay_request` or an English tool label. Display only — the card
 * itself is read again from GET /v1/approvals/{id}.
 */
import { PAY_TOOL, type ApprovalBubbleState, type BubbleStatus } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";

export function approvalTitle(b: { state?: Partial<ApprovalBubbleState> | null; status?: BubbleStatus | string }): string {
  const s = b.state ?? {};
  const status = s.status ?? (b.status === "working" ? "pending" : b.status === "failed" ? "failed" : "approved");
  const pay = s.tool_name === PAY_TOOL;
  switch (status) {
    case "pending":
      return pay ? tr("Payment to approve") : tr("Action to approve");
    case "approved":
    case "executed":
      return pay ? tr("Payment approved") : tr("Action approved");
    case "rejected":
      return pay ? tr("Payment refused") : tr("Action refused");
    case "expired":
      return pay ? tr("Payment expired") : tr("Action expired");
    default:
      return pay ? tr("Payment stopped") : tr("Action failed");
  }
}
