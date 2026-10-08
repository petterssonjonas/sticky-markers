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
    config.write_text(json.dumps({'vaults':[{'id':'native','name':'Native smoke','path':str(vault),'github':None,'defaultColor':4}], 'activeVault':'native', 'styles':{'native/First.md':{'open':True,'pinned':True,'pinnedAt':1,'mode':'edit','width':420,'height':440}}, 'settings':{'width':420,'height':440,'mode':'view'}}))
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
        wait_for(lambda: windows('Sticky Markers'), 'cold launch did not show the sidebar')
        main_win = windows('Sticky Markers')[0]
        geometry = subprocess.run([xdotool,'getwindowgeometry','--shell',main_win],capture_output=True,text=True,check=True).stdout
        assert 'WIDTH=300' in geometry, geometry
        if shutil.which('xprop'):
            hints = subprocess.run(['xprop','-id',main_win,'WM_NORMAL_HINTS'],capture_output=True,text=True,check=True).stdout
            assert 'maximum size: 300 by' in hints and 'minimum size: 300 by 400' in hints, hints
        subprocess.run([xdotool,'windowsize',main_win,'300','730'],check=True)
        wait_for(lambda: 'HEIGHT=730' in subprocess.run([xdotool,'getwindowgeometry','--shell',main_win],capture_output=True,text=True).stdout, 'collapsed window could not resize vertically')
        subprocess.run([xdotool,'windowraise',main_win,'windowfocus',main_win,'mousemove','--window',main_win,'245','34','click','1'],check=True)
        wait_for(lambda: 'WIDTH=1120' in subprocess.run([xdotool,'getwindowgeometry','--shell',main_win],capture_output=True,text=True).stdout, 'notes panel did not expand the native window')
        if shutil.which('xprop'):
            hints = subprocess.run(['xprop','-id',main_win,'WM_NORMAL_HINTS'],capture_output=True,text=True,check=True).stdout
            assert 'minimum size: 600 by 400' in hints, hints
            assert 'maximum size: 300 by' not in hints, hints
        subprocess.run([xdotool,'mousemove','--window',main_win,'245','34','click','1'],check=True)
        wait_for(lambda: 'WIDTH=300' in subprocess.run([xdotool,'getwindowgeometry','--shell',main_win],capture_output=True,text=True).stdout, 'notes panel did not collapse the native window')
        time.sleep(2)  # Let GTK/WebKit finish resize and lazy panel mount on Xvfb.
        win = windows('First.md')[0]
        subprocess.run([xdotool,'windowraise',win,'windowfocus',win,'mousemove','--window',win,'130','120','click','1'], check=True)
        time.sleep(.25)  # Wait for WebKit's focus event after crossing webviews.
        subprocess.run([xdotool,'key','ctrl+End','type','--delay','50','--clearmodifiers','Typed into the packaged app.'], check=True)
        subprocess.run([xdotool,'mousemove','--window',win,'402','24','click','1'], check=True)
        wait_for(lambda: 'Typed into the packaged app.' in note.read_text(), 'native edit did not reach Markdown file')
        wait_for(lambda: not json.loads(config.read_text())['styles']['native/First.md']['open'], 'Close did not tuck note')
        time.sleep(.5)
        assert app.poll() is None, 'closing last note quit the app'
        subprocess.run(cmd, env=env, check=True, timeout=15, stdout=log, stderr=log)
        wait_for(lambda: windows('Sticky Markers'), 'repeat launch did not show main window')
        assert not windows('New note'), 'repeat launch created an unwanted note'
        main_win = windows('Sticky Markers')[0]
        subprocess.run([xdotool,'windowraise',main_win,'windowfocus',main_win,'mousemove','--window',main_win,'120','94','click','1'],check=True)
        wait_for(lambda: windows('New note'), 'sidebar New note did not create a draft')
        time.sleep(2)
        assert len(list(vault.iterdir())) == 1, 'blank draft created a vault file'
        draft_win = windows('New note')[0]
        subprocess.run([xdotool,'windowraise',draft_win,'windowfocus',draft_win,'mousemove','--window',draft_win,'402','24','click','1'], check=True)
        wait_for(lambda: not windows('New note'), 'blank draft did not close')
        assert len(list(vault.iterdir())) == 1, 'closing a blank draft created a file'
        subprocess.run(cmd+['--new-note'], env=env, check=True, timeout=15, stdout=log, stderr=log)
        wait_for(lambda: windows('New note'), 'explicit new-note command did not open a draft')
        time.sleep(2)
        draft_win = windows('New note')[0]
        subprocess.run([xdotool,'windowraise',draft_win,'windowfocus',draft_win,'mousemove','--window',draft_win,'130','120','click','1','type','--delay','40','--clearmodifiers','A draft saved safely.'], check=True)
        wait_for(lambda: len(list(vault.glob('*.md'))) == 2, 'typed draft was not saved')
        draft_path = next(p for p in vault.glob('*.md') if p != note)
        assert draft_path.stem == 'A_draft_saved_safely', draft_path
        assert draft_path.read_text() == 'A draft saved safely.'
        style_key = 'native/' + draft_path.name
        subprocess.run([xdotool,'mousemove','--window',draft_win,'43','20','click','1'], check=True)
        wait_for(lambda: json.loads(config.read_text())['styles'][style_key]['pinned'], 'native pin action did not persist')
        assert json.loads(config.read_text())['styles'][style_key]['pinnedAt'] > 0
        assert json.loads(config.read_text())['styles'][style_key]['color'] == 4, 'new note ignored vault default color'
        assert json.loads(config.read_text())['styles']['native/First.md']['color'] == 0, 'vault default changed an existing note'
        subprocess.run([xdotool,'mousemove','--window',draft_win,'43','20','click','1'], check=True)
        wait_for(lambda: not json.loads(config.read_text())['styles'][style_key]['pinned'], 'native unpin action did not persist')
        subprocess.run([xdotool,'mousemove','--window',draft_win,'402','24','click','1'], check=True)
        wait_for(lambda: not windows(draft_path.name), 'saved draft did not close')
        subprocess.run(cmd+['--main'], env=env, check=True, timeout=15, stdout=log, stderr=log)
        wait_for(lambda: windows('Sticky Markers'), 'main menu command did not show collection')
        subprocess.run(cmd+['--open-note','native','First.md'], env=env, check=True, timeout=15, stdout=log, stderr=log)
        wait_for(lambda: windows('First.md'), 'recent-note command did not reopen saved note')
        entry = root/'share/applications/dev.stickymarkers.desktop.desktop'
        wait_for(lambda: entry.exists(), 'desktop actions were not created')
        assert 'Recent0;' in entry.read_text() and '--open-note' in entry.read_text()
        assert 'Name=New Note\n' in entry.read_text() and '--new-note' in entry.read_text()
        wait_for(lambda: 'First' in entry.read_text() and 'A_draft' not in entry.read_text(), 'launcher included an unpinned note')
        assert entry.stat().st_mode & 0o777 == 0o644
        if shutil.which('xprop'):
            identity = subprocess.run(['xprop','-id',windows('First.md')[0],'_GTK_APPLICATION_ID','_NET_WM_ICON'],capture_output=True,text=True,check=True).stdout
            assert 'dev.stickymarkers.desktop' in identity, identity
            assert '_NET_WM_ICON:  not found' not in identity, 'window icon missing'
        # A native window becomes visible before its embedded editor/listeners mount.
        # Synthetic X input must wait for that mount and use a realistic key rate.
        time.sleep(2)
        win=windows('First.md')[0]
        subprocess.run([xdotool,'windowraise',win,'windowfocus',win,'mousemove','--window',win,'130','120','click','1','key','ctrl+End','type','--delay','50','--clearmodifiers',' Last thought before quit.'],check=True)
        subprocess.run([xdotool,'key','ctrl+q'],check=True)
        wait_for(lambda: app.poll() is not None, 'explicit quit did not complete the save handshake')
        assert 'Last thought before quit.' in note.read_text(), 'quit lost the final typed text'
        app=subprocess.Popen(cmd,env=env,stdout=log,stderr=log)
        wait_for(lambda: windows('First.md'), 'saved active note did not restore after quit')
        wait_for(lambda: windows('Sticky Markers'), 'restart did not show main window')
        print('Native smoke passed: sidebar-first main window, repeat-launch routing, active-note restore, packaged editing, save-before-close, stay running with no windows, blank draft cancellation, deferred first save and naming, main/note commands, pinned desktop actions and application identity, flush-before-quit, subsequent restoration.')
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
