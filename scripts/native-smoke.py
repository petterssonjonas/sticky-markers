#!/usr/bin/env python3
"""Linux native lifecycle smoke. Run on a disposable X display under dbus-run-session.
Requires xdotool; never touches a user's registered vaults.
"""
import json, os, pathlib, shutil, subprocess, sys, tempfile, time
binary = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
xdotool = shutil.which('xdotool') or '/workspace/.sysroot/usr/bin/xdotool'

def wait_for(check, label):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if check(): return
        time.sleep(.1)
    raise AssertionError(label)

def windows(title):
    r = subprocess.run([xdotool, 'search', '--onlyvisible', '--name', '^' + title + '$'], capture_output=True, text=True)
    return r.stdout.split()

with tempfile.TemporaryDirectory(prefix='sticky-native-smoke-') as tmp:
    root = pathlib.Path(tmp); vault = root/'vault'; vault.mkdir(); data = root/'data'; data.mkdir()
    if binary is None:
        packages = list(pathlib.Path('target/release/bundle/deb').glob('*.deb'))
        if len(packages) != 1: raise RuntimeError('Build a Debian installer first, or pass the installed executable path.')
        subprocess.run(['dpkg-deb','-x',str(packages[0]),str(root/'package')], check=True)
        binary = (root/'package/usr/bin/sticky-markers').resolve()
    note = vault/'First.md'; note.write_text('# Packaged note\n\n')
    config = data/'settings.json'
    config.write_text(json.dumps({'vaults':[{'id':'native','name':'Native smoke','path':str(vault),'github':None}], 'activeVault':'native', 'styles':{'native/First.md':{'open':True,'mode':'edit','width':420,'height':440}}, 'settings':{}}))
    env = os.environ.copy()
    env.update(STICKY_MARKERS_DATA_DIR=str(data), XDG_DATA_HOME=str(root/'share'), XDG_CONFIG_HOME=str(root/'config'), XDG_CACHE_HOME=str(root/'cache'), WEBKIT_DISABLE_DMABUF_RENDERER='1')
    cmd = [str(binary)]
    webkit = pathlib.Path('/workspace/.sysroot/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1')
    if webkit.exists():
        cmd = ['/workspace/.sysroot/usr/bin/proot', '-b', f'{webkit}:/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1'] + cmd
    log = open(root/'native.log','w')
    app = subprocess.Popen(cmd, env=env, stdout=log, stderr=log)
    try:
        wait_for(lambda: windows('First.md'), 'active note did not restore')
        time.sleep(2)  # Let the embedded webview mount CodeMirror before typing.
        assert not windows('Sticky Markers'), 'cold launch unexpectedly opened collection'
        win = windows('First.md')[0]
        subprocess.run([xdotool,'windowfocus',win,'mousemove','--window',win,'130','120','click','1','key','ctrl+End','type','--delay','50','--clearmodifiers','Typed into the packaged app.'], check=True)
        subprocess.run([xdotool,'mousemove','--window',win,'402','24','click','1'], check=True)
        wait_for(lambda: 'Typed into the packaged app.' in note.read_text(), 'native edit did not reach Markdown file')
        wait_for(lambda: not json.loads(config.read_text())['styles']['native/First.md']['open'], 'Close did not tuck note')
        time.sleep(.5)
        assert app.poll() is None, 'closing last note quit the app'
        subprocess.run(cmd, env=env, check=True, timeout=15, stdout=log, stderr=log)
        wait_for(lambda: len(list(vault.glob('*.md')))==2, 'repeat launch did not create exactly one note')
        subprocess.run(cmd+['--main'], env=env, check=True, timeout=15, stdout=log, stderr=log)
        wait_for(lambda: windows('Sticky Markers'), 'main menu command did not show collection')
        subprocess.run(cmd+['--open-note','native','First.md'], env=env, check=True, timeout=15, stdout=log, stderr=log)
        wait_for(lambda: windows('First.md'), 'recent-note command did not reopen saved note')
        entry = root/'share/applications/Sticky Markers.desktop'
        wait_for(lambda: entry.exists(), 'desktop actions were not created')
        assert 'Recent0;' in entry.read_text() and '--open-note' in entry.read_text()
        # A native window becomes visible before its embedded editor/listeners mount.
        # Synthetic X input must wait for that mount and use a realistic key rate.
        time.sleep(2)
        win=windows('First.md')[0]
        subprocess.run([xdotool,'windowfocus',win,'mousemove','--window',win,'130','120','click','1','key','ctrl+End','type','--delay','50','--clearmodifiers',' Last thought before quit.'],check=True)
        subprocess.run([xdotool,'key','ctrl+q'],check=True)
        wait_for(lambda: app.poll() is not None, 'explicit quit did not complete the save handshake')
        assert 'Last thought before quit.' in note.read_text(), 'quit lost the final typed text'
        app=subprocess.Popen(cmd,env=env,stdout=log,stderr=log)
        wait_for(lambda: windows('First.md'), 'saved active note did not restore after quit')
        assert not windows('Sticky Markers'), 'cold launch restored the optional collection'
        print('Native smoke passed: active-note restore, packaged editing, save-before-close, stay running with no windows, repeat-launch creation, main/recent commands, desktop actions, flush-before-quit, subsequent restoration.')
    except Exception:
        log.flush()
        print((root/'native.log').read_text(), file=sys.stderr)
        print('Note after typing:', repr(note.read_text()), file=sys.stderr)
        raise
    finally:
        # Fixture processes only. Terminate the traced app before its proot parent.
        if app.poll() is None:
            if 'proot' in cmd[0]:
                children = pathlib.Path(f'/proc/{app.pid}/task/{app.pid}/children')
                if children.exists():
                    for pid in children.read_text().split():
                        try: os.kill(int(pid), 15)
                        except ProcessLookupError: pass
            else: app.terminate()
            try: app.wait(timeout=5)
            except subprocess.TimeoutExpired: app.kill(); app.wait(timeout=5)
        log.close()
