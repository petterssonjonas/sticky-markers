#!/usr/bin/env bash
# Rootless Debian 13 setup for this cloud workspace. No host package replacement.
set -euo pipefail
cd /workspace/sticky-markers
export RUSTUP_HOME=/workspace/.rustup CARGO_HOME=/workspace/.cargo
export PATH="/workspace/.cargo/bin:$PATH"
if ! command -v rustup >/dev/null; then
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o /tmp/sticky-rustup.sh
  sh /tmp/sticky-rustup.sh -y --profile minimal --no-modify-path
fi
rustup toolchain install 1.99.0 --profile minimal --component rustfmt --component clippy
if [ ! -f /workspace/.sysroot/usr/lib/x86_64-linux-gnu/pkgconfig/webkit2gtk-4.1.pc ] || [ ! -x /workspace/.sysroot/usr/bin/rpm ]; then
  . /etc/os-release
  [ "${VERSION_CODENAME:-}" = trixie ] || { echo 'This rootless setup targets Debian trixie; install Tauri prerequisites for this host.' >&2; exit 1; }
  mkdir -p /workspace/.sysroot/apt/{empty,lists/partial,cache/archives/partial}
  cat > /workspace/.sysroot/apt/sources.list <<'SOURCES'
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian-security trixie-security main
SOURCES
  cat > /workspace/.sysroot/apt/config <<'CONFIG'
Dir::Etc::parts "/workspace/.sysroot/apt/empty";
Dir::Etc::main "/workspace/.sysroot/apt/empty/config";
Dir::Etc::sourcelist "/workspace/.sysroot/apt/sources.list";
Dir::Etc::sourceparts "/workspace/.sysroot/apt/empty";
Dir::State::lists "/workspace/.sysroot/apt/lists";
Dir::Cache::archives "/workspace/.sysroot/apt/cache/archives";
APT::Update::Post-Invoke {};
DPkg::Post-Invoke {};
CONFIG
  export APT_CONFIG=/workspace/.sysroot/apt/config
  apt-get -o Debug::NoLocking=1 update
  apt-get --download-only -o Debug::NoLocking=1 -y install libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libdbus-1-dev patchelf libfuse2t64 rpm xvfb dbus-x11 proot xdotool
  for package in /workspace/.sysroot/apt/cache/archives/*.deb; do
    dpkg-deb -x "$package" /workspace/.sysroot
  done
  # APT omits dependencies already installed on the host; retain those trusted targets.
  python3 - <<'PY'
from pathlib import Path
root = Path('/workspace/.sysroot')
for p in (root / 'usr').rglob('*'):
    if p.is_symlink() and not p.exists():
        resolved = p.resolve(strict=False)
        targets = [Path('/usr') / p.relative_to(root / 'usr')]
        if resolved.is_relative_to(root):
            targets.insert(0, Path('/') / resolved.relative_to(root))
        for target in targets:
            if target.exists():
                p.unlink(); p.symlink_to(target.resolve()); break
PY
fi
source scripts/cloud-env.sh
npm ci --cache /workspace/.npm
cargo fetch --locked
npm run check
cargo test --locked -p sticky-core
cargo check --locked -p sticky-markers
