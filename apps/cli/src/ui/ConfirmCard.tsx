/**
 * Carte de confirmation du client terminal : oubli d'une note de mémoire (`/memory forget`) et confiance aux skills du
 * dépôt (LOKKAL.md §7.21 : racine, nombre de skills, empreinte). `y` (ou `o`) confirme, `n` ou Échap renonce ; Entrée
 * confirme l'oubli, JAMAIS la confiance (une carte qui surgit pendant qu'on tape une commande ne doit pas être validée
 * par l'Entrée de cette commande). Les touches des 500 premières ms sont ignorées : la frappe déjà en cours (« /memory »
 * contient un « o » et un « y ») ne répond jamais à une carte qui vient de s'ouvrir.
 */

/** Délai avant que la carte n'écoute le clavier (anti-frappe anticipée). */
export const CONFIRM_ARM_MS = 500;
import React, { useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { ProjectSkillsStatus } from "@nokker-apps/sdk";
import { t } from "../i18n/index.js";

export type ConfirmRequest =
  | { kind: "forget"; name: string; title: string }
  | { kind: "trust"; skills: ProjectSkillsStatus };

export function ConfirmCard({
  request,
  busy,
  message,
  onAnswer,
}: {
  request: ConfirmRequest;
  busy: boolean;
  message: string | null;
  onAnswer: (yes: boolean) => void;
}): React.ReactElement {
  const armed = useRef(false);
  useEffect(() => {
    armed.current = false;
    const timer = setTimeout(() => (armed.current = true), CONFIRM_ARM_MS);
    return () => clearTimeout(timer);
  }, [request]);
  useInput((input, key) => {
    if (busy || !armed.current) return;
    if ((key.return && request.kind === "forget") || input === "y" || input === "Y" || input === "o" || input === "O") onAnswer(true);
    else if (key.escape || input === "n" || input === "N") onAnswer(false);
  });

  if (request.kind === "forget") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
        <Text bold color="yellow">
          {t("Forget this note?")}
        </Text>
        <Text>
          <Text bold>{request.title}</Text> ({request.name})
        </Text>
        <Text dimColor>{t("It leaves the project memory (kept aside, nothing is destroyed). The agent will no longer use it.")}</Text>
        <Text dimColor>{t("y / Enter: forget · n / Esc: keep")}</Text>
        {busy ? <Text dimColor>…</Text> : null}
        {message ? <Text color="red">{message}</Text> : null}
      </Box>
    );
  }
  const s = request.skills;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Text bold color="yellow">
        {t("Trust this repository's skills?")}
      </Text>
      <Text>
        {t("Root:")} <Text bold>{s.root}</Text>
      </Text>
      <Text>
        {t("Skills:")} <Text bold>{s.count}</Text> {t("in .nokker/skills")}
      </Text>
      <Text>
        {t("Fingerprint:")} <Text bold>{s.sha256 ?? "—"}</Text>
      </Text>
      <Text dimColor>{t("They are ignored until you trust them. Review .nokker/skills first: a skill is instructions the agent will follow. Any change to the folder asks again.")}</Text>
      <Text dimColor>{t("y: trust this version · n / Esc: not now (/skills trust later)")}</Text>
      {busy ? <Text dimColor>…</Text> : null}
      {message ? <Text color="red">{message}</Text> : null}
    </Box>
  );
}
