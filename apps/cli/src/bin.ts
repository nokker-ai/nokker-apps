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

const args = parseArgs(process.argv.slice(2));
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
      cliLog("error", `sous-commande ${args.command} : ${String(err)}`);
      process.stderr.write(`Erreur : ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
} else if (args.print !== null) {
  // Mode non interactif (scripts/CI) : `nokker -p "question"` imprime la réponse et sort — pas d'Ink.
  void runNonInteractive(args).then((code) => process.exit(code));
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  // Ink exige un terminal (mode brut) : sans TTY, jamais de TUI ni de trace de pile.
  process.stderr.write('mode interactif impossible sans terminal ; utilisez nokker -p "…"\n');
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
  if (opts.command === "logs") {
    return runLogs({ follow: opts.follow, lines: opts.lines, since: opts.since, component: opts.component });
  }
  return runUpdate({ serverUrl: opts.serverUrl, check: opts.check });
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`${BRAND.productName} — ${BRAND.cliBin}

Usage :
  ${BRAND.cliBin}                        session de code dans le dossier courant (reprend le fil de ce dossier)
  ${BRAND.cliBin} -p "demande"           un tour dans le dossier courant, réponse sur stdout (scripts/CI) ;
                                      tout effet sans règle est REFUSÉ (mode sans surveillance)
  ${BRAND.cliBin} -p "demande" --json    même chose, sortie JSON {reply, thread_id, cwd, pending_approvals, refused}
  ${BRAND.cliBin} doctor [--fix]         contrôles : docker, compose, serveur, authentification, version, git
  ${BRAND.cliBin} logs [-f] [-n N] [--since 1h|30m|2d] [--component core|cli]
  ${BRAND.cliBin} update [--check]       mise à jour du noyau (docker compose pull + up -d) ; --check compare les digests
  ${BRAND.cliBin} --server <url>         serveur (défaut ${args.serverUrl}, ou $NOKKER_SERVER_URL)
  ${BRAND.cliBin} --sound                sonnette terminal (BEL) à chaque bulle — coupée par défaut
  ${BRAND.cliBin} --help                 cette aide
  ${BRAND.cliBin} --version              version du client

En session, /help liste les commandes (/sessions, /thread, /diff, /checkpoints, /rollback, /skills, /plan, /agents, /cancel, /approvals…). Échap annule le
tour en cours. Une carte forte se décide localement une fois seulement ; depuis le web ou la passerelle, sur le téléphone.
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
      onPending: (d) =>
        process.stderr.write(`Appareil en attente de confirmation — code ${d.code}. Confirme-le sur l'hôte (ou NOKKER_TOTP).\n`),
    });
    const res = await runPrint(opts.print ?? "", client, conn, process.cwd());

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
    } else {
      process.stdout.write(`${res.reply}\n`);
      for (const r of res.refused) {
        process.stderr.write(`Refusé (aucune règle) : ${r.tool} ${r.target} [${r.effect ?? "?"}]\n`);
      }
      if (res.pending_approvals.length) {
        process.stderr.write(
          `(${res.pending_approvals.length} approbation(s) en attente sur ce fil — à décider depuis une session interactive ou un autre client.)\n`,
        );
      }
    }
    return 0;
  } catch (err) {
    cliLog("error", `-p : ${String(err)}`);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ error: String(err), refused: [] })}\n`);
    } else {
      process.stderr.write(`Erreur : ${String(err)}\n`);
    }
    return 1;
  }
}
