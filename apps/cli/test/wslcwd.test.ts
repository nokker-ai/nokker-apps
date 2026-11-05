import { describe, expect, it } from "vitest";
import { localPathFor, serverCwdFor } from "../src/wslcwd.js";

const win = { platform: "win32", wslDistro: "Ubuntu" };

describe("serverCwdFor", () => {
  it("maps \\\\wsl.localhost\\<distro>\\… to the Linux path", () => {
    expect(serverCwdFor("\\\\wsl.localhost\\Ubuntu\\home\\alice\\nokker", win)).toEqual({ kind: "wsl", cwd: "/home/alice/nokker" });
    expect(serverCwdFor("\\\\wsl.localhost\\Ubuntu\\home\\alice\\nokker\\", win)).toEqual({ kind: "wsl", cwd: "/home/alice/nokker" });
    expect(serverCwdFor("\\\\wsl.localhost\\Ubuntu", win)).toEqual({ kind: "wsl", cwd: "/" });
  });

  it("maps \\\\wsl$\\<distro>\\… and forward slashes, distro case ignored", () => {
    expect(serverCwdFor("\\\\wsl$\\ubuntu\\home\\alice", win)).toEqual({ kind: "wsl", cwd: "/home/alice" });
    expect(serverCwdFor("//wsl.localhost/Ubuntu/home/alice", win)).toEqual({ kind: "wsl", cwd: "/home/alice" });
  });

  it("flags another distro without mapping it", () => {
    expect(serverCwdFor("\\\\wsl.localhost\\Debian\\home\\alice", win)).toEqual({ kind: "other-distro", cwd: "\\\\wsl.localhost\\Debian\\home\\alice", distro: "Debian" });
  });

  it("maps a Windows drive folder to /mnt/<letter>", () => {
    expect(serverCwdFor("C:\\Users\\alice\\proj", win)).toEqual({ kind: "drive", cwd: "/mnt/c/Users/alice/proj", drive: "C:" });
    expect(serverCwdFor("d:\\", win)).toEqual({ kind: "drive", cwd: "/mnt/d", drive: "D:" });
  });

  it("leaves paths alone outside Windows or without wsl_distro", () => {
    expect(serverCwdFor("/home/alice/p", { platform: "linux", wslDistro: "Ubuntu" })).toEqual({ kind: "same", cwd: "/home/alice/p" });
    expect(serverCwdFor("C:\\Users\\alice", { platform: "win32", wslDistro: null })).toEqual({ kind: "same", cwd: "C:\\Users\\alice" });
    expect(serverCwdFor("\\\\server\\share\\x", win)).toEqual({ kind: "same", cwd: "\\\\server\\share\\x" });
  });
});

describe("localPathFor", () => {
  it("maps back to a path Windows can read", () => {
    expect(localPathFor("/home/alice/nokker", win)).toBe("\\\\wsl.localhost\\Ubuntu\\home\\alice\\nokker");
    expect(localPathFor("/mnt/c/Users/alice/proj", win)).toBe("C:\\Users\\alice\\proj");
    expect(localPathFor("/mnt/d", win)).toBe("D:\\");
  });

  it("round-trips the UNC form", () => {
    const local = "\\\\wsl.localhost\\Ubuntu\\home\\alice\\nokker";
    expect(localPathFor(serverCwdFor(local, win).cwd, win)).toBe(local);
  });

  it("is the identity outside Windows + WSL", () => {
    expect(localPathFor("/home/alice", { platform: "linux", wslDistro: "Ubuntu" })).toBe("/home/alice");
  });
});
