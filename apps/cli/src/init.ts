/**
 * `/init` : prompt fixe (anglais, c'est un message au modèle, pas un libellé d'interface) qui demande à l'agent de
 * scanner le dépôt et d'écrire ou compléter `AGENTS.md` à la racine. Pur : testé par `test/init.test.ts`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export const INIT_FILE = "AGENTS.md";

export function initPrompt(agentsMdExists: boolean): string {
  const scan = [
    "Scan this repository and capture what a new contributor (or another agent) needs to work in it:",
    "- the structure: main directories and what each one holds;",
    "- the languages, frameworks and package managers in use;",
    "- the exact commands to install, build, lint and run the tests (read package.json, Makefile, pyproject.toml, CI files, etc.; do not guess a command you did not find);",
    "- the conventions: code style, naming, commit message format, branch rules, anything a contributor must not do.",
  ];
  const write = agentsMdExists
    ? [
        `An ${INIT_FILE} already exists at the repository root. Read it first, then complete it with what is missing or outdated.`,
        "Do NOT overwrite or rewrite the sections that were written by hand: keep them as they are, and add new sections or short additions next to them.",
      ]
    : [`There is no ${INIT_FILE} yet: create it at the repository root, concise and factual (headings plus short bullet lists).`];
  return [
    ...scan,
    "",
    ...write,
    `Touch nothing else: ${INIT_FILE} is the only file you may create or modify. When done, summarise in a few lines what you wrote.`,
  ].join("\n");
}

/** Prompt de `/init` pour le dossier `cwd` (détecte un `AGENTS.md` existant). */
export function initPromptFor(cwd: string): string {
  return initPrompt(existsSync(join(cwd, INIT_FILE)));
}
