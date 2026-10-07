#!/usr/bin/env python3
"""Verify every manifest target with the app's pinned public key before publishing."""
import json, pathlib, subprocess, sys, urllib.parse
root=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else 'release-assets')
manifest=json.loads((root/'latest.json').read_text())
for target,info in manifest['platforms'].items():
    name=urllib.parse.unquote(urllib.parse.urlparse(info['url']).path.rsplit('/',1)[1])
    if (root/(name+'.sig')).read_text().strip()!=info['signature']:raise SystemExit(f'Signature mismatch for {target}')
    subprocess.run(['target/release/examples/verify-update',str(root/name),str(root/(name+'.sig')),manifest['version']],check=True)
