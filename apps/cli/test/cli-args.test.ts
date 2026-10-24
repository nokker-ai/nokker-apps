import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_URL, parseArgs } from "../src/cli-args.js";

describe("parseArgs", () => {
  it("par défaut : mode interactif, serveur par défaut, pas de son, pas de json", () => {
    const args = parseArgs([], {});
    expect(args).toMatchObject({ serverUrl: DEFAULT_SERVER_URL, print: null, json: false, sound: false, help: false, command: null });
    expect(DEFAULT_SERVER_URL).toBe("http://127.0.0.1:8742");
  });

  it("$NOKKER_SERVER_URL est pris en compte", () => {
    const args = parseArgs([], { NOKKER_SERVER_URL: "https://nokker.example/api" });
    expect(args.serverUrl).toBe("https://nokker.example/api");
  });

  it("--server l'emporte sur la variable d'environnement", () => {
    const args = parseArgs(["--server", "http://127.0.0.1:9999"], { NOKKER_SERVER_URL: "https://nokker.example/api" });
    expect(args.serverUrl).toBe("http://127.0.0.1:9999");
  });

  it("-p active le mode non interactif", () => {
    const args = parseArgs(["-p", "quel est l'état du disque ?"]);
    expect(args.print).toBe("quel est l'état du disque ?");
  });

  it("--print est un alias de -p", () => {
    const args = parseArgs(["--print", "ping"]);
    expect(args.print).toBe("ping");
  });

  it("--json seul n'active pas le mode non interactif", () => {
    const args = parseArgs(["--json"]);
    expect(args.print).toBeNull();
    expect(args.json).toBe(true);
  });

  it("--sound active la sonnette (coupée par défaut)", () => {
    expect(parseArgs([]).sound).toBe(false);
    expect(parseArgs(["--sound"]).sound).toBe(true);
  });

  it("-h / --help", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs([]).help).toBe(false);
  });

  it("combinaison complète, ordre quelconque", () => {
    const args = parseArgs(["--json", "--server", "http://x", "-p", "allo", "--sound"]);
    expect(args).toMatchObject({ serverUrl: "http://x", print: "allo", json: true, sound: true, help: false });
  });

  it("sous-commandes et leurs options", () => {
    expect(parseArgs(["doctor", "--fix"], {})).toMatchObject({ command: "doctor", fix: true });
    expect(parseArgs(["logs", "-f", "-n", "50", "--since", "2d", "--component", "cli"], {})).toMatchObject({
      command: "logs", follow: true, lines: 50, since: "2d", component: "cli", error: null,
    });
    expect(parseArgs(["update", "--check"], {})).toMatchObject({ command: "update", check: true });
    expect(parseArgs(["--server", "http://127.0.0.1:4320", "doctor"], {})).toMatchObject({ command: "doctor", serverUrl: "http://127.0.0.1:4320" });
    expect(parseArgs(["-p", "doctor"], {})).toMatchObject({ command: null, print: "doctor" });
    expect(parseArgs(["logs", "--since", "hier"], {}).error).toMatch(/--since/);
    expect(parseArgs(["logs", "--component", "x"], {}).error).toMatch(/--component/);
  });

  it("serverExplicit distingue le défaut d'un choix", () => {
    expect(parseArgs([], {}).serverExplicit).toBe(false);
    expect(parseArgs(["--server", "http://127.0.0.1:4320"], {}).serverExplicit).toBe(true);
  });

  it("argument ou drapeau inconnu : erreur d'usage (jamais la TUI)", () => {
    expect(parseArgs(["status"]).error).toBe("argument inconnu : status (nokker --help)");
    expect(parseArgs(["--bogus"]).error).toContain("argument inconnu : --bogus");
    expect(parseArgs(["doctor", "logs"]).error).toContain("argument inconnu : logs");
    expect(parseArgs(["-p", "status", "--json"]).error).toBeNull();
  });
});
