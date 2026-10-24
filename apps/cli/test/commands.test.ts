import { describe, expect, it } from "vitest";
import { parseSlashCommand, tokenize } from "../src/commands.js";

describe("tokenize", () => {
  it("découpe sur les espaces", () => {
    expect(tokenize("bulle session")).toEqual(["bulle", "session"]);
  });
  it("respecte les guillemets doubles", () => {
    expect(tokenize('"Disque host-1" "Ninjob équipe"')).toEqual(["Disque host-1", "Ninjob équipe"]);
  });
  it("ignore les espaces multiples", () => {
    expect(tokenize("  a   b  ")).toEqual(["a", "b"]);
  });
});

describe("parseSlashCommand", () => {
  it("/ seul ou vide → empty", () => {
    expect(parseSlashCommand("/")).toEqual({ kind: "empty" });
    expect(parseSlashCommand("   ")).toEqual({ kind: "empty" });
  });

  it("/sessions sans argument liste", () => {
    expect(parseSlashCommand("/sessions")).toEqual({ kind: "sessions", query: null });
  });

  it("/sessions <requête> bascule", () => {
    expect(parseSlashCommand("/sessions Infra")).toEqual({ kind: "sessions", query: "Infra" });
  });

  it("/threads liste les fils (plus un alias de /sessions)", () => {
    expect(parseSlashCommand("/threads")).toEqual({ kind: "threads" });
  });

  it("/goto <session>", () => {
    expect(parseSlashCommand("/goto Compta")).toEqual({ kind: "goto", query: "Compta" });
  });

  it("/thread [titre] remplace /new", () => {
    expect(parseSlashCommand("/thread")).toEqual({ kind: "thread", title: null });
    expect(parseSlashCommand("/thread Mon nouveau fil")).toEqual({ kind: "thread", title: "Mon nouveau fil" });
  });

  it("/new n'est plus le nouveau fil (frontière d'épisode côté noyau)", () => {
    expect(parseSlashCommand("/new")).toEqual({ kind: "renamedNew" });
  });

  it("/diff /cancel /out /confirm", () => {
    expect(parseSlashCommand("/diff")).toEqual({ kind: "diff", hash: null });
    expect(parseSlashCommand("/diff ab12")).toEqual({ kind: "diff", hash: "ab12" });
    expect(parseSlashCommand("/rollback 2")).toEqual({ kind: "rollback", target: "2" });
    expect(parseSlashCommand("/rollback")).toEqual({ kind: "rollback", target: null });
    expect(parseSlashCommand("/skills git-bisect")).toEqual({ kind: "skills", name: "git-bisect" });
    expect(parseSlashCommand("/skills")).toEqual({ kind: "skills", name: null });
    expect(parseSlashCommand("/checkpoints")).toEqual({ kind: "checkpoints" });
    expect(parseSlashCommand("/plan")).toEqual({ kind: "plan" });
    expect(parseSlashCommand("/agents")).toEqual({ kind: "agents" });
    expect(parseSlashCommand("/cancel")).toEqual({ kind: "cancel" });
    expect(parseSlashCommand("/out")).toEqual({ kind: "out" });
    expect(parseSlashCommand("/confirm 123456")).toEqual({ kind: "confirm", totp: "123456" });
  });

  it("/bubbles", () => {
    expect(parseSlashCommand("/bubbles")).toEqual({ kind: "bubbles" });
  });

  it("/bubble <id>", () => {
    expect(parseSlashCommand("/bubble bu_abc123")).toEqual({ kind: "bubble", id: "bu_abc123" });
  });

  it("/bubble sans argument → id vide (App.tsx affiche l'usage)", () => {
    expect(parseSlashCommand("/bubble")).toEqual({ kind: "bubble", id: "" });
  });

  it("/send <bulle> <session>", () => {
    expect(parseSlashCommand("/send bu_abc123 th_def456")).toEqual({
      kind: "send",
      bubble: "bu_abc123",
      session: "th_def456",
      copy: false,
    });
  });

  it("/send ... --copy (ordre quelconque)", () => {
    expect(parseSlashCommand("/send bu_abc123 --copy th_def456")).toEqual({
      kind: "send",
      bubble: "bu_abc123",
      session: "th_def456",
      copy: true,
    });
  });

  it("/send avec des titres entre guillemets", () => {
    expect(parseSlashCommand('/send "Disque host-1" "Infra" --copy')).toEqual({
      kind: "send",
      bubble: "Disque host-1",
      session: "Infra",
      copy: true,
    });
  });

  it("/ask <session> <texte>", () => {
    expect(parseSlashCommand("/ask Compta rapproche les relevés d'octobre")).toEqual({
      kind: "ask",
      session: "Compta",
      text: "rapproche les relevés d'octobre",
    });
  });

  it("/ask sans texte", () => {
    expect(parseSlashCommand("/ask Compta")).toEqual({ kind: "ask", session: "Compta", text: "" });
  });

  it("/approvals, /login, /tools, /help, /quit, /exit", () => {
    expect(parseSlashCommand("/approvals")).toEqual({ kind: "approvals" });
    expect(parseSlashCommand("/login")).toEqual({ kind: "login" });
    expect(parseSlashCommand("/tools")).toEqual({ kind: "tools" });
    expect(parseSlashCommand("/help")).toEqual({ kind: "help" });
    expect(parseSlashCommand("/?")).toEqual({ kind: "help" });
    expect(parseSlashCommand("/quit")).toEqual({ kind: "quit" });
    expect(parseSlashCommand("/exit")).toEqual({ kind: "quit" });
  });

  it("commande inconnue", () => {
    expect(parseSlashCommand("/dodo")).toEqual({ kind: "unknown", name: "dodo" });
  });

  it("insensible à la casse sur le nom de commande", () => {
    expect(parseSlashCommand("/SESSIONS")).toEqual({ kind: "sessions", query: null });
  });
});
