#!/usr/bin/env bash
# Custos local development setup wizard.
# Run once from the project root: bash wizard.sh
set -uo pipefail

# ── colours ───────────────────────────────────────────────────────────────────

BOLD='\033[1m'
DIM='\033[2m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
RESET='\033[0m'

# ── helpers ───────────────────────────────────────────────────────────────────

header() {
  echo ""
  echo -e "${BOLD}${WHITE}━━━  $*  ━━━${RESET}"
  echo ""
}

step_label() {
  echo -e "${CYAN}${BOLD}[$1/$TOTAL_STEPS]${RESET}${BOLD} $2${RESET}"
}

ok()   { echo -e "  ${GREEN}✓${RESET}  $*"; }
info() { echo -e "  ${CYAN}→${RESET}  $*"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
err()  { echo -e "  ${RED}✗${RESET}  $*" >&2; }
die()  { err "$*"; exit 1; }

# Prompt with a default value.
# Usage: result=$(ask "Label" "default")
ask() {
  local label="$1" default="$2" reply
  if [[ -n "$default" ]]; then
    read -rp "    ${label} [${DIM}${default}${RESET}]: " reply
    echo "${reply:-$default}"
  else
    read -rp "    ${label}: " reply
    echo "$reply"
  fi
}

# Prompt for a secret (hidden input).
ask_secret() {
  local label="$1" reply
  read -rsp "    ${label}: " reply
  echo ""  # newline after hidden input
  echo "$reply"
}

# y/n confirm — defaults to YES unless second arg is "n".
confirm() {
  local prompt="$1" default="${2:-y}" reply
  if [[ "$default" == "y" ]]; then
    read -rp "    ${prompt} [Y/n]: " reply
  else
    read -rp "    ${prompt} [y/N]: " reply
  fi
  reply="${reply:-$default}"
  [[ "${reply,,}" == "y" || "${reply,,}" == "yes" ]]
}

# Print a horizontal rule.
rule() { echo -e "${DIM}  ────────────────────────────────────────────${RESET}"; }

TOTAL_STEPS=8

# ── sanity check — must run from project root ────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f "dev.sh" || ! -d "api" || ! -d "dashboard" ]]; then
  die "Run this script from the Custos_CodeRev project root."
fi

# ── welcome ───────────────────────────────────────────────────────────────────

clear
echo ""
echo -e "${BOLD}${WHITE}"
echo "  ██████╗██╗   ██╗███████╗████████╗ ██████╗ ███████╗"
echo "  ██╔════╝██║   ██║██╔════╝╚══██╔══╝██╔═══██╗██╔════╝"
echo "  ██║     ██║   ██║███████╗   ██║   ██║   ██║███████╗"
echo "  ██║     ██║   ██║╚════██║   ██║   ██║   ██║╚════██║"
echo "  ╚██████╗╚██████╔╝███████║   ██║   ╚██████╔╝███████║"
echo "   ╚═════╝ ╚═════╝ ╚══════╝   ╚═╝    ╚═════╝ ╚══════╝"
echo -e "${RESET}"
echo -e "  ${DIM}Local Development Setup Wizard${RESET}"
echo ""
rule
echo ""
echo -e "  This wizard will set up Custos for local development:"
echo ""
echo -e "    ${CYAN}1${RESET}  Check prerequisites"
echo -e "    ${CYAN}2${RESET}  Create Python virtual environment"
echo -e "    ${CYAN}3${RESET}  Set up PostgreSQL database"
echo -e "    ${CYAN}4${RESET}  Write api/.env configuration"
echo -e "    ${CYAN}5${RESET}  Run database migrations"
echo -e "    ${CYAN}6${RESET}  Create first admin user"
echo -e "    ${CYAN}7${RESET}  Install SAST analysis tools"
echo -e "    ${CYAN}8${RESET}  Install dashboard dependencies"
echo ""
rule
echo ""
echo -e "  Press ${BOLD}Enter${RESET} to start, or ${BOLD}Ctrl+C${RESET} to exit."
read -r

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — Prerequisites
# ─────────────────────────────────────────────────────────────────────────────

header "Step 1 of $TOTAL_STEPS — Prerequisites"
step_label 1 "Checking required tools"
echo ""

PREREQ_OK=1

# Python 3.12+
if command -v python3 &>/dev/null; then
  PY_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  PY_MAJOR=$(python3 -c 'import sys; print(sys.version_info.major)')
  PY_MINOR=$(python3 -c 'import sys; print(sys.version_info.minor)')
  if [[ "$PY_MAJOR" -ge 3 && "$PY_MINOR" -ge 12 ]]; then
    ok "Python $PY_VERSION"
    PYTHON=python3
  else
    warn "Python $PY_VERSION found — Custos requires 3.12+. Continuing anyway."
    PYTHON=python3
  fi
else
  err "python3 not found. Install Python 3.12+ and re-run."
  PREREQ_OK=0
fi

# Node.js 20+
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [[ "$NODE_MAJOR" -ge 20 ]]; then
    ok "Node.js v$NODE_VERSION"
  else
    warn "Node.js v$NODE_VERSION found — v20+ recommended."
  fi
else
  err "node not found. Install Node.js 20+ (https://nodejs.org) and re-run."
  PREREQ_OK=0
fi

# npm
if command -v npm &>/dev/null; then
  ok "npm $(npm --version)"
else
  err "npm not found."
  PREREQ_OK=0
fi

# psql — try PATH then known Homebrew locations
PSQL=""
for candidate in psql \
    /opt/homebrew/opt/postgresql@16/bin/psql \
    /opt/homebrew/opt/postgresql@15/bin/psql \
    /usr/local/opt/postgresql@16/bin/psql \
    /usr/bin/psql; do
  if command -v "$candidate" &>/dev/null 2>&1; then
    PSQL="$candidate"
    break
  fi
done

if [[ -n "$PSQL" ]]; then
  ok "psql ($PSQL)"
else
  err "psql not found."
  echo ""
  echo -e "  ${DIM}Install PostgreSQL:${RESET}"
  echo -e "    macOS:  brew install postgresql@16"
  echo -e "    Ubuntu: sudo apt install postgresql"
  PREREQ_OK=0
fi

# Redis
if command -v redis-server &>/dev/null; then
  ok "redis-server $(redis-server --version | awk '{print $3}' | tr -d 'v')"
elif command -v redis-cli &>/dev/null; then
  ok "redis-cli found (server managed externally)"
else
  warn "redis-server not found."
  echo ""
  echo -e "  ${DIM}Install Redis:${RESET}"
  echo -e "    macOS:  brew install redis"
  echo -e "    Ubuntu: sudo apt install redis-server"
fi

echo ""

if [[ "$PREREQ_OK" -eq 0 ]]; then
  die "Fix the errors above and re-run the wizard."
fi

ok "All required tools present."
echo ""
read -rp "  Press Enter to continue..."

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — Python virtual environment
# ─────────────────────────────────────────────────────────────────────────────

header "Step 2 of $TOTAL_STEPS — Python virtual environment"
step_label 2 "Setting up .venv and installing dependencies"
echo ""

VENV_DIR="$SCRIPT_DIR/.venv"

if [[ -d "$VENV_DIR" ]]; then
  ok ".venv already exists — skipping creation."
else
  info "Creating virtual environment at .venv ..."
  $PYTHON -m venv "$VENV_DIR"
  ok "Virtual environment created."
fi

VENV_PYTHON="$VENV_DIR/bin/python3"
VENV_PIP="$VENV_DIR/bin/pip"

info "Installing Python dependencies from api/requirements.txt ..."
"$VENV_PIP" install --quiet -r api/requirements.txt
ok "Python dependencies installed."

echo ""
read -rp "  Press Enter to continue..."

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — PostgreSQL database
# ─────────────────────────────────────────────────────────────────────────────

header "Step 3 of $TOTAL_STEPS — PostgreSQL database"
step_label 3 "Creating role and database"
echo ""

# Check if Postgres is reachable
PG_RUNNING=0
if "$PSQL" -U "$(whoami)" postgres -c "\q" &>/dev/null 2>&1; then
  PG_RUNNING=1
elif "$PSQL" -U postgres postgres -c "\q" &>/dev/null 2>&1; then
  PG_RUNNING=1
  PG_SUPERUSER="postgres"
fi

if [[ "$PG_RUNNING" -eq 0 ]]; then
  warn "Cannot connect to PostgreSQL."
  echo ""
  echo -e "  ${DIM}Start it first:${RESET}"
  echo -e "    macOS:  brew services start postgresql@16"
  echo -e "    Ubuntu: sudo systemctl start postgresql"
  echo ""
  if ! confirm "Try connecting again after you start it?"; then
    warn "Skipping database setup — run 'make db && alembic upgrade head' manually later."
    DB_SETUP=0
  else
    info "Retrying..."
    if "$PSQL" -U "$(whoami)" postgres -c "\q" &>/dev/null 2>&1; then
      PG_RUNNING=1
    else
      warn "Still cannot connect. Skipping database setup."
      DB_SETUP=0
    fi
  fi
fi

DB_SETUP=${DB_SETUP:-1}

if [[ "$DB_SETUP" -eq 1 && "$PG_RUNNING" -eq 1 ]]; then
  PG_SUPERUSER="${PG_SUPERUSER:-$(whoami)}"

  echo ""
  echo -e "  ${DIM}Default database settings:${RESET}"
  echo -e "    User:     ${BOLD}Custos${RESET}"
  echo -e "    Password: ${BOLD}Custos${RESET}"
  echo -e "    Database: ${BOLD}Custos${RESET}"
  echo -e "    Host:     ${BOLD}localhost:5432${RESET}"
  echo ""

  if confirm "Use these defaults?"; then
    DB_USER="Custos"
    DB_PASS="Custos"
    DB_NAME="Custos"
    DB_HOST="localhost"
    DB_PORT="5432"
  else
    DB_USER=$(ask "Database user" "Custos")
    DB_PASS=$(ask_secret "Database password")
    DB_NAME=$(ask "Database name" "Custos")
    DB_HOST=$(ask "Host" "localhost")
    DB_PORT=$(ask "Port" "5432")
  fi

  echo ""
  info "Creating role '${DB_USER}' ..."
  "$PSQL" -U "$PG_SUPERUSER" postgres \
    -c "CREATE USER \"${DB_USER}\" WITH PASSWORD '${DB_PASS}';" \
    2>/dev/null && ok "Role created." || ok "Role already exists — skipping."

  info "Creating database '${DB_NAME}' ..."
  "$PSQL" -U "$PG_SUPERUSER" postgres \
    -c "CREATE DATABASE \"${DB_NAME}\" OWNER \"${DB_USER}\";" \
    2>/dev/null && ok "Database created." || ok "Database already exists — skipping."
else
  DB_USER="Custos"
  DB_PASS="Custos"
  DB_NAME="Custos"
  DB_HOST="localhost"
  DB_PORT="5432"
fi

DB_URL="postgresql+asyncpg://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

echo ""
read -rp "  Press Enter to continue..."

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 — api/.env configuration
# ─────────────────────────────────────────────────────────────────────────────

header "Step 4 of $TOTAL_STEPS — Environment configuration"
step_label 4 "Writing api/.env"
echo ""

ENV_FILE="$SCRIPT_DIR/api/.env"
WRITE_ENV=1

if [[ -f "$ENV_FILE" ]]; then
  warn "api/.env already exists."
  if ! confirm "Overwrite it?" "n"; then
    ok "Keeping existing api/.env."
    WRITE_ENV=0
  fi
fi

if [[ "$WRITE_ENV" -eq 1 ]]; then
  echo ""

  # Generate a secret key
  SECRET_KEY=$("$VENV_PYTHON" -c "import secrets; print(secrets.token_hex(32))")
  ok "Generated SECRET_KEY."

  echo ""
  echo -e "  ${BOLD}Ollama (local LLM)${RESET}"
  echo -e "  ${DIM}Custos needs a running Ollama instance. No code leaves your machine.${RESET}"
  echo ""
  OLLAMA_URL=$(ask "Ollama base URL" "http://localhost:11434")
  OLLAMA_MODEL=$(ask "Model name (must match 'ollama list')" "qwen2.5-coder:32b")

  echo ""
  echo -e "  ${BOLD}GitHub integration${RESET} ${DIM}(optional — press Enter to skip)${RESET}"
  echo ""
  GH_WEBHOOK_SECRET=$(ask "Webhook secret" "")
  GH_TOKEN=$(ask "GitHub token (Contents:Read + Checks:Write)" "")

  echo ""
  echo -e "  ${BOLD}Redis${RESET}"
  if confirm "Use default Redis URL (redis://localhost:6379)?"; then
    REDIS_URL="redis://localhost:6379"
  else
    REDIS_URL=$(ask "Redis URL" "redis://localhost:6379")
  fi

  # Write the file
  cat > "$ENV_FILE" <<EOF
# Generated by wizard.sh — $(date '+%Y-%m-%d %H:%M:%S')

SECRET_KEY=${SECRET_KEY}
ACCESS_TOKEN_EXPIRE_MINUTES=480

DATABASE_URL=${DB_URL}
REDIS_URL=${REDIS_URL}

OLLAMA_BASE_URL=${OLLAMA_URL}
OLLAMA_MODEL=${OLLAMA_MODEL}

GITHUB_WEBHOOK_SECRET=${GH_WEBHOOK_SECRET}
GITHUB_TOKEN=${GH_TOKEN}

CLONE_BASE_DIR=/tmp/Custos_clones
MAX_FILE_SIZE_KB=500
MAX_FILES_PER_REPO=200
EOF

  ok "api/.env written."
  echo ""
  echo -e "  ${DIM}You can edit it at any time: nano api/.env${RESET}"
fi

echo ""
read -rp "  Press Enter to continue..."

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 — Migrations
# ─────────────────────────────────────────────────────────────────────────────

header "Step 5 of $TOTAL_STEPS — Database migrations"
step_label 5 "Running alembic upgrade head"
echo ""

if [[ "$DB_SETUP" -eq 0 ]]; then
  warn "Skipping migrations — database was not set up in step 3."
  warn "Run 'alembic upgrade head' manually once your database is ready."
else
  info "Running migrations..."
  echo ""
  # Run alembic from project root with the venv's Python on PATH
  PATH="$VENV_DIR/bin:$PATH" alembic upgrade head
  echo ""
  ok "Migrations complete."
fi

echo ""
read -rp "  Press Enter to continue..."

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6 — Create admin user
# ─────────────────────────────────────────────────────────────────────────────

header "Step 6 of $TOTAL_STEPS — Create first admin user"
step_label 6 "Setting up your login account"
echo ""

if [[ "$DB_SETUP" -eq 0 ]]; then
  warn "Skipping user creation — database was not set up."
  warn "Run: cd api && python create_user.py <user> <pass> admin"
else
  echo -e "  ${DIM}This account will have full admin access to the dashboard.${RESET}"
  echo ""

  ADMIN_USER=$(ask "Admin username" "admin")
  ADMIN_PASS=$(ask_secret "Admin password")
  ADMIN_PASS_CONFIRM=$(ask_secret "Confirm password")

  if [[ "$ADMIN_PASS" != "$ADMIN_PASS_CONFIRM" ]]; then
    err "Passwords do not match. Skipping user creation."
    warn "Run manually: cd api && python create_user.py <user> <pass> admin"
  elif [[ -z "$ADMIN_PASS" ]]; then
    err "Password cannot be empty. Skipping user creation."
    warn "Run manually: cd api && python create_user.py <user> <pass> admin"
  else
    echo ""
    info "Creating user '${ADMIN_USER}' ..."
    if (cd api && "$VENV_PYTHON" create_user.py "$ADMIN_USER" "$ADMIN_PASS" admin 2>&1); then
      ok "Admin user '${ADMIN_USER}' created."
    else
      warn "User creation failed — the user may already exist."
      warn "Run manually: cd api && python create_user.py <user> <pass> admin"
    fi
  fi
fi

echo ""
read -rp "  Press Enter to continue..."

# ─────────────────────────────────────────────────────────────────────────────
# STEP 7 — SAST tools
# ─────────────────────────────────────────────────────────────────────────────

header "Step 7 of $TOTAL_STEPS — SAST analysis tools"
step_label 7 "Semgrep · Gitleaks · pip-audit"
echo ""

echo -e "  These tools power the automated code scanning. Missing tools are"
echo -e "  skipped at runtime — they do not prevent the app from starting."
echo ""

SAST_MISSING=()
command -v semgrep   &>/dev/null && ok "semgrep already installed"   || SAST_MISSING+=("semgrep")
command -v gitleaks  &>/dev/null && ok "gitleaks already installed"  || SAST_MISSING+=("gitleaks")
command -v pip-audit &>/dev/null || "$VENV_DIR/bin/pip-audit" --version &>/dev/null 2>&1 \
  && ok "pip-audit already installed" \
  || SAST_MISSING+=("pip-audit")

if [[ ${#SAST_MISSING[@]} -eq 0 ]]; then
  ok "All SAST tools are present."
else
  echo ""
  warn "Missing: ${SAST_MISSING[*]}"
  echo ""

  if confirm "Install missing SAST tools now?"; then
    echo ""

    for tool in "${SAST_MISSING[@]}"; do
      case "$tool" in
        semgrep)
          info "Installing semgrep ..."
          "$VENV_PIP" install --quiet semgrep \
            && ok "semgrep installed." \
            || warn "semgrep install failed — run: pip install semgrep"
          ;;
        pip-audit)
          info "Installing pip-audit ..."
          "$VENV_PIP" install --quiet pip-audit \
            && ok "pip-audit installed." \
            || warn "pip-audit install failed — run: pip install pip-audit"
          ;;
        gitleaks)
          info "Installing gitleaks ..."
          if command -v brew &>/dev/null; then
            brew install gitleaks --quiet \
              && ok "gitleaks installed via Homebrew." \
              || warn "brew install gitleaks failed."
          else
            # Linux: download latest binary from GitHub
            GITLEAKS_VER="8.18.4"
            ARCH=$(uname -m)
            case "$ARCH" in
              x86_64)  GL_ARCH="x64" ;;
              aarch64) GL_ARCH="arm64" ;;
              *)        GL_ARCH="x64" ;;
            esac
            GL_URL="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VER}/gitleaks_${GITLEAKS_VER}_linux_${GL_ARCH}.tar.gz"
            info "Downloading gitleaks v${GITLEAKS_VER} (${GL_ARCH})..."
            if curl -fsSL "$GL_URL" | tar -xz -C "$VENV_DIR/bin" gitleaks 2>/dev/null; then
              ok "gitleaks installed to .venv/bin/gitleaks."
            else
              warn "gitleaks install failed."
              echo -e "  ${DIM}Install manually: https://github.com/gitleaks/gitleaks#install${RESET}"
            fi
          fi
          ;;
      esac
    done
  else
    info "Skipped. You can install them later:"
    echo -e "    ${DIM}pip install semgrep pip-audit${RESET}"
    echo -e "    ${DIM}brew install gitleaks  (or see README for Linux)${RESET}"
  fi
