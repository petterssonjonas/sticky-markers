#!/usr/bin/env python3
"""Stage the native Debian build and its non-platform libraries for Flatpak.
The GNOME platform supplies libc, graphics drivers, fonts, portals, and the host integration.
Run on the Linux release runner after building the DEB package.
"""
import pathlib, re, shutil, subprocess
root=pathlib.Path(__file__).resolve().parent.parent
payload=root/'packaging/flatpak/payload'
if payload.exists():shutil.rmtree(payload)
payload.mkdir()
packages=list((root/'target/release/bundle/deb').glob('*.deb'))
if len(packages)!=1:raise SystemExit('Expected one Debian installer')
unpacked=root/'target/flatpak-deb'
if unpacked.exists():shutil.rmtree(unpacked)
subprocess.run(['dpkg-deb','-x',str(packages[0]),str(unpacked)],check=True)
shutil.copytree(unpacked/'usr/bin',payload/'bin')
(payload/'share/applications').mkdir(parents=True)
shutil.copy2(unpacked/'usr/share/applications/dev.stickymarkers.desktop.desktop',payload/'share/applications/dev.stickymarkers.desktop.desktop')
icons=payload/'share/icons/hicolor/128x128/apps';icons.mkdir(parents=True)
shutil.copy2(root/'src-tauri/icons/icon.png',icons/'dev.stickymarkers.desktop.png')
p=payload/'share/applications/dev.stickymarkers.desktop.desktop';p.write_text(p.read_text().replace('Icon=sticky-markers','Icon=dev.stickymarkers.desktop'))
meta=payload/'share/metainfo';meta.mkdir()
shutil.copy2(root/'packaging/flatpak/dev.stickymarkers.desktop.metainfo.xml',meta)
licenses=payload/'share/licenses/sticky-markers';licenses.mkdir(parents=True)
shutil.copy2(root/'LICENSE',licenses)
lib=payload/'lib';lib.mkdir()
# WebKitGTK stores subprocesses outside the ELF dependency graph.
webkit=pathlib.Path('/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1')
if not webkit.is_dir():raise SystemExit('WebKitGTK subprocess directory missing')
shutil.copytree(webkit,lib/'webkit2gtk-4.1',symlinks=False)
queue=list((payload/'bin').iterdir())+[p for p in (lib/'webkit2gtk-4.1').rglob('*') if p.is_file()]
# Keep libc and GL/Vulkan/VA drivers supplied by the Flatpak runtime.
platform=re.compile(r'^(ld-linux|lib(c|m|pthread|dl|rt|resolv|util)\.so|lib(GL|EGL|GLX|GLdispatch|OpenGL|vulkan|va)[.-])')
seen=set()
while queue:
    binary=queue.pop()
    result=subprocess.run(['ldd',str(binary)],capture_output=True,text=True)
    for name,path in re.findall(r'^\s*(\S+) => (\/\S+) ',result.stdout,re.M):
        if name in seen or platform.match(name):continue
        seen.add(name)
        target=lib/name;shutil.copy2(path,target);queue.append(target)
        # Preserve the distro copyright/third-party license for every copied library.
        owner=subprocess.run(['dpkg-query','-S',path],capture_output=True,text=True).stdout.split(': ',1)[0].splitlines()
        if owner:
            package=owner[0].split(':')[0]
            copyright=pathlib.Path('/usr/share/doc')/package/'copyright'
            if copyright.exists():shutil.copy2(copyright,licenses/(package+'.copyright'))
print(f'Staged Flatpak payload with {len(seen)} libraries and WebKit subprocesses.')
# Distro WebKit release builds hard-code their subprocess directory (the
# development-only WEBKIT_EXEC_PATH override is unavailable). Relocate that
# exact NUL-terminated string without moving ELF data or disabling sandboxing.
old=b'/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1\0'
new=b'/app/lib/webkit2gtk-4.1\0'; replacement=new+b'\0'*(len(old)-len(new))
patched=0
for path in lib.rglob('*'):
    if not path.is_file():continue
    content=path.read_bytes();count=content.count(old)
    if count:path.write_bytes(content.replace(old,replacement));patched+=count
if not patched:raise SystemExit('Expected WebKit executable path constant not found; review Flatpak relocation for this WebKit version')
print(f'Relocated {patched} WebKit subprocess path constant(s).')
