#!/bin/bash
# One-shot installer for enio and everything it needs.
#
#   bash install.sh              interactive, asks about optional components
#   bash install.sh --yes        accept all defaults, no prompts
#   bash install.sh --minimal    core only: model + agent, no search/browser/desktop
#
# Idempotent: every step checks before doing work, so re-running after a failure
# picks up where it stopped rather than starting over.

set -uo pipefail

ASSUME_YES=0
MINIMAL=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)  ASSUME_YES=1 ;;
    --minimal) MINIMAL=1 ;;
    --help|-h)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

BOLD=$'\033[1m'; GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[1;31m'; DIM=$'\033[2m'; OFF=$'\033[0m'
say()  { printf '\n%s==>%s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '%sWarning:%s %s\n' "$YELLOW" "$OFF" "$1"; }
die()  { printf '\n%sERROR:%s %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }
skip() { printf '%s    already done: %s%s\n' "$DIM" "$1" "$OFF"; }

ask() {
  # ask "question" -> 0 for yes, 1 for no. Defaults to yes.
  [ "$ASSUME_YES" = "1" ] && return 0
  [ "$MINIMAL" = "1" ] && return 1
  local reply
  read -r -p "$(printf '%s?%s %s [Y/n] ' "$BOLD" "$OFF" "$1")" reply </dev/tty
  case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac
}

AGENT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${ENIO_DATA_DIR:-$HOME/.enio}"
# The runtime (python env + ~5GB of weights) lives OUTSIDE the project, next to
# the database. Keeps the repo small enough to zip, back up and index, and means
# deleting or re-cloning the project doesn't cost a 5GB re-download.
ENIO_DIR="${ENIO_DIR:-$DATA_DIR/runtime}"
WORKSPACE="${ENIO_WORKSPACE:-$HOME/enio-workspace}"
ENV_FILE="$DATA_DIR/env"

# Earlier layouts, checked so an upgrade never re-downloads.
PREVIOUS_DIRS=("$HOME/.maple-agent/runtime" "$AGENT_DIR/runtime" "$HOME/maple")

FAILED_OPTIONAL=()

printf '\n%senio installer%s\n' "$BOLD" "$OFF"
printf '%sinstalling to: %s%s\n' "$DIM" "$AGENT_DIR" "$OFF"

# ---------------------------------------------------------------- preflight
say "Checking your system"

# enio itself is portable. The Maple RUNTIME is not -- MLX is Apple-only --
# so on other platforms we install the agent and point it at Ollama.
OS="$(uname -s)"
ARCH="$(uname -m)"
CAN_RUN_MAPLE=0

case "$OS" in
  Darwin)
    if [ "$ARCH" = "arm64" ]; then
      CAN_RUN_MAPLE=1
      CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "Apple Silicon")
      MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
    else
      CHIP="Intel Mac"
      MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
      warn "Maple needs Apple Silicon; this Mac is Intel. Installing for Ollama instead."
    fi
    FREE_GB=$(df -g "$HOME" | awk 'NR==2 {print $4}')
    ;;
  Linux)
    CHIP=$(grep -m1 "model name" /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed 's/^ *//' || echo "Linux")
    MEM_GB=$(( $(awk "/MemTotal/ {print \$2}" /proc/meminfo) / 1048576 ))
    FREE_GB=$(df -BG "$HOME" | awk "NR==2 {gsub(/G/,\"\",\$4); print \$4}")
    ;;
  MINGW*|MSYS*|CYGWIN*)
    die "Run this under WSL2, or use install.ps1. Git Bash isn't supported."
    ;;
  *)
    warn "Unrecognised OS ($OS). Continuing, but only the Ollama path is likely to work."
    CHIP="$OS"; MEM_GB=16; FREE_GB=99
    ;;
esac

printf '    %s, %s GB RAM\n' "$CHIP" "$MEM_GB"
printf '    %s GB free disk\n' "$FREE_GB"

