#!/usr/bin/env bash
# Scoped test permissions for disposable /tmp fixture data, not the shipped manifest.
set -euo pipefail
exec flatpak run --user --filesystem=/tmp \
  --env="STICKY_MARKERS_DATA_DIR=$STICKY_MARKERS_DATA_DIR" \
  --env="XDG_DATA_HOME=$XDG_DATA_HOME" \
  --env="XDG_CONFIG_HOME=$XDG_CONFIG_HOME" \
  --env="XDG_CACHE_HOME=$XDG_CACHE_HOME" \
  --env=WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  dev.stickymarkers.desktop "$@"
