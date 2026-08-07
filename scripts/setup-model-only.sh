#!/bin/bash
# Set up DeepGrove Maple-preview (20B-A1B ternary MoE) on Apple Silicon.
# Idempotent: safe to re-run. Installs into ~/maple by default.
set -euo pipefail

INSTALL_DIR="${MAPLE_DIR:-$HOME/maple}"
REPO="https://github.com/deepgrove-ai/mlx-lm-deepgrove.git"
MODEL="deepgrove/maple-preview-2bit-mlx"

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || die "This only runs on macOS."
[ "$(uname -m)" = "arm64" ]  || die "Apple Silicon required (this Mac reports $(uname -m))."

MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
say "Detected $(sysctl -n machdep.cpu.brand_string), ${MEM_GB} GB RAM"
[ "$MEM_GB" -ge 8 ] || printf '\033[1;33mWarning:\033[0m model needs ~7 GB at runtime; %s GB may swap hard.\n' "$MEM_GB"

FREE_GB=$(df -g "$HOME" | awk 'NR==2 {print $4}')
[ "${FREE_GB:-99}" -ge 12 ] || die "Need ~12 GB free disk, found ${FREE_GB} GB."

command -v git >/dev/null || die "git not found. Run: xcode-select --install"

# --- uv ----------------------------------------------------------------------
export PATH="$HOME/.local/bin:$PATH"
if ! command -v uv >/dev/null; then
  say "Installing uv (Python package manager)"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
command -v uv >/dev/null || die "uv installed but not on PATH. Open a new terminal and re-run."

# --- fork --------------------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating existing checkout at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  say "Cloning mlx-lm-deepgrove into $INSTALL_DIR"
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

say "Building the Python environment (this pulls Python 3.12 if you don't have it)"
[ -d .venv ] || uv venv --python 3.12
uv pip install -e . rich

# shellcheck disable=SC1091
source .venv/bin/activate

# --- weights -----------------------------------------------------------------
if [ -f "$INSTALL_DIR/maple-2bit-mlx/config.json" ]; then
  say "Weights already present, skipping download"
else
  say "Downloading weights (~5 GB) — resumable, ctrl-C and re-run is fine"
  hf download "$MODEL" --local-dir "$INSTALL_DIR/maple-2bit-mlx"
fi

# --- convenience launcher ----------------------------------------------------
cat > "$INSTALL_DIR/chat.sh" <<'LAUNCHER'
#!/bin/bash
# Start a Maple chat session.
cd "$(dirname "$0")"
source .venv/bin/activate
exec python -m mlx_lm chat --model ./maple-2bit-mlx --trust-remote-code \
  --max-tokens -1 --temp 1.0 --top-p 0.95 --flash-head
LAUNCHER
chmod +x "$INSTALL_DIR/chat.sh"

say "Smoke test — generating a haiku"
python -m mlx_lm generate --model ./maple-2bit-mlx --trust-remote-code --flash-head \
  --prompt "Write a haiku about a grove." --temp 1.0 --top-p 0.95 --top-k 20 --max-tokens 400

cat <<EOF

$(say "Done.")
Chat any time with:

    $INSTALL_DIR/chat.sh

Type your message and hit return; ctrl-C to quit. It's a reasoning model, so
expect it to think out loud for a while before the actual answer.
EOF