if [ "$CAN_RUN_MAPLE" = "1" ]; then
  [ "$MEM_GB" -ge 8 ] || warn "The model needs ~7GB at runtime. ${MEM_GB}GB will swap heavily."
  [ "${FREE_GB:-99}" -ge 15 ] || die "Need ~15GB free for the model, found ${FREE_GB}GB."
else
  [ "${FREE_GB:-99}" -ge 2 ] || die "Need ~2GB free, found ${FREE_GB}GB."
fi

command -v git >/dev/null || die "git not found. Install it first$([ "$OS" = "Darwin" ] && echo " (xcode-select --install)")."

if ! command -v node >/dev/null; then
  die "Node.js not found. Install Node 22+ from https://nodejs.org"
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 22 ] || die "Node 22+ required, found $(node --version)."
printf '    node %s\n' "$(node --version)"

# --------------------------------------------------------------------- uv
if [ "$CAN_RUN_MAPLE" = "1" ]; then
say "Python environment manager (uv)"
export PATH="$HOME/.local/bin:$PATH"
if command -v uv >/dev/null; then
  skip "uv $(uv --version 2>/dev/null | awk '{print $2}')"
else
  curl -LsSf https://astral.sh/uv/install.sh | sh || die "uv install failed."
  export PATH="$HOME/.local/bin:$PATH"
  command -v uv >/dev/null || die "uv installed but not on PATH. Open a new terminal and re-run."
fi

# ------------------------------------------------------------------- model
say "Maple model runtime"

mkdir -p "$DATA_DIR"

# Relocate an earlier install rather than downloading 5GB again.
if [ ! -d "$ENIO_DIR/.venv" ]; then
  for prev in "${PREVIOUS_DIRS[@]}"; do
    [ -d "$prev/.venv" ] || continue
    printf '    found an existing runtime at %s\n' "$prev"
    if ask "Move it to $ENIO_DIR? (keeps the weights, no re-download)"; then
      if mv "$prev" "$ENIO_DIR"; then
        printf '    moved\n'
      else
        warn "Move failed; continuing to use $prev."
        ENIO_DIR="$prev"
      fi
    else
      ENIO_DIR="$prev"
      printf '    leaving it where it is\n'
    fi
    break
  done
fi

if [ -d "$ENIO_DIR/.git" ]; then
  skip "mlx-lm-deepgrove at $ENIO_DIR"
  git -C "$ENIO_DIR" pull --ff-only >/dev/null 2>&1 || warn "Could not update the checkout; continuing with what's there."
else
  git clone --depth 1 https://github.com/deepgrove-ai/mlx-lm-deepgrove.git "$ENIO_DIR" \
    || die "Could not clone mlx-lm-deepgrove."
fi

if [ -d "$ENIO_DIR/.venv" ]; then
  skip "python venv"
else
  ( cd "$ENIO_DIR" && uv venv --python 3.12 ) || die "Could not create the Python venv."
fi
( cd "$ENIO_DIR" && uv pip install -e . rich >/dev/null ) || die "Could not install mlx-lm."

say "Model weights (~5GB)"
if [ -f "$ENIO_DIR/maple-2bit-mlx/config.json" ]; then
  skip "weights present"
else
  printf '    downloading — resumable, safe to interrupt\n'
  ( cd "$ENIO_DIR" && source .venv/bin/activate && \
    hf download deepgrove/maple-2bit-mlx --local-dir maple-2bit-mlx ) \
    || die "Weight download failed. Re-run this script to resume."
fi

else
# ------------------------------------------------------- non-Apple path
say "Model backend"
printf '    Maple needs Apple Silicon, so enio will use Ollama here.\n'
printf '    Everything else — memory, specialists, tools, inspector — is unchanged.\n\n'

if command -v ollama >/dev/null; then
  printf '    ollama found\n'
  if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    printf '    ollama is running\n'
    if curl -s http://127.0.0.1:11434/api/tags | grep -q "qwen3"; then
      skip "a qwen3 model is already pulled"
    else
      # Tool calling needs a model trained for it; most small instruct models
      # answer in prose instead of emitting a call, which looks like a bug.
      if ask "Pull qwen3:8b? (~5GB, and it actually supports tool calling)"; then
        ollama pull qwen3:8b || warn "Pull failed; do it yourself later."
      fi
    fi
  else
    warn "ollama is installed but not running. Start it with: ollama serve"
    FAILED_OPTIONAL+=("ollama not running")
  fi
