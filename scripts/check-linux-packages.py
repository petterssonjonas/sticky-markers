#!/usr/bin/env python3
"""Check installed modes in the actual RPM/DEB payload, before publication."""
import io
import pathlib
import stat
import subprocess
import sys
import tarfile

REQUIRED = {
    "usr/bin/sticky-markers": 0o755,
    "usr/bin/sticky-markers-mcp": 0o755,
    "usr/share/applications/Sticky Markers.desktop": 0o644,
    "usr/share/icons/hicolor/128x128/apps/sticky-markers.png": 0o644,
}


def verify(package):
    if package.suffix == ".rpm":
        result = subprocess.run(
            ["rpm", "-qp", "--queryformat",
             "[%{FILENAMES}\t%{FILEMODES:octal}\t%{FILEUSERNAME}\t%{FILEGROUPNAME}\n]",
             str(package)], check=True, capture_output=True, text=True,
        )
        files = {}
        for line in result.stdout.splitlines():
            name, mode, user, group = line.split("\t")
            files[name.lstrip("/")] = (stat.S_IMODE(int(mode, 8)), user, group)
    elif package.suffix == ".deb":
        result = subprocess.run(["dpkg-deb", "--fsys-tarfile", str(package)],
                                check=True, capture_output=True)
        with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
            files = {m.name.removeprefix("./"): (m.mode, str(m.uid), str(m.gid))
                     for m in archive.getmembers() if m.isfile()}
    else:
        raise ValueError(f"Expected an RPM or DEB: {package}")
    for name, expected in REQUIRED.items():
        if name not in files:
            raise ValueError(f"{package.name}: missing {name}")
        mode, owner, group = files[name]
        if mode != expected or owner not in ("root", "0") or group not in ("root", "0"):
            raise ValueError(f"{package.name}: {name} has {mode:04o} {owner}:{group}; "
                             f"expected {expected:04o} root:root")
    print(f"Verified {package.name}: executables 0755, desktop/icon 0644, owned by root.")


def main():
    packages = [pathlib.Path(p) for p in sys.argv[1:]]
    if not packages:
        for extension in ("rpm", "deb"):
            matches = list(pathlib.Path(f"target/release/bundle/{extension}").glob(f"*.{extension}"))
            if len(matches) != 1:
                raise ValueError(f"Expected exactly one {extension.upper()} package, found {len(matches)}")
            packages.extend(matches)
    for package in packages:
        verify(package)


if __name__ == "__main__":
    main()
