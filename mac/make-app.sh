#!/bin/bash
# Builds Steady.app in the Steady folder; drag it to Applications (or the Dock).
# Run this again if you move the Steady folder.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="$DIR/Steady.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$DIR/mac/Steady.icns" "$APP/Contents/Resources/"
sed "s|__DIR__|$DIR|" "$DIR/mac/launcher.sh" > "$APP/Contents/MacOS/Steady"
chmod +x "$APP/Contents/MacOS/Steady"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Steady</string>
  <key>CFBundleDisplayName</key><string>Steady</string>
  <key>CFBundleIdentifier</key><string>local.steady.reader</string>
  <key>CFBundleExecutable</key><string>Steady</string>
  <key>CFBundleIconFile</key><string>Steady</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
echo "Built $APP. Drag it to your Applications folder."
