#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$ROOT/api"
DASH_DIR="$ROOT/dashboard"
LOG_DIR="$ROOT/.dev-logs"

mkdir -p "$LOG_DIR"

PIDS=()

cleanup() {
  echo ""
  echo "Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "Done."
  exit 0
}

trap cleanup INT TERM

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log() { echo -e "${BOLD}[dev]${RESET} $*"; }

# ── Virtualenv ────────────────────────────────────────────────────────────────
VENV="$ROOT/.venv"
if [[ -f "$VENV/bin/activate" ]]; then
  # shellcheck source=/dev/null
  source "$VENV/bin/activate"
  log "${GREEN}Activated venv: $VENV${RESET}"
else
  echo -e "${YELLOW}No .venv found at $VENV — using system Python${RESET}"
fi

# ── Pre-flight checks ─────────────────────────────────────────────────────────
if ! command -v redis-server &>/dev/null; then
  echo -e "${RED}redis-server not found. Install with: brew install redis${RESET}"
  exit 1
fi

if ! command -v uvicorn &>/dev/null; then
  echo -e "${RED}uvicorn not found. Run: pip install -r api/requirements.txt${RESET}"
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo -e "${RED}npm not found.${RESET}"
  exit 1
fi

# Check if Redis is already running
if redis-cli ping &>/dev/null 2>&1; then
  log "${YELLOW}Redis already running — skipping start${RESET}"
  REDIS_EXTERNAL=1
else
  REDIS_EXTERNAL=0
fi

# ── Start services ────────────────────────────────────────────────────────────

if [[ "$REDIS_EXTERNAL" -eq 0 ]]; then
  log "${CYAN}Starting Redis...${RESET}"
  redis-server --loglevel warning > "$LOG_DIR/redis.log" 2>&1 &
  PIDS+=($!)
  sleep 0.5
fi

# DEV_BIND_ALL=1 exposes both servers on all interfaces (e.g. for Tailscale).
# Defaults to localhost-only. Do not set in untrusted network environments.
BIND_HOST="127.0.0.1"
VITE_HOST_FLAG=""
if [[ "${DEV_BIND_ALL:-0}" == "1" ]]; then
  BIND_HOST="0.0.0.0"
  VITE_HOST_FLAG="--host 0.0.0.0"
  log "${YELLOW}DEV_BIND_ALL=1 — binding to 0.0.0.0 (all interfaces)${RESET}"
fi

log "${CYAN}Starting API (uvicorn)...${RESET}"
(cd "$API_DIR" && uvicorn main:app --reload --host "$BIND_HOST" --port 8000) \
  > "$LOG_DIR/api.log" 2>&1 &
PIDS+=($!)

log "${CYAN}Starting ARQ worker...${RESET}"
(cd "$API_DIR" && python -m arq worker.queue.WorkerSettings) \
  > "$LOG_DIR/worker.log" 2>&1 &
PIDS+=($!)

log "${CYAN}Starting dashboard (Vite)...${RESET}"
# shellcheck disable=SC2086
(cd "$DASH_DIR" && npm run dev -- $VITE_HOST_FLAG) \
  > "$LOG_DIR/dashboard.log" 2>&1 &
PIDS+=($!)

# ── Wait for API to be ready ──────────────────────────────────────────────────
log "Waiting for API..."
for i in $(seq 1 20); do
  if curl -s http://localhost:8000/health &>/dev/null; then
    break
  fi
  sleep 0.5
done

# ── ngrok (opt-in: DEV_NGROK=1) ───────────────────────────────────────────────
NGROK_PUBLIC_URL=""
if [[ "${DEV_NGROK:-0}" == "1" ]]; then
  if ! command -v ngrok &>/dev/null; then
    log "${RED}ngrok not found — skipping. Install: https://ngrok.com/download${RESET}"
  else
    log "${CYAN}Starting ngrok tunnel on port 8000...${RESET}"
    ngrok http 8000 --log=stdout > "$LOG_DIR/ngrok.log" 2>&1 &
    PIDS+=($!)

    # Poll ngrok's local API until the tunnel URL appears (up to 10s)
    for i in $(seq 1 20); do
      NGROK_PUBLIC_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null \
        | grep -o '"public_url":"https://[^"]*"' | head -1 | cut -d'"' -f4 || true)
      if [[ -n "$NGROK_PUBLIC_URL" ]]; then break; fi
      sleep 0.5
    done

    if [[ -z "$NGROK_PUBLIC_URL" ]]; then
      log "${YELLOW}ngrok started but URL not yet available — check .dev-logs/ngrok.log${RESET}"
    fi
  fi
fi

# ── Print status ──────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}Custos dev stack running${RESET}"
echo -e "  ${CYAN}Dashboard${RESET}  http://localhost:5173"
echo -e "  ${CYAN}API${RESET}        http://localhost:8000"
echo -e "  ${CYAN}API docs${RESET}   http://localhost:8000/docs"
if [[ "${DEV_BIND_ALL:-0}" == "1" ]]; then
  HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<server-ip>")
  echo -e "  ${YELLOW}Network${RESET}    http://${HOST_IP}:5173  |  http://${HOST_IP}:8000"
fi
if [[ -n "$NGROK_PUBLIC_URL" ]]; then
  echo -e "  ${YELLOW}ngrok${RESET}      $NGROK_PUBLIC_URL"
  echo -e "  ${YELLOW}Webhook URL${RESET} ${NGROK_PUBLIC_URL}/api/webhook/github"
fi
echo -e "  ${CYAN}Logs${RESET}       $LOG_DIR/"
echo ""
echo -e "Press ${BOLD}Ctrl+C${RESET} to stop all services."
echo ""

# ── Tail logs to terminal ─────────────────────────────────────────────────────
TAIL_LOGS=("$LOG_DIR/api.log" "$LOG_DIR/worker.log" "$LOG_DIR/dashboard.log")
[[ "${DEV_NGROK:-0}" == "1" ]] && TAIL_LOGS+=("$LOG_DIR/ngrok.log")
tail -f "${TAIL_LOGS[@]}" &
PIDS+=($!)

wait
