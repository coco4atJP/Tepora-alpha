#!/usr/bin/env bash
set -euo pipefail
# Shared by package CI and the exact-artifact replay workflow.
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev patchelf rpm \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
  gstreamer1.0-libav gstreamer1.0-pulseaudio gstreamer1.0-pipewire \
  xvfb xauth dbus-x11 lsof imagemagick
