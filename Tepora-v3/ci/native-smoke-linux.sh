#!/usr/bin/env bash
set -euo pipefail
OUT="$PWD/.qa-native"
mkdir -p "$OUT"
DEB=$(find desktop/target/release/bundle -name '*.deb' -print -quit)
test -n "$DEB"
# Exercise the installed package and its resource paths, not the build-tree binary.
sudo apt-get install -y "$PWD/$DEB"
PACKAGE=$(dpkg-deb -f "$DEB" Package)
EXE=$(dpkg -L "$PACKAGE" | grep -E '^/usr/bin/tepora-v3$')
test -x "$EXE"
# Never reuse a developer's normal app data, even when this script is run locally.
DATA=$(mktemp -d "${RUNNER_TEMP:-/tmp}/tepora-smoke.XXXXXX")
export XDG_DATA_HOME="$DATA/data" XDG_CONFIG_HOME="$DATA/config" XDG_CACHE_HOME="$DATA/cache"
# Hosted runners have no physical GPU. Do not disable WebKit's sandbox.
export LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
"$EXE" >/dev/null 2>"$OUT/native-stderr.txt" &
PID=$!
trap 'pkill -P "$PID" 2>/dev/null || true; kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true' EXIT
READY=0
for i in $(seq 1 40); do
  sleep 1
  kill -0 "$PID" 2>/dev/null || { echo 'Native app exited before readiness'; exit 1; }
  for CHILD in $(pgrep -P "$PID" || true); do
    for PORT in $(lsof -nP -a -p "$CHILD" -iTCP -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n127\.0\.0\.1://p'); do
      if curl --silent --fail --max-time 2 "http://127.0.0.1:$PORT/health" > "$OUT/health.json"; then
        if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("ok") and d.get("version")==json.load(open(sys.argv[2]))["version"]' "$OUT/health.json" package.json; then READY=1; break; fi
      fi
    done
    test "$READY" = 1 && break
  done
  test "$READY" = 1 && break
done
test "$READY" = 1 || { echo 'Bundled service never became ready'; exit 1; }
sleep 25
kill -0 "$PID"
import -window root "$OUT/desktop.png"
printf '{"source_commit":"%s","platform":"linux-%s","native_alive":true,"service_ready":true,"package":"deb","visual_assertion":"Inspect desktop.png","actual_model_tested":false}\n' "$GITHUB_SHA" "$(uname -m)" > "$OUT/result.json"
echo 'Installed deb startup passed. Inspect the native screen separately; RPM/AppImage launch, model/audio not tested.'