else
  warn "ollama not found. Install it from https://ollama.com, then: ollama pull qwen3:8b"
  FAILED_OPTIONAL+=("ollama missing")
fi
fi

# ------------------------------------------------------------------- agent
say "Agent"
( cd "$AGENT_DIR" && npm install --no-audit --no-fund ) || die "npm install failed."
( cd "$AGENT_DIR" && npm run build ) || die "Build failed."
mkdir -p "$WORKSPACE" "$DATA_DIR"

printf '    running tests\n'
if ( cd "$AGENT_DIR" && npm test >/tmp/enio-test.log 2>&1 ); then
  printf '    %s\n' "$(grep -E '^# (tests|pass)' /tmp/enio-test.log | tr '\n' ' ')"
else
  warn "Some tests failed — see /tmp/enio-test.log. Continuing."
fi

# ------------------------------------------------------ optional: search
say "Optional components"

SEARXNG_ENABLED=0
if ask "Set up SearXNG for web search? (no API key needed, requires Docker)"; then
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    if ( cd "$AGENT_DIR/searxng" && docker compose up -d >/dev/null 2>&1 ); then
      # First boot takes a few seconds before it answers.
      for _ in $(seq 1 15); do
        sleep 2
        if curl -sf "http://127.0.0.1:8888/search?q=test&format=json" >/dev/null 2>&1; then
          SEARXNG_ENABLED=1; break
        fi
      done
      if [ "$SEARXNG_ENABLED" = "1" ]; then
        printf '    running on http://127.0.0.1:8888\n'
      else
        warn "SearXNG started but isn't answering yet. Check: docker compose -f searxng/docker-compose.yml logs"
        FAILED_OPTIONAL+=("searxng")
      fi
    else
      warn "docker compose failed."
      FAILED_OPTIONAL+=("searxng")
    fi
  else
    warn "Docker isn't running. Start Docker Desktop and re-run, or set BRAVE_API_KEY instead."
    FAILED_OPTIONAL+=("searxng")
  fi
fi

# ----------------------------------------------------- optional: browser
if ask "Install Playwright for JavaScript-heavy pages? (~150MB)"; then
  if ( cd "$AGENT_DIR" && npm install playwright --no-audit --no-fund >/dev/null 2>&1 \
       && npx playwright install chromium >/dev/null 2>&1 ); then
    printf '    chromium installed\n'
  else
    warn "Playwright install failed; web_fetch_rendered will be unavailable."
    FAILED_OPTIONAL+=("playwright")
  fi
fi

# ------------------------------------------------------ optional: skills
if [ -d "$AGENT_DIR/examples/skills" ] && ask "Install the example skills? (commit messages, weekly review, research)"; then
  ( cd "$AGENT_DIR" && node dist/index.js skills --install-examples ) \
    || warn "Could not install example skills."
fi

# ---------------------------------------------------- optional: inspector
if [ -d "$AGENT_DIR/ui" ] && ask "Build the inspector UI? (trace viewer + knowledge graph)"; then
  if ( cd "$AGENT_DIR/ui" && npm install --no-audit --no-fund >/dev/null 2>&1 \
       && npm run build >/dev/null 2>&1 ); then
    printf '    built — open it with: node dist/index.js inspect\n'
  else
    warn "Inspector build failed; 'enio inspect' will not work."
    FAILED_OPTIONAL+=("inspector")
  fi
fi

# ----------------------------------------------------- optional: desktop
DESKTOP_READY=0
if [ -d "$AGENT_DIR/desktop" ] && ask "Set up the desktop app?"; then
  if ( cd "$AGENT_DIR/desktop" && npm install --no-audit --no-fund >/dev/null 2>&1 ); then
    DESKTOP_READY=1
    printf '    ready — launch with: cd desktop && npm start\n'
  else
    warn "Desktop dependencies failed to install."
    FAILED_OPTIONAL+=("desktop")
  fi
