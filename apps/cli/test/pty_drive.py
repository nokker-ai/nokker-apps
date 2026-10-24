#!/usr/bin/env python3
"""Pilote un programme dans un VRAI pseudo-terminal (pty.fork), comme un terminal d'utilisateur.

Mode 1, pas à pas : pty_drive.py '<json>'   avec {"argv": [...], "cwd": "...", "env": {...}, "steps": [[délai_s, "texte", "attendre?"], ...], "tail": s}
  Sortie : l'écran (séquences ANSI retirées), puis une ligne « EXITED=1|0 » (le programme s'est-il terminé de lui-même ?).

Mode 2, scénario (mesure) : pty_drive.py --task "<texte>" --server URL --cwd DIR [--max-decisions N] [--decide 1|2]
  [--config-dir DIR | --token-file F] [--idle 12] [--timeout 300] [--cli "cmd args"]
  Lance la CLI, attend « Session de code sur », envoie la tâche, puis détecte les cartes UNIQUEMENT par
  GET /v1/local/approvals (nouvel id = UNE décision, jamais deux pour le même id), attend le rendu de la carte sur le DELTA
  d'écran depuis la détection (jamais sur le tampon cumulé), envoie la touche --decide, borne le nombre de décisions et
  s'arrête quand plus aucune carte n'est en attente et que l'écran n'a plus reçu de texte depuis --idle secondes.
  Sortie : un JSON {cards:[{t, tool, command}], turns_user, duration_s, final_text, bounded, error}.
  Leçon du 23.10 : un motif cherché dans le tampon cumulé rejoue la décision à l'infini (≈3 M jetons de modèle brûlés)."""

import argparse, fcntl, json, os, pty, re, select, signal, struct, sys, termios, time, urllib.request

ANSI = re.compile(rb"\x1b\[[0-9;?]*[a-zA-Z]")


def strip_ansi(b):
    return ANSI.sub(b"", b).decode("utf-8", "replace")


