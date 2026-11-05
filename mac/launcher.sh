#!/bin/bash
# Steady.app: start Steady in the background (unless it's running) and open its window.
# It stops by itself about 15 minutes after its last window is closed.
# The window is Steady's Safari web app (made once with Safari's File > Add to Dock) if there
# is one, or else a Safari window of its own.
#   --no-browser   only start Steady (the Obsidian and Raycast plugins do this first)
#   --show HASH    open a page: "doc=ID", "doc=ID&at=B.W", or "" for the library
DIR="__DIR__"
URL="http://localhost:8765"
LOG="$HOME/Library/Logs/Steady.log"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
up() { curl -s -o /dev/null --max-time 1 "$URL/api/ping"; }
say() { osascript -e "display notification \"$1\" with title \"Steady\"" >/dev/null 2>&1; }
alert() { osascript -e "display alert \"Steady\" message \"$1\"" >/dev/null 2>&1; }
NO_BROWSER=""; SHOW=""; HASH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-browser) NO_BROWSER=1 ;;
    --show) SHOW=1; HASH="${2#\#}"; shift ;;
  esac
  shift
done
[[ "$HASH" =~ ^(doc=[A-Za-z0-9]+(&at=[0-9]+\.[0-9]+)?)?$ ]] || HASH=""

# The Safari web app made from Steady's page: Safari names it com.apple.Safari.WebApp.<id>.
webapp() {
  local app
  for app in "$HOME/Applications"/*.app /Applications/*.app; do
    grep -qa "com.apple.Safari.WebApp" "$app/Contents/Info.plist" 2>/dev/null || continue
    case "$(basename "$app")" in *Steady*) echo "$app"; return ;; esac
    grep -rqa "localhost:8765" "$app/Contents" 2>/dev/null && { echo "$app"; return; }
  done
}

# No web app: bring forward the Safari tab Steady is in (going to page $1 if $2 is 1),
# or open a new Safari window for it.
safari() {
  osascript - "$1" "$2" "$URL" <<'APPLESCRIPT' >/dev/null 2>&1 || open -a Safari "$1"
on run {u, go, home}
  tell application "Safari"
    repeat with w in windows
      repeat with t in tabs of w
        if (URL of t as text) starts with home then
          if go is "1" then set URL of t to u
          set current tab of w to t
          set index of w to 1
          activate
          return
        end if
      end repeat
    end repeat
    make new document with properties {URL:u}
    activate
  end tell
end run
APPLESCRIPT
}

show() {
  [ -n "$NO_BROWSER" ] && return
  local app; app=$(webapp)
  if [ -n "$app" ]; then
    # The web app can't be sent a link: leave the page with Steady, and the window goes there.
    [ -n "$SHOW" ] && curl -s -o /dev/null -X POST -H "Content-Type: application/json" \
      -d "{\"hash\": \"$HASH\"}" "$URL/api/show"
    open "$app"
  elif [ -n "$SHOW" ]; then
    safari "$URL/#$HASH" 1
  else
    safari "$URL/" 0
  fi
}

# Already running, but started before Steady was last updated? Restart it.
started=$(curl -s --max-time 1 "$URL/api/ping" | sed -n 's/.*"started": *\([0-9]*\).*/\1/p')
if [ -n "$started" ] && [ "$(stat -f %m "$DIR/app.py" "$DIR"/reader/*.py | sort -n | tail -1)" -gt "$started" ]; then
  curl -s -o /dev/null -X POST "$URL/api/quit"
  for i in $(seq 20); do up || break; sleep 0.5; done
fi
if up; then show; exit 0; fi
if [ ! -f "$DIR/app.py" ]; then
  alert "Can't find the Steady folder at $DIR. Run mac/make-app.sh in it to rebuild the app."; exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
  alert "Steady needs uv. Install it in Terminal with:  brew install uv"; exit 1
fi

cd "$DIR" || exit 1
NO_BROWSER=1 STEADY_IDLE_EXIT=15 nohup uv run app.py >"$LOG" 2>&1 &
server=$!
for i in $(seq 1200); do  # up to 10 minutes: the very first start installs Python packages
  sleep 0.5
  if up; then show; exit 0; fi
  if ! kill -0 "$server" 2>/dev/null; then alert "Steady couldn't start. The details are in $LOG"; exit 1; fi
  [ "$i" = 6 ] && say "Starting… (the first time takes a minute or two)"
done
alert "Steady is taking too long to start. The details are in $LOG"
