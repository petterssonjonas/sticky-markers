#!/usr/bin/env bash
# Source this file in Codex cloud; ordinary local installations use their normal tools.
if [ -d /workspace/.rustup ]; then
  export RUSTUP_HOME=/workspace/.rustup
  export CARGO_HOME=/workspace/.cargo
  export PATH="/workspace/.cargo/bin:$PATH"
fi
if [ -d /workspace/.sysroot/usr/lib/x86_64-linux-gnu/pkgconfig ]; then
  export PATH="/workspace/.sysroot/usr/bin:$PATH"
  export PKG_CONFIG_PATH="/workspace/.sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:/workspace/.sysroot/usr/share/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  export PKG_CONFIG_SYSROOT_DIR=/workspace/.sysroot
  export LD_LIBRARY_PATH="/workspace/.sysroot/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
if [ -d /workspace/.sysroot/usr/lib/rpm ]; then
  export RPM_CONFIGDIR=/workspace/.sysroot/usr/lib/rpm
fi
export npm_config_cache="${npm_config_cache:-/workspace/.npm}"
