#!/bin/bash
set -euo pipefail
OUT="$PWD/.qa-native"
MOUNT="$RUNNER_TEMP/tepora-dmg"
APP="$RUNNER_TEMP/TeporaSmoke.app"
mkdir -p "$OUT" "$MOUNT"
DMG=$(find desktop/target/release/bundle -name '*.dmg' -print -quit)
test -n "$DMG"
hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" "$DMG"
SOURCE_APP=$(find "$MOUNT" -maxdepth 1 -name '*.app' -print -quit)
test -n "$SOURCE_APP"
ditto "$SOURCE_APP" "$APP"
hdiutil detach "$MOUNT"
EXE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")
/usr/libexec/PlistBuddy -c 'Print :NSMicrophoneUsageDescription' "$APP/Contents/Info.plist" > "$OUT/microphone-description.txt"
"$APP/Contents/MacOS/$EXE" >/dev/null 2>"$OUT/native-stderr.txt" &
PID=$!
trap 'pkill -P "$PID" 2>/dev/null || true; kill "$PID" 2>/dev/null || true' EXIT
READY=0
for i in $(seq 1 40); do
  sleep 1
  kill -0 "$PID" 2>/dev/null || { echo 'Native app exited before readiness'; exit 1; }
  for CHILD in $(pgrep -P "$PID" || true); do
    for PORT in $(lsof -nP -a -p "$CHILD" -iTCP -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n127\.0\.0\.1://p'); do
      if curl --silent --fail "http://127.0.0.1:$PORT/health" > "$OUT/health.json"; then
        if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("ok")' "$OUT/health.json"; then READY=1; break; fi
      fi
    done
    test "$READY" = 1 && break
  done
  test "$READY" = 1 && break
 done
test "$READY" = 1 || { echo 'Bundled service never became ready'; exit 1; }
sleep 25
kill -0 "$PID"
printf '{"source_commit":"%s","platform":"macos-arm64","native_alive":true,"service_ready":true,"visual_assertion":"Inspect desktop.png","actual_model_tested":false}\n' "$GITHUB_SHA" > "$OUT/result.json"
screencapture -x "$OUT/desktop.png"
echo 'Service startup passed. Inspect the captured native screen separately; model/audio not tested.'
