# Sticky Markers

Markdown sticky notes for Linux, macOS, and Windows. Built with Tauri 2, Rust, React, and strict TypeScript. The installed application uses the system webview and bundled assets; it needs neither Electron nor a Node server.

## Using the app

On first launch, choose a folder or an existing Obsidian vault. Register additional folders in the vault picker and switch between them. Notes remain ordinary `.md` files, including subfolders and existing frontmatter. Opening a note creates its own resizable, frameless window.

- **+** creates a note. **Close** saves and tucks it into the collection; **Delete** is a separate, confirmed action.
- The header offers bold, italic, underline, and strikethrough. The note menu includes bullets, a starter table, edit/view mode, fonts, size, export, rename, and the main window.
- Choose from 16 colors in Classic, Gruvbox, Nord, or Catppuccin. Each note has a darker header. Light, dark, and system appearance are available.
- The editor has a separate line-number gutter, undo/redo, Markdown highlighting, and keyboard shortcuts. Rendering supports GFM tables/tasks/footnotes, math, sanitized HTML, highlighted code, Mermaid, wikilinks, heading links, and local image embeds.
- First launch shows the collection. Subsequent launches restore active notes; if all notes were tucked away, a new one opens. Launching the application while it is already running creates a new note.
- The tray menu offers the collection, new note, the last five notes, and Quit. Platform adapters also provide macOS Dock menus, Windows Jump Lists, and Linux desktop actions. Linux launcher support depends on the desktop shell.

`Ctrl/Cmd+N`: new note. `Ctrl/Cmd+S`: save. `Ctrl/Cmd+Q`: save all notes and quit. `Ctrl/Cmd+B/I/U`: formatting. `/` focuses collection search. Source-editor external links open with Ctrl/Cmd-click.

## Files and saving

Local folders and existing Git/Obsidian vaults work without an account. Existing repositories are **externally managed**: the app never stages, commits, pulls, pushes, or changes their Git configuration. Obsidian synchronization remains the user's responsibility.

The Rust core is shared by the desktop application and MCP server. Saves use temporary files, atomic replacement, revision checks, and cross-process locks. Stale edits are rejected and retained in recovery instead of silently replacing newer content. Dirty buffers are journaled while typing. Clean open notes reload external edits; conflicting dirty notes offer a recovery copy and explicit reload.

Settings, window geometry, request receipts, and recovery copies live outside vaults in the OS local application-data folder under `sticky-markers`. **Settings → Open local recovery copies** opens it. There are up to 30 snapshots per note; completed MCP request receipts retain up to 512 requests/32 MiB. Retries beyond this retention window require rereading the note. Delete uses OS Trash, falling back to a recovery copy if Trash is unavailable. Back up your vault using your preferred system; recovery is local and bounded.

`STICKY_MARKERS_DATA_DIR` overrides application-data location for isolated testing. Markdown editing is limited to 10 MiB per file, attachments to 20 MiB. Hidden folders, symlink paths, and unsafe filenames are excluded. Frontmatter and CRLF are preserved; rename does not rewrite other notes' links.

## Optional GitHub synced vaults

Settings can create a dedicated **private** repository, default name `sticky-markers`, in a separate new/empty local folder outside existing repositories. The app uses GitHub's Git Data API; Git need not be installed. Scheduled sync defaults to five minutes, with configurable frequency, pause, manual sync, and sync on explicit app quit. Repository renaming and reconnecting a previously app-created private vault are available.

For a distributable build, register a GitHub OAuth app with **device flow enabled**, then set its public client ID as `STICKY_GITHUB_CLIENT_ID` when building. For development, the same public ID can be entered in Settings. There is no embedded client secret. Device authorization requests `repo` scope, which GitHub requires for this OAuth private-repository flow. Credentials use the OS credential store (Secret Service on Linux, Keychain on macOS, Credential Manager on Windows); there is no plaintext fallback.

Sync verifies repository identity and privacy, compares local and remote revisions against a baseline, and creates non-force commits. Conflicting files retain both versions in local recovery and require an explicit local/remote choice in Settings. A competing remote commit rejects the push rather than overwriting history. Local saving continues without network access. Sync on quit is bounded and offers quitting with upload deferred if unsuccessful.

