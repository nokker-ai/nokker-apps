/**
 * `nokker logs [-f] [-n N] [--since 1h|30m|2d] [--component core|cli]`.
 * core = `docker compose -p <project> -f <compose> logs <core_service>` via le compose connu (lokkal.json) ; cli = `~/.config/nokker/cli.log`.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { cliLogPath } from "./config.js";
import { t } from "./i18n/index.js";
import { composeArgs, hostCommand, lokkalProblem, readLokkal } from "./lokkal.js";
import { firstLine, run as realRun, type Runner } from "./proc.js";

export interface LogsOptions {
  follow: boolean;
  lines: number;
  since: string | null;
  component: "core" | "cli";
  run?: Runner;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

export function sinceToMs(since: string): number {
  const m = since.match(/^(\d+)([smhd])$/);
  if (!m) return 0;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
}

/** `docker compose logs --since` comprend `30m`/`1h` mais pas `2d` : on convertit les jours en heures. */
export function sinceForDocker(since: string): string {
  const m = since.match(/^(\d+)d$/);
  return m ? `${Number(m[1]) * 24}h` : since;
}

/** Lignes du journal client dont l'horodatage ISO est dans la fenêtre, puis les N dernières. */
export function filterCliLog(text: string, lines: number, since: string | null, now = Date.now()): string[] {
  let all = text.split("\n").filter(Boolean);
  if (since) {
    const limit = now - sinceToMs(since);
    all = all.filter((l) => {
      const ts = Date.parse(l.slice(0, l.indexOf(" ")));
      return Number.isNaN(ts) || ts >= limit;
    });
  }
  return all.slice(-lines);
}

export async function runLogs(opts: LogsOptions): Promise<number> {
  const out = opts.out ?? ((s) => process.stdout.write(s));
  const err = opts.err ?? ((s) => process.stderr.write(s));
  const run = opts.run ?? realRun;

  if (opts.component === "cli") return logsCli(opts, out, err);

  const lokkal = readLokkal();
  const problem = lokkalProblem(lokkal);
  if (problem || lokkal.status !== "ok") {
    err(`${t("Kernel logs unavailable: {0}.\nThe client log is still readable: nokker logs --component cli", String(problem))}\n`);
    return 1;
  }
  const pcmd = hostCommand(lokkal.config, "docker", ["info", "--format", "{{.ServerVersion}}"]);
  const probe = await run(pcmd.cmd, pcmd.args, { timeoutMs: 15_000 });
  if (probe.error === "ENOENT") {
    err(`${t("docker is not installed (or not in PATH): cannot read the kernel logs.\nThe client log is still readable: nokker logs --component cli")}\n`);
    return 1;
  }
  if (probe.code !== 0) {
    err(`${t("The docker daemon does not respond ({0}): cannot read the kernel logs.", firstLine(probe.stderr) || t("no response"))}\n`);
    return 1;
  }
  const args = [...composeArgs(lokkal.config), "logs", "--tail", String(opts.lines)];
  if (opts.since) args.push("--since", sinceForDocker(opts.since));
  if (opts.follow) args.push("-f");
  args.push(lokkal.config.core_service);
  const lcmd = hostCommand(lokkal.config, "docker", args);
  const res = await run(lcmd.cmd, lcmd.args, { inherit: true, timeoutMs: opts.follow ? 2_147_483_000 : 60_000 });
  if (res.code !== 0 && res.code !== null) {
    err(`${t("docker compose logs failed (code {0}).", res.code)}\n`);
    return 1;
  }
  return 0;
}

async function logsCli(opts: LogsOptions, out: (t: string) => void, err: (t: string) => void): Promise<number> {
  const path = cliLogPath();
  if (!existsSync(path)) {
    err(`${t("No client log yet ({0}).", path)}\n`);
    return opts.follow ? 0 : 1;
  }
  const chosen = filterCliLog(readFileSync(path, "utf-8"), opts.lines, opts.since);
  if (chosen.length) out(`${chosen.join("\n")}\n`);
  if (!opts.follow) return 0;
  let pos = statSync(path).size;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      try {
        const size = statSync(path).size;
        if (size < pos) pos = 0;
        if (size > pos) {
          const fd = openSync(path, "r");
          const buf = Buffer.alloc(size - pos);
          readSync(fd, buf, 0, buf.length, pos);
          closeSync(fd);
          pos = size;
          out(buf.toString("utf-8"));
        }
      } catch {
        // fichier en rotation : on réessaie au prochain tour
      }
    }, 500);
    process.once("SIGINT", () => {
      clearInterval(timer);
      resolve();
    });
  });
  return 0;
}
