/**
 * Carte d'approbation en ligne (APPROVALS.md, LOKKAL-CLI.md §2.2).
 *
 *  - `local` : cadre « Action à approuver » (outil, effet, commande ou chemin) puis
 *    `1. Une fois (a) · 2. Pour cette session (s) · 3. Toujours (règle) · 4. Refuser (r)` — ordre fixe, même pour une
 *    commande de test (la lettre affichée et la légende désignent toujours le même numéro).
 *    SÉCURITÉ (répétition du 07.11 : une Entrée tapée pour le composeur a approuvé une carte apparue au même instant ;
 *    au banc, une frappe « salut » l'approuvait aussi par sa première lettre) — une décision se fait en DEUX temps :
 *      - choisir : `a` (une fois), `s` (pour cette session), `r` (refuser), ↑/↓ ou un chiffre ; rien n'est choisi
 *        à l'apparition, et choisir ne décide jamais ;
 *      - confirmer : Entrée (ou `y`), acceptée seulement 600 ms après l'apparition de la carte ET 250 ms après la
 *        frappe précédente (le choix) ; un collage multi-caractères n'est pas un choix ;
 *      - toute autre frappe (un texte tapé pour le composeur) efface le choix et relance l'attente.
 *    « 3 » / « 3b » montrent la règle exacte qui sera écrite. Échap ne décide pas ; Ctrl+C (géré par l'App) = refus +
 *    annulation du tour ; compte à rebours puis refus « expirée ».
 *  - `strong` : « décider sur téléphone » — la CLI ne signe PLUS avec sa clé logicielle (refusé par le noyau).
 *  - `standard` : téléphone (signature d'appareil) ou code TOTP.
 */
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Approval, ApprovalScope } from "@nokker-apps/sdk";
import { approvalTarget, cardChoices, choiceLabel, choiceLetter, choicesLegend, choiceToDecision, effectColorFor, effectLabel, formatRemaining, reasonText, remainingSeconds, type LocalChoice } from "../approval-model.js";
import { t } from "../i18n/index.js";

/** Silence exigé après l'apparition d'une carte avant d'accepter une frappe (anti-rebond, répétition du 07.11). */
export const CARD_ARM_MS = 600;
/** Écart minimal entre la frappe précédente (le choix) et l'Entrée qui confirme : écarte un « a⏎ » en rafale, sans perdre
 * l'utilisateur rapide (une Entrée à la main arrive après ~250 ms). */
export const CARD_KEY_GAP_MS = 250;

/** Horloge du clavier d'une carte : `quiet()` est vrai si la carte est affichée depuis `armMs` ET si la frappe précédente
 * date d'au moins `gapMs` ; `touch()` note une frappe (à appeler pour CHAQUE frappe, après avoir lu `quiet()`). */
