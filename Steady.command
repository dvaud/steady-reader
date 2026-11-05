#!/bin/bash
# Double-click to start Steady. Keep this window open while you read; close it to stop.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

# Already running? Just open it.
if curl -s -o /dev/null --max-time 1 http://localhost:8765/api/voices; then
  open http://localhost:8765
  exit 0
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "Steady needs uv. Install it with:  brew install uv"
  read -r -n 1 -p "Press any key to close."
  exit 1
fi

exec uv run app.py
