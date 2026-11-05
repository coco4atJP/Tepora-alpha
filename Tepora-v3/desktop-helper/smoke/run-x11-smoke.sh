#!/usr/bin/env bash
# X11 + AT-SPI smoke test for tepora-desktop-helper on a virtual display.
# Needs: Xvfb, dbus-daemon (dbus-run-session), at-spi2-core (registryd + accessibility.conf), libgtk-3, gcc, node.
# ATSPI_ROOT may point at an extracted at-spi2-core package instead of /. Usage: dbus-run-session -- ./run-x11-smoke.sh [helper]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); work=$(mktemp -d); root=${ATSPI_ROOT:-}
trap 'kill ${APP:-} ${REG:-} ${BUS:-} ${XVFB:-} 2>/dev/null || true; rm -rf "$work"' EXIT
registryd=$(ls "$root"/usr/libexec/at-spi2-registryd "$root"/usr/lib/at-spi2-core/at-spi2-registryd 2>/dev/null | head -1 || true)
[ -x "$registryd" ] || { echo "at-spi2-registryd not found (install at-spi2-core or set ATSPI_ROOT)"; exit 1; }
gcc -o "$work/gtk-fixture" "$here/gtk-fixture.c" -l:libgtk-3.so.0 -l:libgobject-2.0.so.0
display=:${SMOKE_DISPLAY:-77}
Xvfb "$display" -screen 0 1280x800x24 -nolisten tcp >"$work/xvfb.log" 2>&1 & XVFB=$!
sleep 1
export DISPLAY=$display XDG_SESSION_TYPE=x11; unset WAYLAND_DISPLAY
dbus-daemon --config-file="$root/usr/share/defaults/at-spi2/accessibility.conf" --nofork --print-address=3 3>"$work/bus" >"$work/bus.log" 2>&1 & BUS=$!
for _ in $(seq 50); do [ -s "$work/bus" ] && break; sleep 0.1; done
export AT_SPI_BUS_ADDRESS=$(head -1 "$work/bus")
"$registryd" --use-gnome-session=false >"$work/registry.log" 2>&1 & REG=$!
sleep 0.5
GTK_MODULES= "$work/gtk-fixture" >"$work/app.log" 2>&1 & APP=$!
sleep 2
node "$here/smoke.mjs" "${1:-}" || { echo '--- app log'; cat "$work/app.log"; exit 1; }
