#!/bin/bash
# Optional components, installed on demand after the core install.
#
#   bash scripts/addons.sh search      SearXNG web search (needs Docker)
#   bash scripts/addons.sh browser     Playwright, for JavaScript-heavy pages
#   bash scripts/addons.sh vision      moondream image descriptions (needs Ollama)
#   bash scripts/addons.sh inspector   trace viewer + knowledge graph UI
#   bash scripts/addons.sh maple       the Maple model (~5GB, Apple Silicon only)
#
# Usually reached through `enio addons`, which lists what is installed.
# These used to be interactive questions inside install.sh; they moved here
# so a first install asks nothing it does not need to, and a capability can
# be added the day it is wanted rather than guessed at on day one.

set -uo pipefail

BOLD=$'\033[1m'; GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[1;31m'; DIM=$'\033[2m'; OFF=$'\033[0m'
say()  { printf '\n%s==>%s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '%sWarning:%s %s\n' "$YELLOW" "$OFF" "$1"; }
die()  { printf '\n%sERROR:%s %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }

AGENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${ENIO_DATA_DIR:-$HOME/.enio}"
ENIO_DIR="${ENIO_DIR:-$DATA_DIR/runtime}"

case "${1:-}" in
  search)
    say "SearXNG web search"
    command -v docker >/dev/null && docker info >/dev/null 2>&1 \
      || die "Docker isn't running. Start Docker Desktop first — or set BRAVE_API_KEY instead of SearXNG."
    ( cd "$AGENT_DIR/searxng" && docker compose up -d >/dev/null 2>&1 ) || die "docker compose failed."
    for _ in $(seq 1 15); do
      sleep 2
      if curl -sf "http://127.0.0.1:8888/search?q=test&format=json" >/dev/null 2>&1; then
        printf '    running on http://127.0.0.1:8888\n'
        if ! grep -q "SEARXNG_URL" "$DATA_DIR/env" 2>/dev/null; then
          echo 'export SEARXNG_URL="http://127.0.0.1:8888"' >> "$DATA_DIR/env"
          printf '    recorded in %s/env — restart enio to pick it up\n' "$DATA_DIR"
        fi
        exit 0
      fi
    done
    die "SearXNG started but isn't answering. Check: docker compose -f searxng/docker-compose.yml logs"
    ;;

  browser)
    say "Playwright (~150MB)"
    ( cd "$AGENT_DIR" && npm install playwright --no-audit --no-fund >/dev/null 2>&1 \
      && npx playwright install chromium ) \
      || die "Playwright install failed."
    printf '    chromium installed — web_fetch_rendered and browse are available after a restart\n'
    ;;

  vision)
    say "Image descriptions (moondream, ~1.7GB, loaded only while in use)"
    command -v ollama >/dev/null && curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 \
      || die "Ollama isn't running. Without it, images fall back to OCR — which needs nothing."
    if curl -s http://127.0.0.1:11434/api/tags | grep -q "moondream"; then
      printf '    moondream already pulled\n'
    else
      ollama pull moondream:v2 || die "Pull failed."
    fi
    ;;

  inspector)
    say "Inspector UI (trace viewer + knowledge graph)"
    [ -d "$AGENT_DIR/ui" ] || die "No ui/ folder in this checkout."
    ( cd "$AGENT_DIR/ui" && npm install --no-audit --no-fund >/dev/null 2>&1 \
      && npm run build >/dev/null 2>&1 ) \
      || die "Inspector build failed."
    printf '    built — open it with: enio inspect\n'
    ;;

  maple)
    say "Maple (~5GB, ternary 20B-A1B — fastest per token, 2k context budget)"
    [ "$(uname -s)/$(uname -m)" = "Darwin/arm64" ] || die "Maple needs Apple Silicon."
    if [ -f "$ENIO_DIR/maple-2bit-mlx/config.json" ]; then
      printf '    Maple weights already present\n'
    else
      ( cd "$ENIO_DIR" && source .venv/bin/activate && \
        hf download deepgrove/maple-2bit-mlx --local-dir maple-2bit-mlx ) \
        || die "Download failed — re-run to resume."
    fi
    printf '    select it from the model picker in the app, or: ENIO_MODEL=maple\n'
    ;;

  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
