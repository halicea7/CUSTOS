#!/usr/bin/env python3
"""Custos dev console — live log stream with interactive controls.

  ./dev.py

  n  toggle ngrok (webhook tunnel)
  b  toggle bind-all (0.0.0.0 for Tailscale)
  r  restart all services
  q  quit
"""
from __future__ import annotations

import os, re, select, shutil, signal, socket, sys, termios, threading, tty
import subprocess
from datetime import datetime
from pathlib  import Path
from queue    import Queue, Empty
from subprocess import Popen, PIPE, STDOUT
from time     import sleep
from typing   import Optional

# ── auto-venv ─────────────────────────────────────────────────────────────────
ROOT  = Path(__file__).parent.resolve()
_venv = ROOT / ".venv" / "bin" / "python"
if _venv.exists() and not sys.prefix.startswith(str(ROOT / ".venv")):
    os.execv(str(_venv), [str(_venv)] + sys.argv)

try:
    from rich.console import Console
    from rich.text    import Text
    from rich.rule    import Rule
except ImportError:
    sys.exit("rich not found — run: .venv/bin/pip install rich")

# ── paths ──────────────────────────────────────────────────────────────────────
API_DIR  = ROOT / "api"
DASH_DIR = ROOT / "dashboard"
LOG_DIR  = ROOT / ".dev-logs"

# ── service catalogue ──────────────────────────────────────────────────────────
SVCS = ["redis", "api", "worker", "dashboard", "ngrok"]
LABEL = {"redis":"Redis","api":"API","worker":"Worker","dashboard":"Dashboard","ngrok":"ngrok"}
COLOR = {"redis":"dim","api":"cyan","worker":"magenta","dashboard":"blue","ngrok":"yellow"}

# ── shared state ───────────────────────────────────────────────────────────────
_procs:   dict[str, Optional[Popen]] = {k: None for k in SVCS}
_alive:   dict[str, bool]             = {k: False for k in SVCS}
_ngrok    = False
_bind     = False
_ngrok_url = ""
_queue:   Queue = Queue()
_running  = True
_redis_ext = False
_lock     = threading.Lock()

con = Console(highlight=False, markup=True)

# ── helpers ────────────────────────────────────────────────────────────────────

def _port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0

