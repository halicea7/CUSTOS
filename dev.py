#!/usr/bin/env python3
"""Custos interactive dev console.

Usage:  ./dev.py            (auto-uses .venv if present)
        .venv/bin/python dev.py

Keybindings:
  n   toggle ngrok
  b   toggle bind-all (0.0.0.0, for Tailscale)
  r   restart all services
  ↺   per-service restart button in sidebar
  Ctrl+C  quit
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import socket
import sys
from pathlib import Path
from typing import Optional

# ── Auto-venv: re-exec with .venv Python if we're not inside it ──────────────
ROOT = Path(__file__).parent.resolve()
_venv_py = ROOT / ".venv" / "bin" / "python"
if _venv_py.exists() and not sys.prefix.startswith(str(ROOT / ".venv")):
    os.execv(str(_venv_py), [str(_venv_py)] + sys.argv)

# ── Dependency check ──────────────────────────────────────────────────────────
try:
    from textual import work
    from textual.app import App, ComposeResult
    from textual.binding import Binding
    from textual.containers import Container, Horizontal
    from textual.reactive import reactive
    from textual.widgets import (
        Button, Footer, Header, Label,
        RichLog, Static, Switch, TabbedContent, TabPane,
    )
except ImportError:
    sys.exit(
        "textual not installed — run once:\n"
        "  .venv/bin/pip install 'textual>=0.80'\n"
        "then retry: ./dev.py"
    )

# ── Paths & constants ─────────────────────────────────────────────────────────
API_DIR  = ROOT / "api"
DASH_DIR = ROOT / "dashboard"
LOG_DIR  = ROOT / ".dev-logs"

SVCS = ["redis", "api", "worker", "dashboard", "ngrok"]

SVC_LABEL = {
    "redis":     "Redis",
    "api":       "API",
    "worker":    "Worker",
    "dashboard": "Dashboard",
    "ngrok":     "ngrok",
}

SVC_COLOR = {
    "redis":     "dim",
    "api":       "cyan",
    "worker":    "magenta",
    "dashboard": "blue",
    "ngrok":     "yellow",
}

# ── CSS ───────────────────────────────────────────────────────────────────────
CSS = """
Screen { layout: horizontal; }

#sidebar {
    width: 34;
    height: 100%;
    border-right: solid $panel-darken-2;
    padding: 1 2;
    overflow-y: auto;
}

#main { flex: 1; height: 100%; }

/* Section headings */
.sh {
    color: $text-muted;
    text-style: bold;
    margin-top: 1;
    margin-bottom: 0;
}

/* Service rows */
.svc-row {
    layout: horizontal;
    height: 1;
    margin-top: 0;
    align: left middle;
}
.svc-dot  { width: 2; }
.svc-name { flex: 1; padding-left: 1; }
.svc-btn  {
    width: 3; min-width: 3;
    border: none;
    background: transparent;
    padding: 0 0;
    color: $text-muted;
}
.svc-btn:hover  { background: $panel; color: $text; }
.svc-btn:focus  { border: none; }

/* Option toggles */
.opt-row {
    layout: horizontal;
    height: 1;
    align: left middle;
    margin-top: 1;
}
.opt-label { flex: 1; }
Switch { height: 1; }

/* ngrok URL display */
#ngrok-url {
    height: 3;
    margin-top: 1;
    overflow: hidden;
}

/* Restart-all button */
#btn-restart-all {
    margin-top: 2;
    width: 100%;
}

