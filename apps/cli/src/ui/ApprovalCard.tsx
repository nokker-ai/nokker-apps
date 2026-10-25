/**
 * Carte d'approbation en ligne (APPROVALS.md, LOKKAL-CLI.md §2.2).
 *
 *  - `local` : cadre « Action à approuver » (outil, effet, commande ou chemin) puis
 *    `1. Une fois · 2. Pour cette session · 3. Toujours (règle) · 4. Refuser` ; ↑/↓, chiffres, Entrée.
 *    Échap ne décide pas ; Ctrl+C (géré par l'App) = refus + annulation du tour ; compte à rebours puis
 *    refus « expirée ». Avant de valider « 3 », la règle exacte qui sera écrite est montrée.
 *  - `strong` : « décider sur téléphone » — la CLI ne signe PLUS avec sa clé logicielle (refusé par le noyau).
 *  - `standard` : téléphone (signature d'appareil) ou code TOTP.
 */
import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Approval, ApprovalScope } from "@nokker-apps/sdk";
import { approvalTarget, choiceLabel, choiceToDecision, effectLabel, localChoices, formatRemaining, remainingSeconds, type LocalChoice } from "../approval-model.js";
import { t } from "../i18n/index.js";

export interface LocalDecisionHandler {
  (decision: "approve" | "reject", scope: ApprovalScope, rule?: string): void;
}

export function ApprovalCard({
  approval,
  local = false,
  onApproveByPhone,
  onRejectByPhone,
  onApproveTotp,
  onRejectTotp,
  onLocalDecision,
  onExpired,
  busy,
  message,
}: {
  approval: Approval;
  /** Carte d'une session locale : menu une fois / session / toujours / refuser (routes locales). */
  local?: boolean;
  onApproveByPhone?: () => void;
  onRejectByPhone?: () => void;
  onApproveTotp?: (code: string) => void;
  onRejectTotp?: (code: string) => void;
  onLocalDecision?: LocalDecisionHandler;
  /** Appelé une seule fois quand le compte à rebours atteint 0 (carte locale). */
  onExpired?: () => void;
  busy: boolean;
  message: string | null;
}): React.ReactElement {
  if (local) {
    return <LocalCard approval={approval} busy={busy} message={message} onDecision={onLocalDecision ?? (() => {})} onExpired={onExpired ?? (() => {})} />;
  }
  return (
    <RemoteCard
      approval={approval}
      busy={busy}
      message={message}
      onApproveByPhone={onApproveByPhone ?? (() => {})}
      onRejectByPhone={onRejectByPhone ?? (() => {})}
      onApproveTotp={onApproveTotp ?? (() => {})}
      onRejectTotp={onRejectTotp ?? (() => {})}
    />
  );
}

