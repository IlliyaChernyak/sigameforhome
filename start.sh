#!/bin/sh
# Resolve the project directory so launching from another folder still works.
cd "$(dirname "$0")" || exit 1
# Finder starts with a minimal PATH; include common macOS Node installations.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/current/bin:$HOME/.volta/bin:$HOME/.fnm/current/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 20.19+ or 22.12+ is required. Install it from https://nodejs.org.' >&2
  exit 1
fi
exec node scripts/start.js
