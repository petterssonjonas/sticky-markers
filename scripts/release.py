#!/usr/bin/env python3
"""Assemble deterministic release assets and the Tauri update feed. No publishing here."""
import argparse, datetime, hashlib, io, json, pathlib, re, shutil, subprocess, tarfile, urllib.parse
ROOT=pathlib.Path(__file__).resolve().parent.parent
REPOSITORY='petterssonjonas/sticky-markers'

def workspace_version(contents):
    """Read the workspace's quoted version without requiring Python 3.11's tomllib.
    This deliberately reads only our version field, not arbitrary TOML values.
    """
    section=''
    for line in contents.splitlines():
        header=re.fullmatch(r'\s*\[([^\]]+)\]\s*(?:#.*)?',line)
        if header:section=header[1]
        if section=='workspace.package':
            match=re.fullmatch(r'''\s*version\s*=\s*(['"])([^'"]+)\1\s*(?:#.*)?''',line)
            if match:return match[2]
    raise ValueError('Cargo.toml must declare a quoted [workspace.package] version')

def version(tag):
    if not re.fullmatch(r'v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?',tag):raise ValueError('Release tag must be vMAJOR.MINOR.PATCH (optional prerelease suffix)')
    result=tag[1:]
    values=[json.loads((ROOT/'package.json').read_text())['version'],json.loads((ROOT/'src-tauri/tauri.conf.json').read_text())['version'],workspace_version((ROOT/'Cargo.toml').read_text())]
    if any(v!=result for v in values):raise ValueError(f'Tag {tag} differs from application versions {values}; bump versions before publishing the release')
    return result

def artifact_name(v,platform,arch,extension):
    return f'sticky-markers-{v}-{platform}-{arch}.{extension}'

def collect(v,platform,arch,out):
    out.mkdir(parents=True,exist_ok=True)
    patterns={
      'linux':{'deb':'deb/*.deb','rpm':'rpm/*.rpm','AppImage':'appimage/*.AppImage'},
      'darwin':{'dmg':'dmg/*.dmg','app.tar.gz':'macos/*.app.tar.gz'},
      'windows':{'exe':'nsis/*.exe'},
    }[platform]
    for ext,pattern in patterns.items():
        matches=list((ROOT/'target/release/bundle').glob(pattern))
        if len(matches)!=1:raise ValueError(f'Expected one {ext} bundle, found {matches}')
        original=matches[0];destination=out/artifact_name(v,platform,arch,ext)
        shutil.copy2(original,destination)
        signature=pathlib.Path(str(original)+'.sig')
        if ext in ['AppImage','app.tar.gz','exe'] and not signature.is_file():raise ValueError(f'Missing updater signature for {original}')
        if signature.is_file():shutil.copy2(signature,str(destination)+'.sig')

def manifest(v,out,notes=''):
    platforms={}
    for system,arch,ext in [('linux','x86_64','AppImage'),('darwin','x86_64','app.tar.gz'),('darwin','aarch64','app.tar.gz'),('windows','x86_64','exe'),('linux-flatpak','x86_64','flatpak')]:
        name=artifact_name(v,system,arch,ext);asset=out/name;sig=out/(name+'.sig')
        if not asset.is_file() or not sig.is_file():raise ValueError(f'Missing signed release asset: {name}')
        platforms[f'{system}-{arch}']={'signature':sig.read_text().strip(),'url':f'https://github.com/{REPOSITORY}/releases/download/v{v}/{urllib.parse.quote(name)}'}
    return {'version':v,'notes':notes,'pub_date':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),'platforms':platforms}

def source_and_arch(v,out):
    out.mkdir(parents=True,exist_ok=True)
    source=out/f'sticky-markers-{v}-source.tar.gz'
    with source.open('wb') as f:
        subprocess.run(['git','archive','--format=tar.gz',f'--prefix=sticky-markers-{v}/',f'v{v}'],cwd=ROOT,stdout=f,check=True)
    checksum=hashlib.sha256(source.read_bytes()).hexdigest()
    pkgbuild=(ROOT/'packaging/arch/PKGBUILD.in').read_text().replace('@VERSION@',v).replace('@SOURCE_SHA256@',checksum)
    (out/f'sticky-markers-{v}-PKGBUILD').write_text(pkgbuild)
    shutil.copy2(ROOT/'packaging/arch/Makefile',out/f'sticky-markers-{v}-arch-Makefile')
    files={'PKGBUILD':pkgbuild.encode(),'Makefile':(ROOT/'packaging/arch/Makefile').read_bytes(),'sticky-markers.desktop':(ROOT/'packaging/arch/sticky-markers.desktop').read_bytes(),
      'README.txt':b'On Arch Linux, extract this archive and run make, then make install. It builds the immutable release source with makepkg. Runtime dependencies are installed by pacman.\n'}
    with tarfile.open(out/f'sticky-markers-{v}-arch-pacman.tar.gz','w:gz') as archive:
        for name,content in files.items():
            info=tarfile.TarInfo(name);info.size=len(content);info.mode=0o644;info.mtime=0
            archive.addfile(info,io.BytesIO(content))

def checksums(out):
    lines=[]
    for path in sorted(out.iterdir()):
        if path.is_file() and path.name!='SHA256SUMS':lines.append(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}')
    (out/'SHA256SUMS').write_text('\n'.join(lines)+'\n')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['validate','collect','publish-assets']);parser.add_argument('--tag',required=True);parser.add_argument('--platform',choices=['linux','darwin','windows']);parser.add_argument('--arch',choices=['x86_64','aarch64']);parser.add_argument('--out',type=pathlib.Path,default=ROOT/'release-assets');parser.add_argument('--notes-file',type=pathlib.Path)
    args=parser.parse_args();v=version(args.tag)
    if args.action=='validate':print(v)
    elif args.action=='collect':collect(v,args.platform,args.arch,args.out)
    else:
        source_and_arch(v,args.out)
        notes=args.notes_file.read_text() if args.notes_file else ''
        (args.out/'latest.json').write_text(json.dumps(manifest(v,args.out,notes),indent=2)+'\n')
        checksums(args.out)
if __name__=='__main__':main()
