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

log "${CYAN}Starting API (uvicorn)...${RESET}"
(cd "$API_DIR" && uvicorn main:app --reload --host 127.0.0.1 --port 8000) \
  > "$LOG_DIR/api.log" 2>&1 &
PIDS+=($!)

log "${CYAN}Starting ARQ worker...${RESET}"
(cd "$API_DIR" && python -m arq worker.queue.WorkerSettings) \
  > "$LOG_DIR/worker.log" 2>&1 &
PIDS+=($!)

log "${CYAN}Starting dashboard (Vite)...${RESET}"
(cd "$DASH_DIR" && npm run dev) \
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

# ── Print status ──────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}Custos dev stack running${RESET}"
echo -e "  ${CYAN}Dashboard${RESET}  http://localhost:5173"
echo -e "  ${CYAN}API${RESET}        http://localhost:8000"
echo -e "  ${CYAN}API docs${RESET}   http://localhost:8000/docs"
echo -e "  ${CYAN}Logs${RESET}       $LOG_DIR/"
echo ""
echo -e "Press ${BOLD}Ctrl+C${RESET} to stop all services."
echo ""

# ── Tail logs to terminal ─────────────────────────────────────────────────────
tail -f \
  "$LOG_DIR/api.log" \
  "$LOG_DIR/worker.log" \
  "$LOG_DIR/dashboard.log" &
PIDS+=($!)

wait
