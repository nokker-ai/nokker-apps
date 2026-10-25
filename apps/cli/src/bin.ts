#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./ui/App.js";
import { CLI_VERSION } from "./version.js";
import { parseArgs, type ParsedArgs } from "./cli-args.js";
import { NokkerClient } from "@nokker-apps/sdk";
import { BRAND } from "@nokker-apps/brand";
import { connect, defaultUser } from "./auth.js";
import { cliLog } from "./log.js";
import { runPrint } from "./headless.js";
import { formatChecks, runDoctor } from "./doctor.js";
import { resolveServer } from "./lokkal.js";
import { runLogs } from "./logs.js";
import { runUpdate } from "./update.js";
import { runAcp } from "./acp/run.js";
import { parseLang, setLang, t } from "./i18n/index.js";

// `--lang` d'abord : les erreurs d'usage sont déjà dans la bonne langue.
const argv = process.argv.slice(2);
const langArg = parseLang(argv[argv.indexOf("--lang") + 1] ?? undefined);
if (argv.includes("--lang") && langArg) setLang(langArg);
const args = parseArgs(argv);
// --server > NOKKER_SERVER_URL > api_url de lokkal.json > http://127.0.0.1:8742
const resolvedServer = resolveServer(args);
args.serverUrl = resolvedServer.url;

if (args.error) {
  process.stderr.write(`${args.error}\n`);
  process.exit(2);
} else if (args.help) {
  printHelp();
  process.exit(0);
} else if (args.version) {
  process.stdout.write(`${CLI_VERSION}\n`);
  process.exit(0);
} else if (args.command) {
  void runSubcommand(args).then(
    (code) => process.exit(code),
    (err) => {
      // Jamais de trace de pile pour l'utilisateur : le détail va dans cli.log.
      cliLog("error", `subcommand ${args.command}: ${String(err)}`);
      process.stderr.write(`${t("Error: {0}", err instanceof Error ? err.message : String(err))}\n`);
      process.exit(1);
    },
  );
} else if (args.print !== null) {
  // Mode non interactif (scripts/CI) : `nokker -p "question"` imprime la réponse et sort — pas d'Ink.
  void runNonInteractive(args).then((code) => process.exit(code));
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  // Ink exige un terminal (mode brut) : sans TTY, jamais de TUI ni de trace de pile.
  process.stderr.write(`${t("interactive mode needs a terminal; use nokker -p \"…\"")}\n`);
  process.exit(2);
} else {
  const { waitUntilExit, unmount } = render(
    React.createElement(App, { baseUrl: args.serverUrl, sound: args.sound, cwd: process.cwd() }),
  );

  process.on("SIGINT", () => {
    unmount();
    process.exit(0);
  });

  waitUntilExit().then(() => {
    process.exit(0);
  });
}

async function runSubcommand(opts: ParsedArgs): Promise<number> {
  if (opts.command === "doctor") {
    const { checks, code } = await runDoctor({ serverUrl: opts.serverUrl, serverSource: resolvedServer.source, fix: opts.fix });
    process.stdout.write(`${formatChecks(checks)}\n`);
    return code;
  }
  if (opts.command === "acp") {
    // Agent Client Protocol sur stdio (Zed, JetBrains, Neovim…) : stdout ne porte que le protocole.
    return runAcp(opts.serverUrl);
  }
  if (opts.command === "logs") {
    return runLogs({ follow: opts.follow, lines: opts.lines, since: opts.since, component: opts.component });
  }
  return runUpdate({ serverUrl: opts.serverUrl, check: opts.check });
}

function printHelp(): void {
  const b = BRAND.cliBin;
  const rows: Array<[string, string]> = [
    ["", t("code session in the current folder (resumes this folder's thread)")],
    ['-p "request"', t("one turn in the current folder, answer on stdout (scripts/CI); any effect without a rule is REJECTED (unattended mode)")],
    ['-p "request" --json', t("same, JSON output {reply, thread_id, cwd, pending_approvals, refused, cost}")],
    ["doctor [--fix]", t("checks: docker, compose, server, authentication, version, git")],
    ["logs [-f] [-n N] [--since 1h|30m|2d] [--component core|cli]", ""],
    ["update [--check]", t("update the core (docker compose pull + up -d); --check compares the digests")],
    ["acp", t("ACP agent on stdio for an editor (Zed, JetBrains, Neovim…): session of the editor's folder")],
    ["--server <url>", t("server (default {0}, or $NOKKER_SERVER_URL)", args.serverUrl)],
    ["--lang en|fr", t("interface language (default: NOKKER_LANG, LC_ALL, LC_MESSAGES, LANG; English otherwise)")],
    ["--sound", t("terminal bell (BEL) on every bubble — off by default")],
    ["--help", t("this help")],
    ["--version", t("print the client version")],
  ];
  const lines = rows.map(([c, d]) => {
    const cmd = `  ${b}${c ? ` ${c}` : ""}`;
    return d ? (cmd.length < 38 ? `${cmd.padEnd(38)}${d}` : `${cmd}\n${" ".repeat(38)}${d}`) : cmd;
  });
  // eslint-disable-next-line no-console
  console.log(`${BRAND.productName} — ${b}

${t("Usage:")}
${lines.join("\n")}

${t("In a session, /help lists the commands (/sessions, /thread, /diff, /checkpoints, /rollback, /skills, /plan, /agents, /memory, /cost, /cancel, /approvals…). Esc cancels the turn in progress. A strong card is decided locally once only; from the web or the gateway, on the phone.")}
`);
}

/** Un tour dans le dossier courant, sans terminal interactif. */
async function runNonInteractive(opts: ParsedArgs): Promise<number> {
  try {
    const client = new NokkerClient({ baseUrl: opts.serverUrl, userAgent: BRAND.userAgent });
    const name = `cli-${process.platform}-batch`;
    const conn = await connect(client, opts.serverUrl, name, {
      user: defaultUser(),
      ...(process.env.NOKKER_TOTP ? { totp: process.env.NOKKER_TOTP } : {}),
      onPending: (d) => process.stderr.write(`${t("Device waiting for confirmation — code {0}. Confirm it on the host (or NOKKER_TOTP).", d.code)}\n`),
    });
    const res = await runPrint(opts.print ?? "", client, conn, process.cwd());

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
    } else {
      process.stdout.write(`${res.reply}\n`);
      for (const r of res.refused) {
        process.stderr.write(`${t("Rejected (no rule): {0} {1} [{2}]", r.tool, r.target, r.effect ?? "?")}\n`);
      }
      if (res.pending_approvals.length) {
        process.stderr.write(`${t("({0} approval(s) pending on this thread — decide them from an interactive session or another client.)", res.pending_approvals.length)}\n`);
      }
    }
    return 0;
  } catch (err) {
    cliLog("error", `-p : ${String(err)}`);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ error: String(err), refused: [] })}\n`);
    } else {
      process.stderr.write(`${t("Error: {0}", String(err))}\n`);
    }
    return 1;
  }
}
