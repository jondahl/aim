#!/bin/sh
# Install aim: curl -fsSL https://raw.githubusercontent.com/jondahl/aim/main/install.sh | sh
# Puts the app in ~/.aim/app and an `aim` command on your PATH. Safe to re-run (it upgrades).
set -eu

REF="${AIM_REF:-main}"
APP="${AIM_HOME:-$HOME/.aim}/app"

fail() { echo "aim install: $*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || fail "needs Node 22 or later (node not found)"
command -v npm >/dev/null 2>&1 || fail "needs npm"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || fail "needs Node 22 or later, found $(node -v)"

tmp="$APP.new.$$"
rm -rf "$tmp"
mkdir -p "$tmp"
src=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)
if [ -n "$src" ] && grep -q '"name": "aim"' "$src/package.json" 2>/dev/null; then
  # Run from a checkout (git clone https://github.com/jondahl/aim && sh aim/install.sh): install that.
  tar -C "$src" --exclude=node_modules --exclude=.git -cf - . | tar -C "$tmp" -xf -
else
  curl -fsSL "https://codeload.github.com/jondahl/aim/tar.gz/$REF" | tar -xz -C "$tmp" --strip-components=1 \
    || fail "could not download jondahl/aim@$REF (if the repo is private: git clone https://github.com/jondahl/aim && sh aim/install.sh)"
fi
(cd "$tmp" && npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null) || fail "npm install failed"
chmod +x "$tmp/bin/aim.js"
rm -rf "$APP"
mv "$tmp" "$APP"

# Link `aim` into the first writable directory that is already on PATH, else ~/.local/bin.
link=""
for d in "$HOME/.local/bin" "$HOME/bin" /usr/local/bin; do
  case ":$PATH:" in *":$d:"*) ;; *) continue ;; esac
  if [ -d "$d" ] && [ -w "$d" ]; then link="$d/aim"; break; fi
done
if [ -z "$link" ]; then link="$HOME/.local/bin/aim"; fi
ln -sf "$APP/bin/aim.js" "$link"
# Hooks call ~/.local/bin/aim, whatever PATH they run with.
mkdir -p "$HOME/.local/bin"
[ "$link" = "$HOME/.local/bin/aim" ] || ln -sf "$APP/bin/aim.js" "$HOME/.local/bin/aim"

echo "aim $(node "$APP/bin/aim.js" --version) installed: $link"
case ":$PATH:" in
  *":$(dirname "$link"):"*) ;;
  *) echo "Note: $(dirname "$link") is not on PATH; run $link directly or add it to PATH." ;;
esac
