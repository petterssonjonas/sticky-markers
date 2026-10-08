# Sticky Markers

Markdown sticky notes for Linux, macOS, and Windows. Built with Tauri 2, Rust, React, and strict TypeScript. The installed application uses the system webview and bundled assets; it needs neither Electron nor a Node server.

## Using the app

The main window starts as a compact, fixed-width navigator that can be resized vertically. Its panel button opens the resizable sidebar pane (at least 300 px wide). Use **Add vault → Open folder/vault** to register local folders or existing Obsidian vaults; expand each vault to list its filenames. Notes remain ordinary UTF-8 text files (including `.md`, `.json`, `.toml`, and `.conf`), with subfolders and frontmatter preserved. Opening a note creates its own resizable, frameless desktop window.

- Settings offers **Open a vault…** and **Create a vault…**. Vault rows use a compact default-color dropdown; a GitHub icon identifies folders inside Git repositories without enabling app sync. The expanded window stops at six preview columns.
- Pin one **main vault** with the pin beside its folder. All new notes and imports go there. **Add vault** also offers multi-file import and a separate private GitHub synced vault.
- **New note** sits below the logo. **Close** saves and tucks a note away; **Delete** is a separate, confirmed action. Ctrl/Cmd-click and Shift-click select multiple sidebar notes for dragging into another vault. Hovering over a closed vault opens it after a short delay. Open editors save and close before moving; moves preserve relative paths, reject collisions and keep recovery copies. The note menu also offers **Save to another vault…** when another vault is configured.
- The sidebar panel button opens the larger **All notes / Pinned notes / vault / Settings** tabs. All notes and Pinned notes aggregate the registered vaults, and pinned filenames also have their own expandable group above the vaults. Settings opens inside this pane. Vault filename lists are paged; preview cards and Markdown rendering load on demand. Sort by Newest, Oldest, Name, Size or Type. Search matches filenames, relative paths and note contents; full-text scans run only for a search query and their results are cached.
- Formatting tools live below the font controls in the note menu: bold, italic, underline, strikethrough, bullets, heading levels, inline/fenced code and tables. Each tool and Delete can be pinned to the header; toolbar pins are global. The header keeps New note, note pin, title, menu and Close. Routine save indicators are omitted; save failures remain visible with recovery actions.
- The colors are yellow, orange, pink, red, purple, green, gray and blue: vibrant choices in the top row, pastel versions below. Colors are note-specific; Settings provides an app default and optional per-vault overrides for new notes. Each note has a darker header. Light, dark, and system appearance are available and apply and save immediately.
- Rendered is the editable default. Only selected source rows reveal Markdown markers, retaining compact list geometry; tables stay rendered and their cells are editable. Edit shows entirely raw text with optional line numbers and undo/redo; the global line-number toggle is in Settings. The editor mode is global for Markdown notes; other text formats remain in source mode. The app uses system typography without bundled note-font families. Note-font selectors list Generic families first, then system fonts. Tables/tasks, math, Mermaid, links and images are supported; preview cards use sanitized Markdown rendering.
- New notes create a blank Markdown file immediately. Closing an untouched empty new note removes that file; closing a note always flushes pending edits. The first content save names the file from its first nonempty line (at most 20 characters, spaces become underscores, collisions get a suffix).
- Opening or relaunching the application shows the main window. Cold launch also restores recorded active notes, without scanning the vaults on the native UI thread.
- The tray menu offers the main window, new note, the ten most recently pinned notes, and Quit. Platform adapters also provide macOS Dock menus, Windows Jump Lists, and Linux desktop actions. Linux launcher support depends on the desktop shell.

`Ctrl/Cmd+N`: new note. `Ctrl/Cmd+S`: save. `Ctrl/Cmd+Q`: save all notes and quit. `Ctrl/Cmd+B/I/U`: formatting. `/` focuses library search. Source-editor external links open with Ctrl/Cmd-click.

## Files and saving

Local folders and existing Git/Obsidian vaults work without an account. Existing repositories are **externally managed**: the app never stages, commits, pulls, pushes, or changes their Git configuration. Obsidian synchronization remains the user's responsibility.

The desktop application uses a Rust file core. Saves use temporary files, atomic replacement, revision checks, and cross-process locks. Stale edits are rejected and retained in recovery instead of silently replacing newer content. Dirty buffers are journaled while typing. Clean open notes reload external edits; conflicting dirty notes offer a recovery copy and explicit reload.

Settings, window geometry, and recovery copies live outside vaults in the OS local application-data folder under `sticky-markers`. **Settings → Open local recovery copies** opens it. There are up to 30 snapshots per note. Delete uses OS Trash, falling back to a recovery copy if Trash is unavailable. Back up your vault using your preferred system; recovery is local and bounded.

`STICKY_MARKERS_DATA_DIR` overrides application-data location for isolated testing. UTF-8 text editing is limited to 100 KiB per file, attachments to 20 MiB. Hidden folders, symlink paths, and unsafe filenames are excluded. Frontmatter and CRLF are preserved; rename does not rewrite other notes' links. Renaming opens a separate **Rename note...** window, adds `.md` to names without an extension and preserves explicit extensions.