function useQuiet(id: string, armMs = CARD_ARM_MS, gapMs = CARD_KEY_GAP_MS): { quiet: () => boolean; touch: () => void } {
  const shown = useRef(Date.now());
  const last = useRef(Date.now());
  useEffect(() => {
    shown.current = Date.now();
    last.current = shown.current;
  }, [id]);
  return {
    quiet: () => {
      const now = Date.now();
      return now - shown.current >= armMs && now - last.current >= gapMs;
    },
    touch: () => void (last.current = Date.now()),
  };
}

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
  // Ordre fixe (une fois en premier, même pour une commande de test) : la lettre de la légende = le numéro de la ligne.
  const choices = cardChoices(approval);
  // -1 : rien de sélectionné (jamais une option qui approuve par défaut)
  const [index, setIndex] = useState(-1);
  const [hint, setHint] = useState(false);
  const [remaining, setRemaining] = useState(() => remainingSeconds(approval));
  const current = index >= 0 ? choices[index] : undefined;
  const clock = useQuiet(approval.id);

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
    onDecision(decision, scope, c.rule ?? c.scopeRule);
  }

  useInput((input, key) => {
    if (busy) return;
    const quiet = clock.quiet();
    clock.touch();
    const byId = (id: LocalChoice["id"]): number => choices.findIndex((c) => c.id === id);
    const pick = (i: number): void => {
      if (i >= 0) setIndex(i);
    };
    // Échap ne décide pas : on l'ignore volontairement.
    if (key.escape) return;
    // Un collage (plusieurs caractères d'un coup, « a⏎ » ou « salut ») n'est pas un choix : il efface le choix.
    if (input.length > 1) {
      setIndex(-1);
      setHint(true);
      return;
    }
    if (key.upArrow) setIndex((i) => (i <= 0 ? choices.length - 1 : i - 1));
    else if (key.downArrow) setIndex((i) => (i + 1) % choices.length);
    else if (key.return || input === "y" || input === "Y") {
      // Confirmer : seulement un choix fait, 600 ms après l'apparition de la carte et 250 ms après le choix.
      if (current && quiet) validate(current);
      else setHint(true);
    } else if (input === "a") pick(byId("once"));
    else if (input === "s") pick(byId("session"));
    else if (input === "r") pick(byId("reject"));
    else if (/^[1-4b]$/.test(input)) {
      const wanted = input === "b" ? "3b" : input;
      pick(choices.findIndex((c) => c.key === wanted));
    } else {
      // Toute autre frappe (un texte destiné au composeur) : le choix est effacé, l'attente repart (clock.touch).
      setIndex(-1);
      setHint(true);
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
        {t("Tool")} <Text bold>{approval.tool_name}</Text> · {t("effect")} <Text color={effectColorFor(approval.effect, approval.tool_name, approval.arguments)}>{effectLabel(approval.effect, approval.tool_name, approval.arguments)}</Text>
      </Text>
      <Text>
        {approval.tool_name === "terminal" ? t("Command:") : t("Target:")} <Text bold>{target}</Text>
      </Text>
      {approval.reason ? <Text dimColor>{reasonText(approval.reason, approval.tool_name)}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {choices.map((c, i) => (
          <Text key={c.key} color={i === index ? "cyanBright" : undefined} bold={i === index}>
            {i === index ? "› " : "  "}
            {c.key}. {choiceLabel(c, approval.tool_name)}
            {choiceLetter(c) ? <Text dimColor> ({choiceLetter(c)})</Text> : null}
          </Text>
        ))}
      </Box>
      {current?.rule ? (
        <Text color="yellow">
          {t("Rule written to your Nokker settings (settings.json in the state folder):")} <Text bold>{current.rule}</Text> {t("— Enter to confirm")}
        </Text>
      ) : null}
      {hint ? <Text color="yellow">{t("Choose with a, s, r or 1-4, wait a moment, then confirm with Enter. Typing anything else clears the choice.")}</Text> : null}
      <Text dimColor>{choicesLegend(choices, mm)}</Text>
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
  const clock = useQuiet(approval.id);
  const [chosen, setChosen] = useState<"p" | "r" | "t" | "x" | null>(null);

  useInput((input, key) => {
    if (busy || totpMode || strong) return;
    const quiet = clock.quiet();
    clock.touch();
    // Même règle que la carte locale : choisir (p, r, t, x), puis Entrée après 600 ms de silence ; toute autre frappe
    // efface le choix.
    if (key.return) {
      if (!chosen || !quiet) return;
      if (chosen === "p") onApproveByPhone();
      else if (chosen === "r") onRejectByPhone();
      else {
        setTotpDecision(chosen === "t" ? "approve" : "reject");
        setTotpMode(true);
      }
      setChosen(null);
    } else if (input === "p" || input === "r" || ((input === "t" || input === "x") && canTotp)) setChosen(input as "p" | "r" | "t" | "x");
    else setChosen(null);
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1} marginY={1}>
      <Text bold color="yellow">
        {approval.strength === "strong" ? t("⚠ Approval requested — STRONG level") : t("⚠ Approval requested — STANDARD level")}
      </Text>
      <Text>
        {t("Tool")} <Text bold>{approval.tool_name}</Text> · {t("effect")} <Text color={effectColorFor(approval.effect, approval.tool_name, approval.arguments)}>{effectLabel(approval.effect, approval.tool_name, approval.arguments)}</Text>
      </Text>
      <Text dimColor>{JSON.stringify(approval.arguments)}</Text>
      <Text>{reasonText(approval.reason, approval.tool_name)}</Text>
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
            {chosen ? <Text color="cyanBright">{"  "}{t("chosen: {0} — Enter to confirm", chosen)}</Text> : null}
          </Text>
        </Box>
      )}
      {busy ? <Text dimColor>…</Text> : null}
      {message ? <Text dimColor>{message}</Text> : null}
    </Box>
  );
}