def api(server, token, path):
    req = urllib.request.Request(server.rstrip("/") + path, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def scenario(argv):
    ap = argparse.ArgumentParser(prog="pty_drive.py")
    ap.add_argument("--task", required=True)
    ap.add_argument("--server", required=True)
    ap.add_argument("--cwd", required=True)
    ap.add_argument("--max-decisions", type=int, default=3)
    ap.add_argument("--decide", choices=["1", "2"], default="1", help="touche envoyée sur chaque carte (1 ou 2 selon l'ordre affiché)")
    ap.add_argument("--config-dir", default=os.environ.get("NOKKER_CONFIG_DIR_OVERRIDE"))
    ap.add_argument("--token-file")
    ap.add_argument("--idle", type=float, default=12.0)
    ap.add_argument("--timeout", type=float, default=300.0)
    ap.add_argument("--cli", help="commande de la CLI (défaut : node ../bin/nokker.mjs --server URL)")
    a = ap.parse_args(argv)
    token_file = a.token_file or os.path.join(a.config_dir or os.path.expanduser("~/.config/nokker"), "local-token")
    token = open(token_file).read().strip()
    here = os.path.dirname(os.path.abspath(__file__))
    cli = a.cli.split() if a.cli else ["node", os.path.join(here, "..", "bin", "nokker.mjs"), "--server", a.server]
    env = {**os.environ, "TERM": "xterm-256color"}
    if a.config_dir:
        env["NOKKER_CONFIG_DIR_OVERRIDE"] = a.config_dir

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(a.cwd)
        os.execvpe(cli[0], cli, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 110, 0, 0))
    st = {"out": b"", "alive": True, "last_text": time.time()}

    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end and st["alive"]:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    st["alive"] = False
                    break
                if not chunk:
                    st["alive"] = False
                    break
                st["out"] += chunk
                if strip_ansi(chunk).strip():
                    st["last_text"] = time.time()

    result = {"cards": [], "turns_user": None, "duration_s": None, "final_text": "", "bounded": False, "error": None}
    thread_id = None
    try:
        t0 = time.time()
        while "Session de code sur" not in strip_ansi(st["out"]) and time.time() - t0 < 40 and st["alive"]:
            pump(0.2)  # marqueur UNIQUE de démarrage : lu une seule fois
        if "Session de code sur" not in strip_ansi(st["out"]):
            raise RuntimeError("la CLI n'a pas ouvert de session de code en 40 s")
        sessions = api(a.server, token, "/v1/local/sessions").get("sessions", [])
        mine = [s for s in sessions if s.get("cwd") == a.cwd]
        if not mine:
            raise RuntimeError("session locale introuvable pour " + a.cwd)
        thread_id = max(mine, key=lambda s: s.get("last_turn_at") or "")["thread_id"] if any(s.get("last_turn_at") for s in mine) else mine[-1]["thread_id"]

        def mine_pending():
            appr = api(a.server, token, "/v1/local/approvals").get("approvals", [])
            return [x for x in appr if x["thread_id"] == thread_id or x["thread_id"].startswith(thread_id + "/sa-")]

        decided = {x["id"] for x in mine_pending()}  # cartes déjà là avant la tâche : jamais touchées
        os.write(fd, a.task.encode())
        pump(0.5)
        os.write(fd, b"\r")
        t_task = time.time()
        st["last_text"] = t_task
        deadline = t_task + a.timeout
        while time.time() < deadline and st["alive"]:
            pump(0.3)
            new = [x for x in mine_pending() if x["id"] not in decided]
            if new:
                card = new[0]
                if len(result["cards"]) >= a.max_decisions:
                    result["bounded"] = True  # une carte de plus que prévu : on s'arrête sans la décider
                    break
                decided.add(card["id"])  # AVANT d'envoyer la touche : un id ne reçoit jamais deux décisions
                pos = len(st["out"])  # le rendu se cherche dans le DELTA depuis la détection
                seen = False
                t1 = time.time()
                while time.time() - t1 < 10 and st["alive"]:
                    pump(0.2)
                    if "Action à approuver" in strip_ansi(st["out"][pos:]):
                        seen = True
                        break
                if not seen:
                    result["error"] = "carte " + card["id"] + " détectée par l'API mais jamais rendue à l'écran"
                    break
                pump(0.3)  # laisse Ink brancher les touches de la carte
                os.write(fd, a.decide.encode())
                args = card.get("arguments") or {}
                result["cards"].append({"t": round(time.time() - t_task, 1), "tool": card.get("tool_name"), "command": args.get("command") or args.get("path") or args.get("hash") or ""})
                st["last_text"] = time.time()
                continue
            if not mine_pending() and time.time() - st["last_text"] >= a.idle:
                break
        else:
            if st["alive"]:
                result["error"] = "délai global dépassé"
        result["duration_s"] = round(time.time() - t_task, 1)
    except Exception as e:  # noqa: BLE001
        result["error"] = str(e)
    finally:
        try:
            os.write(fd, b"\x03")  # Ctrl+C : quitte (une carte encore ouverte serait refusée)
        except OSError:
            pass
        time.sleep(0.5)
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
    if thread_id:
        try:
            view = api(a.server, token, "/v1/threads/" + thread_id)
            msgs = view.get("messages", [])
            result["turns_user"] = sum(1 for m in msgs if m.get("role") == "user" and (m.get("content") or "").strip())
            assistant = [m for m in msgs if m.get("role") == "assistant" and (m.get("content") or "").strip()]
            result["final_text"] = assistant[-1]["content"] if assistant else ""
        except Exception as e:  # noqa: BLE001
            result["error"] = (result["error"] or "") + " / lecture du fil : " + str(e)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if not result["error"] else 1


if len(sys.argv) > 1 and sys.argv[1].startswith("--"):
    sys.exit(scenario(sys.argv[1:]))

cfg = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cfg.get("cwd", "."))
    os.execvpe(cfg["argv"][0], cfg["argv"], {**os.environ, **cfg.get("env", {}), "TERM": "xterm-256color"})
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 110, 0, 0))
out = b""
alive = True

def pump(seconds, until=None):
    """Lit l'écran pendant `seconds`, ou jusqu'à ce que `until` y apparaisse (si donné)."""
    global out, alive
    end = time.time() + seconds
    while time.time() < end and alive:
        if until and until.encode() in out:
            return
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                chunk = os.read(fd, 65536)
                if not chunk:
                    alive = False
                out += chunk
            except OSError:
                alive = False

for step in cfg["steps"]:
    delay, data = step[0], step[1]
    pump(delay, step[2] if len(step) > 2 else None)  # 3e élément : attendre ce texte (au plus `delay` s)
    if alive:
        os.write(fd, data.encode())
pump(cfg.get("tail", 3))
exited = False
deadline = time.time() + 5
while time.time() < deadline:
    try:
        done, _ = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        exited = True
        break
    if done == pid:
        exited = True
        break
    pump(0.1)
if not exited:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
print(re.sub(rb"\x1b\[[0-9;?]*[a-zA-Z]", b"", out).decode("utf-8", "replace"))
print(f"EXITED={1 if exited else 0}")
