#!/bin/bash
# AttendX macOS Background Daemon Installer for Continuous Excel Sync
# This keeps AttendX syncing your Excel sheet 24/7 in the background across reboots.

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
NODE_BIN="$(which node || echo "/usr/local/bin/node")"
PLIST_PATH="$HOME/Library/LaunchAgents/com.attendx.excelsync.plist"
LOG_OUT="$HOME/Library/Logs/attendx_excel_sync.log"
LOG_ERR="$HOME/Library/Logs/attendx_excel_sync_err.log"

echo "Configuring AttendX 24/7 Excel Sync Background Daemon..."
echo "  Project directory : $DIR"
echo "  Node executable   : $NODE_BIN"
echo "  LaunchAgent path  : $PLIST_PATH"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs"

# Unload existing if loaded
launchctl unload "$PLIST_PATH" 2>/dev/null || true

cat <<EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.attendx.excelsync</string>
    <key>WorkingDirectory</key>
    <string>$DIR</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$DIR/scripts/watch_and_sync_excel.cjs</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_OUT</string>
    <key>StandardErrorPath</key>
    <string>$LOG_ERR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH</string>
    </dict>
</dict>
</plist>
EOF

chmod 644 "$PLIST_PATH"
launchctl load -w "$PLIST_PATH"

echo "✓ AttendX Excel Sync Daemon is now installed and RUNNING in the background!"
echo "  Logs: tail -f \"$LOG_OUT\""
echo "  To stop: npm run sync:daemon:stop"
echo "  To check status: npm run sync:daemon:status"