function LocalCard({
  approval,
  busy,
  message,
  onDecision,
  onExpired,
}: {
  approval: Approval;
  busy: boolean;
  message: string | null;
  onDecision: LocalDecisionHandler;
  onExpired: () => void;
}): React.ReactElement {
  const choices = localChoices(approval);
  const [index, setIndex] = useState(0);
  const [remaining, setRemaining] = useState(() => remainingSeconds(approval));
  const current = choices[index]!;

  useEffect(() => {
    let fired = false;
    const t = setInterval(() => {
      const r = remainingSeconds(approval);
      setRemaining(r);
      if (r <= 0 && !fired) {
        fired = true;
        clearInterval(t);
        onExpired();
      }
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval.id]);

  function validate(c: LocalChoice): void {
    const { decision, scope } = choiceToDecision(c.id);
    onDecision(decision, scope, c.rule);
  }

  useInput((input, key) => {
    if (busy) return;
    // Échap ne décide pas : on l'ignore volontairement.
    if (key.upArrow) setIndex((i) => (i + choices.length - 1) % choices.length);
    else if (key.downArrow) setIndex((i) => (i + 1) % choices.length);
    else if (key.return) validate(current);
    else if (/^[1-4b]$/.test(input)) {
      // « 3 » / « 3b » (Toujours) ne valident pas d'un coup : on sélectionne et on montre la règle, Entrée confirme.
      const wanted = input === "b" ? "3b" : input;
      const hit = choices.find((c) => c.key === wanted);
      if (!hit) return;
      setIndex(choices.indexOf(hit));
      if (hit.id !== "always") validate(hit);
    }
  });

  const target = approvalTarget(approval);
  const mm = formatRemaining(remaining);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Text bold color="yellow">
        {t("⚠ Action to approve")}
      </Text>
      <Text>
        {t("Tool")} <Text bold>{approval.tool_name}</Text> · {t("effect")} <Text color="redBright">{effectLabel(approval.effect)}</Text>
      </Text>
      <Text>
        {approval.tool_name === "terminal" ? t("Command:") : t("Target:")} <Text bold>{target}</Text>
      </Text>
      <Text dimColor>{approval.reason}</Text>
      <Box flexDirection="column" marginTop={1}>
        {choices.map((c, i) => (
          <Text key={c.key} color={i === index ? "cyanBright" : undefined} bold={i === index}>
            {i === index ? "› " : "  "}
            {c.key}. {choiceLabel(c, approval.tool_name)}
          </Text>
        ))}
      </Box>
      {current.rule ? (
        <Text color="yellow">
          {t("Rule written to your Nokker settings (settings.json in the state folder):")} <Text bold>{current.rule}</Text> {t("— Enter to confirm")}
        </Text>
      ) : null}
      <Text dimColor>{t("↑/↓ or 1-4 · Enter validates · expires in {0}", mm)}</Text>
      {busy ? <Text dimColor>…</Text> : null}
      {message ? <Text color="red">{message}</Text> : null}
    </Box>
  );
}

function RemoteCard({
  approval,
  onApproveByPhone,
  onRejectByPhone,
  onApproveTotp,
  onRejectTotp,
  busy,
  message,
}: {
  approval: Approval;
  onApproveByPhone: () => void;
  onRejectByPhone: () => void;
  onApproveTotp: (code: string) => void;
  onRejectTotp: (code: string) => void;
  busy: boolean;
  message: string | null;
}): React.ReactElement {
  const [totpMode, setTotpMode] = useState(false);
  const [totpDecision, setTotpDecision] = useState<"approve" | "reject">("approve");
  const [totpValue, setTotpValue] = useState("");
  const strong = approval.strength === "strong";
  const canTotp = !strong;

  useInput((input) => {
    if (busy || totpMode || strong) return;
    if (input === "p") onApproveByPhone();
    else if (input === "r") onRejectByPhone();
    else if (input === "t" && canTotp) {
      setTotpDecision("approve");
      setTotpMode(true);
    } else if (input === "x" && canTotp) {
      setTotpDecision("reject");
      setTotpMode(true);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1} marginY={1}>
      <Text bold color="yellow">
        {approval.strength === "strong" ? t("⚠ Approval requested — STRONG level") : t("⚠ Approval requested — STANDARD level")}
      </Text>
      <Text>
        {t("Tool")} <Text bold>{approval.tool_name}</Text> · {t("effect")} <Text color="redBright">{effectLabel(approval.effect)}</Text>
      </Text>
      <Text dimColor>{JSON.stringify(approval.arguments)}</Text>
      <Text>{approval.reason}</Text>
      {approval.advice ? <Text italic dimColor>{t("Reviewer's advice: {0}", approval.advice)}</Text> : null}
      <Text dimColor>{t("expires: {0}", approval.expires_at)}</Text>

      {strong ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">{t("Strong approval: decide it on your phone (biometrics). This terminal waits for the decision.")}</Text>
        </Box>
      ) : totpMode ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>{totpDecision === "approve" ? t("TOTP code to approve (Enter to validate):") : t("TOTP code to reject (Enter to validate):")}</Text>
          <TextInput
            value={totpValue}
            onChange={setTotpValue}
            onSubmit={(value) => {
              if (totpDecision === "approve") onApproveTotp(value);
              else onRejectTotp(value);
              setTotpMode(false);
              setTotpValue("");
            }}
          />
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text>
            <Text color="green">[p]</Text> {t("approve with this device")}
            {"  "}
            <Text color="red">[r]</Text> {t("reject")}
            {"  "}
            <Text color="green">[t]</Text> {t("TOTP approve")}
            {"  "}
            <Text color="red">[x]</Text> {t("TOTP reject")}
          </Text>
        </Box>
      )}
      {busy ? <Text dimColor>…</Text> : null}
      {message ? <Text dimColor>{message}</Text> : null}
    </Box>
  );
}