/* Log area */
TabbedContent { height: 100%; }
TabPane       { height: 100%; padding: 0; }
RichLog       { height: 100%; scrollbar-size: 1 1; }
"""


# ── App ───────────────────────────────────────────────────────────────────────

class CustosDevApp(App):
    CSS       = CSS
    TITLE     = "Custos dev"
    SUB_TITLE = str(ROOT)

    BINDINGS = [
        Binding("ctrl+c", "quit",         "Quit",        priority=True),
        Binding("n",      "toggle_ngrok", "ngrok on/off"),
        Binding("b",      "toggle_bind",  "bind-all"),
        Binding("r",      "restart_all",  "Restart all"),
    ]

    ngrok_on:  reactive[bool] = reactive(False)
    bind_all:  reactive[bool] = reactive(False)
    ngrok_url: reactive[str]  = reactive("")

    def __init__(self) -> None:
        super().__init__()
        self._procs: dict[str, Optional[asyncio.subprocess.Process]] = {k: None for k in SVCS}
        self._redis_ext = False

    # ── Layout ────────────────────────────────────────────────────────────────

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)

        with Horizontal():
            with Container(id="sidebar"):
                yield Label("SERVICES", classes="sh")
                for key in SVCS:
                    with Horizontal(classes="svc-row"):
                        yield Static("○", id=f"dot-{key}", classes="svc-dot")
                        yield Label(SVC_LABEL[key], classes="svc-name")
                        yield Button("↺", id=f"btn-{key}", classes="svc-btn")

                yield Label("OPTIONS", classes="sh")
                with Horizontal(classes="opt-row"):
                    yield Label("ngrok",    classes="opt-label")
                    yield Switch(False, id="sw-ngrok")
                with Horizontal(classes="opt-row"):
                    yield Label("bind-all", classes="opt-label")
                    yield Switch(False, id="sw-bind")

                yield Label("", id="ngrok-url")
                yield Button("↺  Restart all", id="btn-restart-all")

            with Container(id="main"):
                with TabbedContent():
                    for key in SVCS:
                        with TabPane(SVC_LABEL[key], id=f"tab-{key}"):
                            yield RichLog(
                                id=f"log-{key}",
                                highlight=False,
                                markup=True,
                                wrap=True,
                            )

        yield Footer()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def on_mount(self) -> None:
        LOG_DIR.mkdir(exist_ok=True)

        self._redis_ext = _port_open(6379)
        if self._redis_ext:
            self._dot("redis", True)
            self._write("redis", "[dim]Redis already running — skipping start[/dim]")

        for port in (8000, 5173, 5174):
            await _kill_port(port)

        for key in SVCS:
            if key == "redis" and self._redis_ext:
                continue
            if key == "ngrok":
                continue  # only starts when toggled on
            await self._start(key)

    async def on_unmount(self) -> None:
        for key in SVCS:
            await self._kill(key)

    # ── Process management ────────────────────────────────────────────────────

    def _cmd(self, key: str) -> list[str] | None:
        host = "0.0.0.0" if self.bind_all else "127.0.0.1"
        py   = str(ROOT / ".venv" / "bin" / "python")
        uvi  = str(ROOT / ".venv" / "bin" / "uvicorn")

        if key == "redis":
            return ["redis-server", "--loglevel", "warning"]
        if key == "api":
            return [uvi, "main:app", "--reload", "--host", host, "--port", "8000"]
        if key == "worker":
            return [py, "-m", "arq", "worker.queue.WorkerSettings"]
        if key == "dashboard":
            cmd = ["npm", "run", "dev"]
            if self.bind_all:
                cmd += ["--", "--host", "0.0.0.0"]
            return cmd
        if key == "ngrok":
            return ["ngrok", "http", "8000", "--log=stdout"] if shutil.which("ngrok") else None
        return None

    async def _start(self, key: str) -> None:
        cmd = self._cmd(key)
        if not cmd:
            self._write(key, f"[red]{key}: not found (not installed)[/red]")
            return

        cwd = str(
            API_DIR  if key in ("api", "worker") else
            DASH_DIR if key == "dashboard"       else
            ROOT
        )
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "FORCE_COLOR": "0", "NO_COLOR": "1"}

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, cwd=cwd, env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        except FileNotFoundError:
            self._write(key, f"[red]{cmd[0]}: executable not found[/red]")
            return

        self._procs[key] = proc
        self._dot(key, True)
        self._write(key, f"[dim]started pid={proc.pid}[/dim]")
        self._stream(key, proc)

    async def _kill(self, key: str) -> None:
        proc = self._procs.get(key)
        if proc and proc.returncode is None:
            try:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=3.0)
                except asyncio.TimeoutError:
                    proc.kill()
            except ProcessLookupError:
                pass
        self._procs[key] = None
        self._dot(key, False)

    async def _restart(self, key: str) -> None:
        self._write(key, "[dim]— restarting —[/dim]")
        await self._kill(key)
        await asyncio.sleep(0.3)
        if key == "ngrok" and not self.ngrok_on:
            return
        await self._start(key)

    # ── Log streaming ─────────────────────────────────────────────────────────

    @work(exclusive=False)
    async def _stream(self, key: str, proc: asyncio.subprocess.Process) -> None:
        color = SVC_COLOR[key]

        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            text = _strip_ansi(raw.decode(errors="replace").rstrip())
            if not text:
                continue

            # Parse the ngrok public URL out of its log line
            if key == "ngrok":
                m = re.search(r'url=(https://\S+)', text)
                if m:
                    self.ngrok_url = m.group(1)

            lo = text.lower()
            if any(w in lo for w in ("error", "traceback", "exception", "critical", "fatal")):
                self._write(key, f"[red]{text}[/red]")
            elif any(w in lo for w in ("warning", "warn")):
                self._write(key, f"[yellow]{text}[/yellow]")
            else:
                self._write(key, f"[{color}]{text}[/{color}]")

        rc = proc.returncode
        self._dot(key, False)
        style = "red" if rc else "dim"
        self._write(key, f"[{style}]process exited (code {rc})[/{style}]")

    # ── Reactive watchers ─────────────────────────────────────────────────────

    def watch_ngrok_url(self, url: str) -> None:
        try:
            label = self.query_one("#ngrok-url", Label)
            if url:
                label.update(
                    f"[dim]tunnel:[/dim]  [yellow]{url}[/yellow]\n"
                    f"[dim]webhook:[/dim] [cyan]{url}/webhook/github[/cyan]"
                )
            else:
                label.update("")
        except Exception:
            pass

    # ── Event handlers ────────────────────────────────────────────────────────

    async def on_switch_changed(self, event: Switch.Changed) -> None:
        sw_id = event.switch.id
        if sw_id == "sw-ngrok":
            self.ngrok_on = event.value
            if event.value:
                self.ngrok_url = ""
                await self._start("ngrok")
            else:
                await self._kill("ngrok")
                self.ngrok_url = ""
        elif sw_id == "sw-bind":
            self.bind_all = event.value
            for key in ("api", "dashboard"):
                await self._restart(key)

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        bid = event.button.id or ""
        if bid == "btn-restart-all":
            await self.action_restart_all()
        elif bid.startswith("btn-"):
            key = bid[4:]
            if key in SVCS:
                await self._restart(key)

    # ── Actions (keybindings) ─────────────────────────────────────────────────

    async def action_restart_all(self) -> None:
        for key in SVCS:
            if key == "redis" and self._redis_ext:
                continue
            if key == "ngrok" and not self.ngrok_on:
                continue
            await self._restart(key)

    async def action_toggle_ngrok(self) -> None:
        sw = self.query_one("#sw-ngrok", Switch)
        sw.value = not sw.value

    async def action_toggle_bind(self) -> None:
        sw = self.query_one("#sw-bind", Switch)
        sw.value = not sw.value

    async def action_quit(self) -> None:
        for key in SVCS:
            await self._kill(key)
        self.exit()

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _dot(self, key: str, running: bool) -> None:
        try:
            self.query_one(f"#dot-{key}", Static).update(
                "[green]●[/green]" if running else "[red]○[/red]"
            )
        except Exception:
            pass

    def _write(self, key: str, msg: str) -> None:
        try:
            self.query_one(f"#log-{key}", RichLog).write(msg)
        except Exception:
            pass


# ── Standalone helpers ────────────────────────────────────────────────────────

def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


async def _kill_port(port: int) -> None:
    if shutil.which("fuser"):
        p = await asyncio.create_subprocess_exec(
            "fuser", "-k", f"{port}/tcp",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await p.wait()


def _strip_ansi(s: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*[mGKHFJ]", "", s)


# ── Entry ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    CustosDevApp().run()