fi

echo ""
read -rp "  Press Enter to continue..."

# ─────────────────────────────────────────────────────────────────────────────
# STEP 8 — Dashboard dependencies
# ─────────────────────────────────────────────────────────────────────────────

header "Step 8 of $TOTAL_STEPS — Dashboard dependencies"
step_label 8 "npm install in dashboard/"
echo ""

if [[ -d "dashboard/node_modules" ]]; then
  ok "node_modules already present."
  if confirm "Run npm install anyway to ensure packages are up to date?"; then
    info "Running npm install ..."
    (cd dashboard && npm install --silent) && ok "npm install complete."
  fi
else
  info "Running npm install ..."
  (cd dashboard && npm install --silent) && ok "npm install complete."
fi

echo ""
read -rp "  Press Enter to see the summary..."

# ─────────────────────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────────────────────

clear
echo ""
echo -e "${GREEN}${BOLD}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║        Setup complete — you're ready!    ║"
echo "  ╚══════════════════════════════════════════╝"
echo -e "${RESET}"
echo ""

echo -e "  ${BOLD}Start the dev stack${RESET}"
echo ""
echo -e "    ${CYAN}./dev.sh${RESET}"
echo ""
echo -e "  ${DIM}This launches the API, ARQ worker, and dashboard together.${RESET}"
echo -e "  ${DIM}Press Ctrl+C to stop everything.${RESET}"
echo ""
rule
echo ""
echo -e "  ${BOLD}URLs${RESET}"
echo ""
echo -e "    Dashboard   ${CYAN}http://localhost:5173${RESET}"
echo -e "    API         ${CYAN}http://localhost:8000${RESET}"
echo -e "    API docs    ${CYAN}http://localhost:8000/docs${RESET}"
echo ""
rule
echo ""
echo -e "  ${BOLD}What to do next${RESET}"
echo ""
echo -e "    ${DIM}1.${RESET}  Run ${CYAN}./dev.sh${RESET} to start the stack"
echo -e "    ${DIM}2.${RESET}  Open the dashboard and log in as ${BOLD}${ADMIN_USER:-admin}${RESET}"
echo -e "    ${DIM}3.${RESET}  Configure GitHub webhook + Ollama in the ${BOLD}Settings${RESET} tab"
echo -e "    ${DIM}4.${RESET}  Push a commit to a connected repo to trigger the first scan"
echo -e "    ${DIM}5.${RESET}  For local webhook testing: ${DIM}ngrok http 8000${RESET}"
echo ""
rule
echo ""
echo -e "  ${BOLD}Key files${RESET}"
echo ""
echo -e "    ${DIM}api/.env${RESET}      — all configuration (edit and restart to apply)"
echo -e "    ${DIM}README.md${RESET}     — full documentation"
echo -e "    ${DIM}dev.sh${RESET}        — starts the dev stack"
echo -e "    ${DIM}.dev-logs/${RESET}    — api, worker, and dashboard logs"
echo ""
echo ""
