/** Lancement de commandes externes (docker, git, npm) — injectable pour les tests des sous-commandes. */
import { spawn } from "node:child_process";

export interface RunResult {
  /** `null` si le binaire est introuvable ou tué par le délai. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** `ENOENT` si le binaire n'existe pas, `timeout` si le délai est dépassé. */
  error?: "ENOENT" | "timeout" | string;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Branche stdout/stderr sur ceux du processus (logs -f, pull…) au lieu de les capturer. */
  inherit?: boolean;
  /** Variables ajoutées à l'environnement du processus. */
  env?: Record<string, string>;
}

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export const run: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(cmd, args, { stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"], ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}) });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      done({ code: null, stdout, stderr, error: "timeout" });
    }, opts.timeoutMs ?? 120_000);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err: NodeJS.ErrnoException) => done({ code: null, stdout, stderr, error: err.code === "ENOENT" ? "ENOENT" : String(err) }));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });

/** Première ligne non vide d'une sortie d'erreur, pour un message court. */
export function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}