def _kill_port(port: int) -> None:
    if shutil.which("fuser"):
        subprocess.run(
            ["fuser", "-k", f"{port}/tcp"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

def _strip_ansi(s: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*[mGKHFJ]", "", s)

def _ts() -> str:
    return datetime.now().strftime("%H:%M:%S")

def _push(key: str, line: str) -> None:
    _queue.put((key, line))

# ── banner ─────────────────────────────────────────────────────────────────────

def _print_banner() -> None:
    con.print()
    con.rule("[bold white]CUSTOS dev[/bold white]")

    parts = []
    for k in SVCS:
        dot   = "[green]●[/green]" if _alive.get(k) else "[red]○[/red]"
        parts.append(f"{dot} {LABEL[k]}")
    con.print("  " + "  ".join(parts))

    ngrok_s = "[yellow]ngrok: ON[/yellow]" if _ngrok else "[dim]ngrok: OFF[/dim]"
    bind_s  = "[cyan]bind-all: ON[/cyan]" if _bind  else "[dim]bind-all: OFF[/dim]"
    con.print(f"  {ngrok_s}   {bind_s}")

    if _ngrok_url:
        con.print(f"  [yellow]tunnel:[/yellow]  [yellow]{_ngrok_url}[/yellow]")
        con.print(f"  [yellow]webhook:[/yellow] [cyan]{_ngrok_url}/webhook/github[/cyan]")

    con.print("  [dim][n] ngrok  [b] bind-all  [r] restart  [q] quit[/dim]")
    con.rule()
    con.print()

# ── process management ─────────────────────────────────────────────────────────

def _cmd(key: str) -> list[str] | None:
    host = "0.0.0.0" if _bind else "127.0.0.1"
    py   = str(ROOT / ".venv" / "bin" / "python")
    uvi  = str(ROOT / ".venv" / "bin" / "uvicorn")

    if key == "redis":     return ["redis-server", "--loglevel", "warning"]
    if key == "api":       return [uvi, "main:app", "--reload", "--host", host, "--port", "8000"]
    if key == "worker":    return [py, "-m", "arq", "worker.queue.WorkerSettings"]
    if key == "dashboard":
        cmd = ["npm", "run", "dev"]
        if _bind: cmd += ["--", "--host", "0.0.0.0"]
        return cmd
    if key == "ngrok":
        return ["ngrok", "http", "8000", "--log=stdout"] if shutil.which("ngrok") else None
    return None

def _reader(key: str, proc: Popen) -> None:
    """Thread: reads proc stdout and puts lines into the queue."""
    global _ngrok_url
    color = COLOR[key]
    try:
        for raw in proc.stdout:
            if not _running:
                break
            line = _strip_ansi(raw.decode(errors="replace").rstrip())
            if not line:
                continue
            # Parse ngrok URL from its log stream
            if key == "ngrok":
                m = re.search(r'url=(https://\S+)', line)
                if m:
                    _ngrok_url = m.group(1)
                    _push("ngrok", f"[yellow]tunnel → {_ngrok_url}[/yellow]")
                    _push("ngrok", f"[cyan]webhook → {_ngrok_url}/webhook/github[/cyan]")
                    _push("__banner__", "")  # trigger banner reprint
                    continue
            lo = line.lower()
            if any(w in lo for w in ("error","traceback","exception","critical","fatal")):
                _push(key, f"[red]{line}[/red]")
            elif any(w in lo for w in ("warning","warn")):
                _push(key, f"[yellow]{line}[/yellow]")
            else:
                _push(key, f"[{color}]{line}[/{color}]")
    except Exception:
        pass

    with _lock:
        _alive[key] = False
    rc = proc.returncode if proc.returncode is not None else "?"
    _push(key, f"[dim]exited (code {rc})[/dim]")

def _start(key: str) -> None:
    global _ngrok_url
    cmd = _cmd(key)
    if not cmd:
        _push(key, f"[red]{key}: command not found[/red]")
        return

    cwd = str(API_DIR if key in ("api","worker") else DASH_DIR if key == "dashboard" else ROOT)
    env = {**os.environ, "PYTHONUNBUFFERED": "1", "FORCE_COLOR": "0", "NO_COLOR": "1"}

    try:
        proc = Popen(cmd, cwd=cwd, env=env,
                     stdin=subprocess.DEVNULL, stdout=PIPE, stderr=STDOUT)
    except FileNotFoundError:
        _push(key, f"[red]{cmd[0]}: executable not found[/red]")
        return

    with _lock:
        _procs[key] = proc
        _alive[key] = True
        if key == "ngrok":
            _ngrok_url = ""

    _push(key, f"[dim]started pid={proc.pid}[/dim]")
    threading.Thread(target=_reader, args=(key, proc), daemon=True).start()

def _stop(key: str) -> None:
    proc = _procs.get(key)
    if proc and proc.poll() is None:
        try:
            proc.terminate()
            try:   proc.wait(timeout=3)
            except Exception: proc.kill()
        except Exception:
            pass
    with _lock:
        _procs[key] = None
        _alive[key] = False

def _restart(key: str) -> None:
    _push(key, "[dim]— restarting —[/dim]")
    _stop(key)
    sleep(0.3)
    if key == "ngrok" and not _ngrok:
        return
    _start(key)

# ── keyboard ───────────────────────────────────────────────────────────────────

def _getkey() -> Optional[str]:
    """Non-blocking: return a key if available, else None."""
    if select.select([sys.stdin], [], [], 0)[0]:
        ch = sys.stdin.read(1)
        if ch == "\x03": return "q"       # Ctrl+C
        if ch == "\x1b":                   # escape sequence — discard
            if select.select([sys.stdin], [], [], 0.05)[0]:
                sys.stdin.read(2)
            return None
        return ch.lower()
    return None

# ── main loop ──────────────────────────────────────────────────────────────────

def _handle_key(ch: str) -> None:
    global _ngrok, _bind, _ngrok_url

    if ch == "n":
        _ngrok = not _ngrok
        if _ngrok:
            _start("ngrok")
        else:
            _stop("ngrok")
            _ngrok_url = ""
        _print_banner()

    elif ch == "b":
        _bind = not _bind
        for key in ("api", "dashboard"):
            _restart(key)
        _print_banner()

    elif ch == "r":
        _push("__banner__", "")
        for key in SVCS:
            if key == "redis" and _redis_ext:
                continue
            if key == "ngrok" and not _ngrok:
                continue
            _restart(key)

    elif ch == "q":
        _shutdown()

def _shutdown() -> None:
    global _running
    _running = False
    con.print("\n[dim]Shutting down…[/dim]")
    for key in SVCS:
        _stop(key)
    try:
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, _old_term)
    except Exception:
        pass
    sys.exit(0)

_old_term = None

def main() -> None:
    global _redis_ext, _old_term

    LOG_DIR.mkdir(exist_ok=True)
    _print_banner()

    # Check Redis
    _redis_ext = _port_open(6379)
    if _redis_ext:
        with _lock:
            _alive["redis"] = True
        _push("redis", "[dim]Redis already running — skipping start[/dim]")

    # Clean ports
    for port in (8000, 5173, 5174):
        _kill_port(port)

    # Start services
    for key in SVCS:
        if key == "redis" and _redis_ext:
            continue
        if key == "ngrok":
            continue
        _start(key)

    # Set terminal to cbreak-like mode:
    # - char-at-a-time input (ICANON off, no need to press Enter)
    # - Ctrl+C passed as \x03 (ISIG off, we handle quit ourselves)
    # - output processing KEPT ON (OPOST stays) so \n → \r\n and lines stay left-aligned
    fd = sys.stdin.fileno()
    try:
        _old_term = termios.tcgetattr(fd)
        new = termios.tcgetattr(fd)
        new[3] = new[3] & ~(termios.ECHO | termios.ICANON | termios.ISIG)
        new[6][termios.VMIN]  = 1
        new[6][termios.VTIME] = 0
        termios.tcsetattr(fd, termios.TCSAFLUSH, new)
    except Exception:
        _old_term = None

    last_banner = 0.0

    try:
        while _running:
            # Drain the log queue
            printed = 0
            while printed < 50:
                try:
                    key, line = _queue.get_nowait()
                except Empty:
                    break
                if key == "__banner__":
                    _print_banner()
                else:
                    ts = _ts()
                    label = f"[{COLOR[key]}][{LABEL[key]:9}][/{COLOR[key]}]"
                    con.print(f"[dim]{ts}[/dim] {label} {line}")
                printed += 1

            # Check keyboard
            ch = _getkey()
            if ch:
                _handle_key(ch)

            sleep(0.05)

    except KeyboardInterrupt:
        pass
    finally:
        _shutdown()


if __name__ == "__main__":
    main()