## Optional GitHub synced vaults

Settings can create a dedicated **private** repository, default name `sticky-markers`, in a separate new/empty local folder outside existing repositories. The app uses GitHub's Git Data API; Git need not be installed. Scheduled sync defaults to five minutes, with configurable frequency, pause, manual sync, and sync on explicit app quit. Repository renaming and reconnecting a previously app-created private vault are available.

For a distributable build, register a GitHub OAuth app with **device flow enabled**, then set its public client ID as `STICKY_GITHUB_CLIENT_ID` when building. For development, the same public ID can be entered in Settings. There is no embedded client secret. Device authorization requests `repo` scope, which GitHub requires for this OAuth private-repository flow. Credentials use the OS credential store (Secret Service on Linux, Keychain on macOS, Credential Manager on Windows); there is no plaintext fallback.

Sync verifies repository identity and privacy, compares local and remote revisions against a baseline, and creates non-force commits. Conflicting files retain both versions in local recovery and require an explicit local/remote choice in Settings. A competing remote commit rejects the push rather than overwriting history. Local saving continues without network access. Sync on quit is bounded and offers quitting with upload deferred if unsuccessful.

Sync includes UTF-8 text notes and PNG/JPEG/GIF/WebP/SVG/PDF attachments; per-device settings and `.obsidian` are not synced. Whole-file conflicts require resolution even when edits affect different lines. The desktop must be running for scheduled uploads. Live GitHub authorization requires the OAuth registration above; mock API tests cover sync behavior, but an account-based end-to-end test has not been run in this workspace.

## Write notes from an assistant

Give your assistant the vault directory and ask it to save your text as a Markdown file there. The app reads the same ordinary files; no app connection or separate service is needed. The [write-vault-note skill](skills/write-vault-note/SKILL.md) contains the complete instructions and can be installed in a harness that supports skills.

## Development and packages

Requirements: Node 24, Rust (the toolchain file pins the version), and [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system. Linux needs GTK 3, WebKitGTK 4.1, Ayatana AppIndicator, librsvg, and D-Bus development packages. Windows needs the Microsoft C++ build tools and WebView2; macOS needs Xcode command-line tools.

```sh
npm ci
npm run desktop
```

`npm run preview:web` exposes the UI demo on all interfaces for cloud preview; it is still a demonstration of the desktop UI.

`npm run dev` runs a **browser UI demo** using sample notes and browser storage; it does not edit files or exercise native lifecycle/sync. Desktop development uses `npm run desktop`.

```sh
npm run package
```

This builds the native installer for the current platform. Outputs are under `target/release/bundle`. For a Linux Debian package only:

```sh
npm run tauri -- build --bundles deb
```

Release packaging and read-only in-app update checks are configured in [RELEASE.md](RELEASE.md). Publishing a matching versioned GitHub release builds AppImage, RPM, DEB, Arch packaging, DMG, EXE, and source archives. Ordinary pushes run CI but do not create releases. Update checks show release notes and a package link; install the same format you originally used. The app does not download or install updates. Release artifact signing needs the one-time setup described there. Apple notarization and Windows Authenticode signing still require their separate credentials.

Use the `npm run tauri --` wrapper for packaging: it sets a packaging umask of `022`, and the pre-bundle hook sets executable modes to `0755` and icon modes to `0644`. Linux CI and release builds inspect the RPM/DEB payloads with `python3 scripts/check-linux-packages.py` so root-owned installations remain accessible to ordinary users.

## Checks

```sh
npm run check
npm test
npx playwright install chromium
npm run test:e2e
cargo fmt --all --check
cargo test --locked -p sticky-core
cargo clippy --workspace --all-targets -- -D warnings
cargo build --locked
```

Set `CHROMIUM_PATH=/usr/bin/chromium` to use an already installed browser. Tests cover concurrent/stale writes, exact byte round trips, interrupted request acknowledgement, scope/path enforcement, protected external repositories, non-force sync, conflict copies, editor formatting, and browser workflows. The extracted Linux installer passed native checks for active-note restoration, typing/save/close, remaining alive with every note closed, repeat-launch main-window activation, main/recent-note commands, and desktop actions. Windows cross-compilation was checked; macOS and Windows native behavior still require their CI and desktop runs.

## Cloud workspace

Source `scripts/cloud-env.sh` to use the tools and Debian libraries installed under `/workspace` without root. `scripts/setup-cloud.sh` recreates the development setup on this Debian cloud host. Linux WebKit subprocesses in that rootless sysroot need the `proot` bind described in `scripts/start-cloud-desktop.sh`; ordinary desktop installations do not need it.

The original design is in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md); the current UI requirements and verification checklist are in [UI_CHANGE_TODO.md](UI_CHANGE_TODO.md). Library discovery uses a cached metadata index with paginated results, small file-prefix checks, and lazy previews. Open lists periodically refresh to detect externally managed changes. Attachment insertion, full Obsidian plugin rendering, platform code-signing/notarization remain follow-up work.

GPL-3.0-only; see [LICENSE](LICENSE).