fi

# --------------------------------------------------------------- env file
say "Writing configuration"
{
  echo "# Written by install.sh on $(date '+%Y-%m-%d %H:%M')."
  echo "# Source this, or copy the lines into your shell profile."
  if [ "$CAN_RUN_MAPLE" = "1" ]; then
    echo "export ENIO_DIR=\"$ENIO_DIR\"   # python env + weights, ~5.5GB"
  else
    echo "export ENIO_BACKEND=ollama"
    echo "export ENIO_MODEL=qwen3:8b"
  fi
  echo "export ENIO_WORKSPACE=\"$WORKSPACE\""
  [ "$SEARXNG_ENABLED" = "1" ] && echo 'export SEARXNG_URL="http://127.0.0.1:8888"'
  echo "# export ENIO_BACKEND=ollama    # to use Ollama instead of Maple"
  echo "# export ENIO_ROUTING=0         # to disable specialist routing"
} > "$ENV_FILE"
printf '    %s\n' "$ENV_FILE"

# ------------------------------------------------------------------ finish
printf '\n%s────────────────────────────────────────────────%s\n' "$DIM" "$OFF"
say "Installed."

if [ ${#FAILED_OPTIONAL[@]} -gt 0 ]; then
  warn "These optional parts didn't install: ${FAILED_OPTIONAL[*]}"
  printf '    Everything else works. Re-run this script to retry them.\n'
fi

if [ "$CAN_RUN_MAPLE" = "1" ]; then
cat <<EOF

${BOLD}Start it${OFF}

    cd $AGENT_DIR
    node dist/index.js start       ${DIM}# starts the model, then opens chat${OFF}
EOF
else
cat <<EOF

${BOLD}Start it${OFF}

    ollama serve &                 ${DIM}# if it isn't already running${OFF}
    cd $AGENT_DIR
    source $ENV_FILE
    node dist/index.js chat        ${DIM}# 'start' is for the Maple runtime only${OFF}
EOF
fi

[ "$DESKTOP_READY" = "1" ] && cat <<EOF
${DIM}or the desktop app, which does the same with a window:${OFF}
    cd $AGENT_DIR/desktop && npm start
EOF

cat <<EOF

${BOLD}Worth knowing${OFF}

    /good in chat saves an answer as an example to imitate later
    /pref "be concise" sets a standing instruction
    enio skills      teach it how you like things done
    enio inspect     see why it did what it did, and prune bad memories
    enio backends    switch to Ollama or another engine
    enio stats       see what it has remembered
    enio --help      everything else

EOF

# ------------------------------------------------------------- launch now
if [ "$ASSUME_YES" != "1" ] && [ "$MINIMAL" != "1" ]; then
  LAUNCH_CHOICE=""
  if [ "$DESKTOP_READY" = "1" ]; then
    printf '%s?%s Start it now? [d]esktop app / [t]erminal / [n]o: ' "$BOLD" "$OFF"
    read -r LAUNCH_CHOICE </dev/tty
  else
    printf '%s?%s Start it now in this terminal? [Y/n] ' "$BOLD" "$OFF"
    read -r LAUNCH_CHOICE </dev/tty
    case "$LAUNCH_CHOICE" in [nN]*) LAUNCH_CHOICE="n" ;; *) LAUNCH_CHOICE="t" ;; esac
  fi

  case "$LAUNCH_CHOICE" in
    d|D)
      printf '\n'
      # exec replaces this shell, so the app owns the terminal and ctrl-C
      # reaches it directly rather than killing the installer around it.
      cd "$AGENT_DIR/desktop" && exec npm start
      ;;
    t|T)
      printf '\n'
      cd "$AGENT_DIR" && exec node dist/index.js start
      ;;
    *)
      printf '%sNot started. Run it whenever you like.%s\n\n' "$DIM" "$OFF"
      ;;
  esac
fi
