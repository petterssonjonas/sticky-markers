#!/usr/bin/env bash
set -euo pipefail
cd /workspace/sticky-markers
source scripts/cloud-env.sh
export XDG_CACHE_HOME=/tmp/sticky-cloud/cache XDG_DATA_HOME=/tmp/sticky-cloud/share XDG_CONFIG_HOME=/tmp/sticky-cloud/config
export STICKY_MARKERS_DATA_DIR=/tmp/sticky-cloud/data
export WEBKIT_DISABLE_DMABUF_RENDERER=1
if [ -z "${DISPLAY:-}" ]; then
  export DISPLAY=:97
  if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    /workspace/.sysroot/usr/bin/Xvfb "$DISPLAY" -screen 0 1280x900x24 -ac -nolisten tcp &
    for attempt in {1..30}; do
      xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
      sleep 0.1
    done
  fi
fi
# WebKit's installed subprocess path must resolve inside this rootless cloud sysroot.
exec dbus-run-session -- /workspace/.sysroot/usr/bin/proot \
  -b /workspace/.sysroot/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1:/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1 \
  npm run desktop