Sync includes Markdown and PNG/JPEG/GIF/WebP/SVG/PDF attachments; per-device settings and `.obsidian` are not synced. Whole-file conflicts require resolution even when edits affect different lines. The desktop must be running for scheduled uploads. Live GitHub authorization requires the OAuth registration above; mock API tests cover sync behavior, but an account-based end-to-end test has not been run in this workspace.

## MCP

The separate `sticky-markers-mcp` executable provides a **local stdio MCP server**. Register vaults in the desktop first, then copy the configuration and IDs from **Settings → MCP access**. Choose the installed MCP executable's absolute path for your harness:

```json
{
  "mcpServers": {
    "sticky-markers": {
      "command": "/absolute/path/to/sticky-markers-mcp",
      "args": ["--vault", "YOUR_VAULT_ID"]
    }
  }
}
```

Repeat `--vault ID` to grant multiple vaults. No vault access is granted by default. Add `--read-only` for read/search access only. `--data-dir PATH` selects the same application-data directory as an isolated desktop instance.

Tools: `list_vaults`, `list_notes`, `search_notes`, `read_note`, `create_note`, `update_note`, and `append_note`. Writes use unique request IDs; edits and appends require the revision returned by a read. Reusing an ID for different content fails. Confirmation means persisted locally, not uploaded to GitHub. Speech recognition belongs to the harness, which passes its transcription to create/append. This server does not expose unauthenticated HTTP or implement remote MCP hosting.

The MCP executable is bundled beside the installed desktop binary (inside `Contents/MacOS` on macOS). It also builds independently:

```sh
cargo build --locked --release -p sticky-markers-mcp
```

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

This builds the release MCP executable and native installer for the current platform. Outputs are under `target/release/bundle`. For a Linux Debian package only:

```sh
node scripts/prepare-mcp.mjs
npm run tauri -- build --bundles deb --config src-tauri/tauri.package.conf.json
```

Release packaging and signed in-app updates are configured in [RELEASE.md](RELEASE.md). Publishing a matching versioned GitHub release builds AppImage, RPM, DEB, Flatpak, Arch packaging, DMG, EXE, and source archives. Ordinary pushes run CI but do not create releases. The updater signing secret needs the one-time setup described there. Apple notarization and Windows Authenticode signing still require their separate credentials.

## Checks

```sh
npm run check
npm test
npx playwright install chromium
npm run test:e2e
cargo fmt --all --check
cargo test --locked -p sticky-core -p sticky-markers-mcp
cargo clippy --workspace --all-targets -- -D warnings
cargo build --locked -p sticky-markers-mcp
python3 scripts/mcp-smoke.py
```

Set `CHROMIUM_PATH=/usr/bin/chromium` to use an already installed browser. Tests cover concurrent/stale writes, exact byte round trips, interrupted request acknowledgement, scope/path enforcement, protected external repositories, non-force sync, conflict copies, editor formatting, and browser workflows. The extracted Linux installer passed native checks for active-note restoration, typing/save/close, remaining alive with every note closed, repeat-launch creation, main/recent-note commands, and desktop actions. The bundled MCP executable also passed the stdio smoke test. Windows cross-compilation was checked; macOS and Windows native behavior still require their CI and desktop runs.

## Cloud workspace

Source `scripts/cloud-env.sh` to use the tools and Debian libraries installed under `/workspace` without root. `scripts/setup-cloud.sh` recreates the development setup on this Debian cloud host. Linux WebKit subprocesses in that rootless sysroot need the `proot` bind described in `scripts/start-cloud-desktop.sh`; ordinary desktop installations do not need it.

The original design and remaining scaling work are in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Current discovery uses periodic scans rather than a filesystem watcher/index, and the collection grid is not virtualized. Large-vault performance, attachment insertion, full Obsidian plugin rendering, remote MCP transport, and platform code-signing/notarization remain follow-up work.

GPL-3.0-only; see [LICENSE](LICENSE).
