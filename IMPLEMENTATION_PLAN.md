# Sticky Markers implementation plan

Status: implemented first desktop version in this workspace. See README.md for current behavior, run/build commands, verification, and limitations. The design below records the agreed direction; it is not a claim that every proposed scaling or platform validation step is complete.

Implemented: Tauri/Rust/React, Markdown folder vaults, separate styled note windows, safe shared saves and recovery, local stdio MCP, app-managed private GitHub API synchronization, platform menu adapters, Linux installer, and CI matrix. GitHub live sign-in requires an OAuth device-flow client ID; macOS/Windows native runtime validation and platform code-signing/notarization remain outstanding. Signed in-app updates and multi-format release automation are implemented; see RELEASE.md for the one-time signing secret setup. Periodic scans replace the proposed watcher/index for this version; virtualization, attachment insertion, and broader Obsidian-specific rendering are follow-up work. The GitHub implementation uses the Git Data API without a local Git checkout and resolves whole-file conflicts explicitly.

## Product

A simple, local desktop sticky-notes app for Linux, macOS, and Windows. Each note is an ordinary Markdown file displayed in an independent, resizable, styled window. An optional main window browses the selected folder or Obsidian vault. Users can register several folders and switch between them. The primary interaction is opening a note and immediately typing, with Markdown rendering available when wanted. MCP lets compatible harnesses create and edit the same files, including text dictated through a harness that supports speech.

References: [Sticky](https://github.com/vixalien/sticky) for the note/collection model and [Markpad](https://github.com/sftwrdotdev/Markpad) for Markdown editing and rendering. These are product references, not a requirement to copy their implementation or every feature.

## Proposed stack and rationale

- Tauri 2: native windows, application lifecycle, menus, and OS integration, using the system webview rather than bundling Chromium.
- A small Rust notes-core library: file operations, revision checks, recovery, folder registration, and shared write coordination. Both the desktop backend and MCP executable use this library; neither implements its own saving rules. A separate sync module operates only on explicitly app-managed GitHub vaults.
- React and strict TypeScript: note and collection UI, local UI state, and editor integration. React is chosen to match the user's preference and established ecosystem; Svelte would also work, but is not required.
- Vite: frontend development server and production asset build tool. The installed app loads bundled assets; it requires no Node runtime or web server. No SvelteKit, Next.js, SSR framework, or routing/state-management framework is needed initially.
- CodeMirror 6: source editing, syntax highlighting, non-copyable line-number gutter, selections, undo/redo, and formatting commands.
- A unified/remark/rehype Markdown pipeline with GFM, footnotes, math/KaTeX, syntax highlighting, sanitized HTML, and Mermaid rendering.
- The official Rust MCP SDK (`rmcp`) for the MCP protocol; pin a supported release and enable only needed features.
- Plain Markdown on disk is the source of truth. Small versioned files in OS app-data store settings, registered folders, note appearance, and window state. No database is required initially; a future rebuildable search index must never become authoritative storage.
- A small explicit JSON command/event interface, Rust serde types, and matching TypeScript types. No binding generator initially. Validate external input at runtime and exercise the interface with integration tests. TypeScript types do not validate incoming data at runtime; add generation later only if maintaining the interface becomes burdensome.

No Electron. Local and externally managed vaults require no account; optional GitHub synced vaults require GitHub sign-in. Dependencies and versions will be pinned during implementation. Avoid a general UI component framework initially; use shared accessible controls and CSS. Keep Markdown/editor dependencies that solve real requirements instead of implementing parsers or editors from scratch.

### Alternatives considered

| Option | Benefit | Cost for this app | Recommendation |
| --- | --- | --- | --- |
| Tauri + Rust + React/TypeScript | Familiar web UI, established Markdown libraries, native integration, shared Rust file/MCP core | Two languages, IPC boundary, OS webview differences | Preferred balance for the requested features |
| Tauri + Rust + Svelte/TypeScript | Compact component syntax and good fit for a small UI | Still needs the same Rust core and frontend build; no material saving-safety advantage | Valid alternative, not necessary |
| Wails + Go + React/TypeScript | Avoids Rust; Go handles native/backend work | Still two languages and IPC; verify multiwindow/lifecycle support in the selected stable release before committing | Reasonable if Go is preferred; no clear simplification here |
| Rust-only native UI, such as Slint or egui | One application language, no React toolchain | Rich Markdown editing, Mermaid, accessibility, and polished text behavior need substantial integration work | More custom work for this product |
| Qt + C++/QML | Mature desktop toolkit and native integration | Another UI language/toolchain; rich Markdown and Mermaid may still require a webview | Solid, but not the most direct fit |

Rust is not intrinsically required to build this app, and it does not by itself guarantee data safety. Tauri includes a Rust host; it could contain very little custom Rust if application logic lived in TypeScript. Here the shared desktop/MCP file core is a concrete reason to use Rust. Speed and trust depend on save design, conflict handling, testing, and measured startup/editor behavior. There is no benchmark yet supporting a performance promise.

## Markdown folders, vaults, and sync

- On first launch, choose or create a local folder, select an existing Obsidian vault, or opt into creating a GitHub synced vault. Open existing folders in place: do not import them into a private database or rewrite their contents during discovery.
- Register multiple folders, with one active in the main window. Browse/search `.md` files recursively, retaining subfolder paths. Exclude `.git`, `.obsidian`, and application recovery/temp files from note discovery. Canonicalize roots and avoid duplicate registration of the same folder.
- Switching folders changes the collection and the default target for New Note. Proposed behavior: existing note windows remain open and retain their original folder; a vault label/path makes that association visible. A note's + button creates in that note's folder, while app-level New Note uses the active folder.
- The collection displays all Markdown notes in the active folder, with incremental/background indexing and a virtualized list for large vaults. Opening a note creates or focuses its sticky window; it does not copy the file.
- Create collision-safe filenames, allow explicit naming/renaming, and never rename repeatedly as the user types a title. Respect platform filename restrictions and case sensitivity. Keep full paths available to distinguish duplicate titles. Link rewriting during rename must be scoped and explicit, not an automatic whole-vault rewrite.
- Store note colors, typography, window geometry, recents, and restoration state outside Markdown by default, keyed by registered folder and relative path. Do not inject required frontmatter or alter `.obsidian` settings. App metadata is local to the device initially; portable/synced appearance metadata can be a later option.
- Preserve YAML frontmatter, unknown properties, existing Markdown syntax, and line-ending style. No-op open/render/close must leave bytes unchanged. Support common Obsidian wikilinks, aliases, heading links, and local attachment embeds. Preserve other Obsidian syntax even when rendering support is incomplete, with access to raw source.
- Reuse existing relative attachment paths. Store new attachments within a chosen vault-relative location. Do not move existing attachments or create a separate mandatory attachment store. Treat Obsidian plugin execution, Canvas, Dataview queries, and complete plugin-specific rendering as separate work, not implied by opening a vault.
- An existing folder in a GitHub, GitLab, Codeberg, or other Git repository is externally managed. Sticky Markers edits notes there but never initializes, stages, commits, fetches, pulls, merges, or pushes that repository. Detect repositories at the selected root and in ancestor directories, including `.git` files/worktrees. Read-only discovery is allowed. Do not modify remotes, Git configuration, or `.gitignore` in an externally managed vault.
- Obsidian synchronization is entirely external. The user already configures it through their Obsidian app or CLI; Sticky Markers neither controls nor reimplements it and requires no Obsidian authentication. It only reads/writes the shared Markdown files and observes external changes.
- Optional app-managed GitHub synchronization is a confirmed first-release feature, scoped to dedicated private repositories created through the app. Its workflow is specified below; it must never be enabled automatically for an arbitrary existing repository.
- Observe external creation, editing, rename, deletion, and atomic file replacement. Reload clean buffers; preserve dirty buffers and show a conflict when both local and disk revisions changed. Rescan after missed watcher events and when focus returns. Handle unavailable folders without recreating the vault or saving into a different location.

### Vault ownership and sync modes

| Vault type | Examples | Sticky Markers responsibility |
| --- | --- | --- |
| Local / externally managed | Ordinary folder; existing Obsidian vault; folder within an existing GitHub, GitLab, or Codeberg repository | Read/write Markdown and watch changes. No app-operated remote synchronization or Git mutations. |
| GitHub synced | Dedicated private GitHub repository created through Sticky Markers | Save locally and perform scheduled Git synchronization for this vault only. |

Store the management mode explicitly per vault. The presence of `.git`, a GitHub remote, or the name `sticky-markers` is not authorization to manage a repository. Display the mode in the vault picker/settings. Sync controls are unavailable for externally managed vaults, with a brief explanation that the owner or external tool handles synchronization. Never silently convert an external vault to an app-managed one.

### Creating and configuring a GitHub synced vault

1. The user chooses **Create GitHub synced vault**, signs in to GitHub through a supported desktop authorization flow, and selects a separate local location outside existing Git checkouts. Do not require a developer-installed GitHub CLI or embed an OAuth client secret in the shipped app. Settle the supported authorization flow, required permissions, and distributable Git implementation during the integration prototype; do not assume Git is preinstalled on all desktops.
2. Offer a dedicated **private** repository named `sticky-markers` by default, editable before creation. Show the account, repository name, privacy, and local path before creation. An existing repository with that name is a naming collision, not permission to reuse or overwrite it; ask for a different name or the explicit reconnect flow.
3. Create the private repository and its dedicated local checkout, then register it as GitHub synced. Persist its repository identity and management mode so a later remote/path change cannot silently redirect synchronization. Verify creation/privacy and recover cleanly from partial setup failures without deleting user data or automatically deleting a remote repository.
4. Settings expose the repository name, sync frequency, and **Sync on exit**, plus Sync Now, pause/resume, and visible status. Repository renaming uses an explicit app-managed repository rename action and updates the tracked remote after success; it does not create a replacement repository or switch to an unrelated existing repository. Keep an optional vault display name separate from the actual repository name.
5. Proposed initial defaults: synchronize every five minutes while the app is running, with Sync on exit enabled. These are configurable defaults, not fixed requirements. A manual-only schedule is also available. Sync on exit means explicit application quit, not closing an individual note into the collection.
6. Store authentication in the OS credential store. Never put tokens in notes, remotes containing credentials, logs, or synced app settings. Signing out pauses cloud synchronization and preserves local notes. Separate GitHub account requirements from the app's account-free local workflow.
7. Provide an explicit reconnect flow on another device for a previously app-created private vault. The user chooses the known repository and a fresh local checkout; do not infer ownership or take over arbitrary repositories. This supports recovery and multi-device use without changing the externally managed rule.

### Synchronization behavior and reliability

- Saving is local-first and independent of network availability. Distinguish **Saved locally** from **Synced to GitHub**, with last successful sync time, pending changes, offline/authentication errors, and conflicts visible. Opening and typing in notes must not wait for a GitHub request.
- For an app-managed vault, a sync pass snapshots saved notes/attachments, commits pending changes, fetches the remote, integrates compatible changes, and pushes without force. Track note deletion as well as creation/editing. Avoid empty commits and overlapping sync passes. Stage only the intended vault content; local recovery, credentials, caches, and per-device window state remain outside Git history.
- Coordinate the sync engine with the shared save core and preserve edits made during a sync pass for the next pass. Reconcile changed files with open editors using revision checks. Do not reset or overwrite unsaved/dirty editor state to make a pull succeed. Incoming changes can be prepared in isolated staging before being applied under the appropriate locks; implementation must test the chosen Git strategy before relying on it.
- Preserve both versions on conflict, stop automatic integration/push for that vault, and show a recoverable resolution workflow. Never force-push, silently pick local/remote content, or erase Git history. Retry a non-fast-forward push through a fresh fetch/reconciliation rather than replacing the remote branch.
- Scheduled synchronization runs in the desktop process while the app is running, including with all note windows tucked away. Closing a note does not quit the app. No background daemon or OS scheduler is assumed after the app exits.
- On quit with Sync on exit enabled, flush local writes and attempt sync with a bounded wait. If offline, blocked, or conflicted, state that notes are saved locally and still pending, and offer retry or quit with synchronization deferred. Never hang indefinitely or claim an incomplete upload succeeded. Unexpected termination or OS shutdown cannot guarantee an exit sync; retain pending state for the next launch.
- MCP writes follow the same local persistence rules and become pending changes in an app-managed vault. If the desktop scheduler is running, the normal schedule uploads them. If the desktop app is stopped, MCP saves remain local until the next app launch/sync; running MCP does not silently introduce a second independent Git scheduler. MCP responses must distinguish local save success from remote synchronization.
- Prevent app-managed syncing from operating on a checkout whose identity/location no longer matches its registration or that has been moved inside an unrelated checkout. Pause and explain the mismatch; do not rewrite the user's Git configuration to fix it automatically.

## MCP access

Provide a local `sticky-markers-mcp` executable, using the same Rust notes-core as the desktop app. Recommended initial transport is stdio: a harness launches it directly, with no listening network port or separate always-running service. It works without any GUI window open, including when the desktop app is not running. Multiple MCP clients and the GUI must follow the same locking/revision rules.

Initial tools:

| Tool | Behavior |
| --- | --- |
| `list_vaults` | Return registered vault IDs/names that this MCP instance is allowed to access |
| `list_notes`, `search_notes` | Find notes within an explicit vault, with pagination and limits |
| `read_note` | Return Markdown and a revision token |
| `create_note` | Create a new Markdown file without overwriting an existing path |
| `update_note` | Replace contents only if the required expected revision still matches |
| `append_note` | Append text using revision checking and a request ID to prevent duplicate appends on retry |

Return the saved vault-relative path and new revision only after a successful write. Read-before-edit and revision conflicts let a harness reread/reconcile instead of overwriting a newer edit. Bound and persist mutation request IDs long enough to make retries safe after reconnects. Distinguish durable saved text from unsaved GUI buffers; a dirty GUI buffer is never silently replaced by an MCP update.

Configure allowed folders and read/write permissions per MCP connection. MCP cannot register arbitrary directories, escape allowed roots via `..` or symlinks, invoke shell commands, or perform Git pushes through note tools. Deletion is not required for the first MCP tool set. Note contents remain data, not instructions that grant server capabilities. Logs go to stderr; stdout is reserved for protocol messages.

Supply copyable harness configuration and verify negotiation, listing, reading, creation, edits, and errors with a real MCP client. Speech recognition belongs to the harness: dictated text becomes Markdown via create/append/update; no speech engine or model account is required in Sticky Markers.

“Any harness” means any compatible client supporting the shipped transport/protocol. Remote/cloud-only clients cannot necessarily launch a local stdio process. Pending decision: local clients first (recommended), or authenticated Streamable HTTP support in the first release. A remote option needs deliberate hosting/tunneling, authentication/authorization, and connection setup; it must not expose unauthenticated vault access. The shared notes-core permits either transport without a second save implementation.

## Window and launch behavior

Confirmed requirements:

- First launch opens the main window and folder selection; provide a prominent New Note action once a writable folder is selected and an uncluttered empty state.
- Subsequent launches show active note windows without automatically opening the main window.
- Every note has its own native window. A note can be returned to the collection without deleting its contents.
- The main window lists every Markdown note in the selected vault, including those currently open, and opening an already-open note focuses its existing window.
- The main window can be opened from any note. There is only one main window.
- New Note creates a note at the configured size and Edit/View default. Edit mode focuses the editor immediately.
- Preserve each note's content, appearance, mode, and supported window geometry across restarts.
- Cold launch restores active notes. Launching the app while it is already running creates a new note.
- There is no minimize button. Close saves and tucks a note into the collection; that note stays tucked away on subsequent launches. Closing a note does not automatically open the main window.
- The OS dock/taskbar icon's context menu offers Open Main Window and the last five notes.

### Dock/taskbar integration

Interpret “last five” as the five most recently opened or explicitly activated notes across registered vaults, including tucked-away notes, ordered most recent first. Merely typing should not reorder this menu. Exclude deleted/unavailable notes, deduplicate entries, and use the first nonempty content line or filename as the label. Include a vault label where needed to disambiguate. Selecting an entry restores or focuses that note in its original vault; it must not create a blank note through the ordinary relaunch handler. Persist recent-note ordering across restarts.

Use a native Dock menu on macOS and a taskbar Jump List on Windows, adding platform-specific Rust integration where Tauri's shared menu API is insufficient. Investigate desktop launcher actions for supported Linux desktops. Linux has no universal dynamic dock context-menu API, so exact last-five behavior needs a tested desktop target. Proposed fallback: expose the same actions through a tray menu and the main window on unsupported desktops; confirm this tradeoff with the user. Do not silently substitute a tray icon for the requested dock integration on supported systems.

Provisional recovery behavior: if a later launch has no active notes, create a new note so the app always gives visible feedback. Explicit Quit saves and exits while retaining active-note restoration state. Closing the main window does not close active notes. Keep the app available after its last window closes where the OS supports it, with explicit Quit available. A tray/menu-bar menu may additionally provide New Note, All Notes, Settings, and Quit. Access must also work without a tray, especially on Linux. Dock/taskbar activation and app relaunch are not identical on every OS; prototype and document the actual behavior.

Window dragging uses only noninteractive header space. Test resizing, focus, keyboard navigation, and monitor/DPI changes. Restore off-screen windows to a visible display when platform APIs permit. Linux Wayland may restrict exact positioning; support compositor placement gracefully rather than promise identical positioning everywhere.

## Note appearance and controls

Header order, left to right:

```text
[ + ]    draggable space    [ B ][ I ][ U ][ S̶ ] [ ☰ ] [ × ]
```

- The body has one solid note color. The header uses a darker variant of that same color.
- The four formatting buttons are bold, italic, underline, and strikethrough, immediately before the menu/close buttons. No minimize button.
- Provide accessible labels, visible focus, keyboard shortcuts, and sensible minimum window dimensions so controls remain usable.
- The hamburger menu contains, in order: palette/theme selection and 16 circular color swatches; Edit/View switch; font family and size; bullet-list and table insertion; Open Main Window; Delete Note.
- Initial palettes: Classic, Gruvbox, Nord, and Catppuccin. Each supplies 16 curated choices; where a source palette has fewer base colors, derive and document suitable variants.
- Appearance supports System, Light, and Dark. Palette choice and light/dark appearance are separate. Body, header, foreground, links, code, selection, and Mermaid colors must remain readable together.
- Font and size are per-note overrides, with app defaults for future notes. Start with bundled licensed sans-serif, serif, and monospace choices for consistency; add installed-font enumeration only if desired.
- Provisional defaults: 360 × 420 logical pixels, Edit mode, Classic yellow, 16px font, and system appearance. Settings change defaults for new notes without unexpectedly changing existing notes.

The main window is a compact collection with a vault switcher, folder navigation, note previews, search, New Note, restore/focus actions, and Settings. Derive a preview title from the first nonempty content line or filename rather than require naming each note. YAML frontmatter is not a preview title.

## Editing and Markdown

Edit mode shows raw Markdown with syntax highlighting and a nonselectable line-number gutter. View mode renders the same saved source. Switching modes does not rewrite source and preserves editing position where possible. No split pane is required for the initial release.

Formatting acts on selected text. With no selection, commands prepare the insertion point for new formatted text; toggling off lets typing continue outside the formatting. Preserve editor focus, selection, and useful undo boundaries. Formatting from View mode switches to Edit mode and uses the last edit position rather than mutating rendered HTML.

Bullet insertion uses Markdown list syntax. Table insertion provides a small row/column chooser and inserts an editable Markdown table. Underline uses sanitized `<u>…</u>` because CommonMark/GFM has no underline syntax. Explain this in documentation and preserve it in export.

Define the initial Markdown contract explicitly:

- CommonMark: headings, paragraphs, emphasis, links, images, quotes, lists, fenced/indented code, horizontal rules, and escapes.
- GFM: tables, task lists, strikethrough, and automatic links.
- Extensions: footnotes, highlighted code blocks, inline/display math, and fenced Mermaid diagrams.
- A safe subset of inline HTML, including underline; arbitrary scripts and embedded executable content are not supported.
- External links open in the default browser; document anchors navigate within the note. Source links support an intentional modifier-click gesture so normal editing remains predictable.
- Local images and relative links use defined attachment/import paths; exported Markdown includes referenced local attachments. Ordinary Markdown remains readable outside the app.
- Invalid Mermaid/math presents a contained error with access to the original source; the note remains editable. Bundle renderers for offline use, initialize heavy renderers on demand, and use strict Mermaid security settings.

Common Obsidian wikilinks and attachment embeds are now part of vault compatibility. Full note transclusion, block references, custom callouts, Vim mode, and theme imports are not automatically covered; preserve their source and document the rendering subset. Markdown has no single standard encompassing every application's extensions.

## Save safety and recovery

Autosave after a short idle interval, with visible Saving/Saved/Error/Conflict status. Record unsaved work in an app-data recovery journal; do not claim an unacknowledged edit was saved. Flush pending edits before closing a note or quitting; if saving fails, retain the buffer and show the failure. Sudden termination must offer recovery for journaled edits. Avoid UI-blocking filesystem operations and expensive full-vault rescans per keystroke.

The shared Rust core serializes writes per canonical note and uses cross-process locks for desktop/MCP processes. Read and verify a content revision before replacing a file; stale GUI/MCP edits must not silently win. Write a temporary file beside the target, flush it, and replace using a tested platform-appropriate atomic operation, preserving relevant permissions. Verify behavior on supported local filesystems; synced/network folders may have weaker guarantees. A file watcher alone is not conflict prevention.

Obsidian, Git, and sync clients do not honor our locks. Revision checks cannot provide a universal atomic compare-and-swap against arbitrary external writers. Keep bounded recovery versions outside the vault, retain local and observed external revisions on conflict, revalidate after writes, and surface conflicts instead of claiming simultaneous edits can never be lost. Detect Git conflict markers and avoid overwriting conflicted content during automatic saves. Test race windows, not just sequential edits.

Model a note as a vault plus relative path, independently of its window. Track app-initiated renames explicitly. Handle external rename uncertainty conservatively rather than attach one note's metadata to an unrelated file. Keep versioned app settings/restoration state separate from user Markdown. Coordinate changes through typed events and filesystem observation so the collection and open windows agree.

Delete moves the file to OS trash where supported, with confirmation; provide a recoverable fallback rather than silently switching to permanent deletion. External deletion while a dirty buffer is open offers recovery/save-as without silently resurrecting the file. Recovery retention is bounded and configurable, and failures to save or retain a backup are visible. Git history is useful additional protection, but uncommitted edits require local recovery too.

No proprietary note format or required database. Opening a note makes no edits until the user changes content. Existing frontmatter and unsupported syntax survive edits; rendering must never normalize source on disk. Plain Markdown import/export remains useful for copying notes between locations, while ordinary vault use needs no import/export step.

Initial scope includes optional synchronization to dedicated app-managed private GitHub repositories. It excludes controlling Obsidian Sync, operating Git in externally managed vaults, an independent hosted sync backend, real-time collaboration, automatic login startup, and always-on-top behavior. Remote MCP remains a pending choice above.

## Implementation sequence

1. **Prepare the foundation.** Confirm the MCP transport and remaining platform tradeoffs, initialize Tauri/React/TypeScript/Rust, pin tools, establish a small typed command interface and shared notes-core, and document development commands. Prototype GitHub desktop authorization and Git packaging for the managed-vault workflow. Revisit cloud setup with the actual Tauri Linux dependencies once manifests exist.
2. **Prove the desktop lifecycle.** Build a minimal main window and independent note windows. Verify create/focus, launch/relaunch, close-to-collection, dock/taskbar recent-note menus, tray fallback, resizing, and restart restoration. Exercise OS-specific behavior on Linux, macOS, and Windows before committing to it.
3. **Build durable vault access.** Implement ordinary Markdown files, multiple registered folders, recursive browsing/search, file watching, revision checks, autosave, atomic replacement, settings, recovery, and recoverable deletion. Test concurrent external edits, pending edits during close/quit, and save failures before polishing the UI.
4. **Build the note UI and editor.** Implement the exact header/menu arrangement, CodeMirror, formatting, lists/tables, typography, colors, palettes, appearance modes, and spawn defaults.
5. **Add rendering and Obsidian compatibility.** Implement the specified Markdown dialect, Mermaid, math, links, attachments, core Obsidian links/embeds, source preservation, import/export, and Edit/View transitions. Verify behavior in an existing vault and a Git-tracked folder.
6. **Add managed GitHub synchronization.** Implement explicit vault ownership, GitHub sign-in, private repository creation/reconnect, repository naming/renaming, scheduled/manual/exit sync, status, and offline/conflict recovery. Verify externally managed repositories cannot reach Git mutation or remote-sync code paths.
7. **Add MCP.** Ship the Rust MCP executable over the chosen transport, using the shared file core, scoped vault access, revision checks, and retry protection. Test dictated-text capture through a capable harness when available, concurrent GUI/MCP edits, and managed-vault pending-sync behavior. Add remote hosting only if selected, with explicit additional acceptance checks.
8. **Verify and package.** Finish accessibility and platform smoke checks; produce Linux AppImage/deb, macOS dmg (Intel and Apple Silicon), and Windows installer builds using native CI runners. Include the headless MCP executable and document stable installation/configuration paths. Treat signing/notarization credentials and GitHub authorization-app registration as distribution prerequisites, separate from local note development. Do not publish releases as part of this planning task.

Each stage should deliver a usable increment and verify its behavior before the next stage. Implementation is intended for GPT-6.1 Sol at Medium reasoning after plan review; model selection must be made through the host's supported model controls.

## Acceptance and validation

- Rust tests cover exact file round trips, metadata migrations, note state transitions, stale-write prevention, lock behavior across processes, interrupted replacement, read-only/full-disk errors, and recovery after forced termination.
- Vault integration tests cover recursive browsing, switching without moving files, duplicate names, external edits/renames/deletes, sync-style atomic replacement, missed watcher events, unavailable folders, and frontmatter/line-ending preservation. No-op open/close produces no Git diff and does not alter `.obsidian`.
- Ownership tests cover vaults at repository roots and inside ancestor repositories, Git worktrees, and GitHub/GitLab/Codeberg remotes. Assert that externally managed vaults cause no Git mutations or sync network operations during opening, editing, scheduling, manual-sync attempts, or quitting. Existing Git configuration and history remain unchanged.
- Managed-sync tests cover private repository creation, name collisions, partial setup recovery, rename/reconnect, configurable frequency, pause/resume, exit sync enabled/disabled, offline/authentication failures, pending changes after restart, and two-device non-fast-forward/conflict scenarios. Verify private visibility, local-save/remote-sync status accuracy, and no force-push or discarded edits. Use isolated fixtures and a designated test repository for authorized live GitHub checks.
- Concurrent-edit tests include two MCP clients, the GUI, and a simulated external writer; preserve conflicting versions and reject stale updates. Verify request retries do not duplicate dictated notes or appended paragraphs.
- MCP tests use a real client to initialize, list, read, create, update, and append with the GUI both running and stopped. Check allowed-vault enforcement, path/symlink escapes, error reporting, and compatibility with the selected transports. Remote authentication and authorization tests are required if HTTP is selected.
- Editor tests exercise selection and insertion formatting, undo/redo, lists/tables, and source preservation across Edit/View transitions.
- A Markdown fixture covers every promised syntax, including invalid diagrams, unsafe HTML, links, and offline rendering.
- UI tests cover the collection, settings, per-note appearance, and menu/keyboard interactions. Strict TypeScript checks and Rust format/lint/build checks run in CI.
- Native smoke checks on all three OS families cover first launch, subsequent launch, multiple windows, relaunch while running, last-window behavior, saving and restarting, monitor changes, and installation. Verify dock/taskbar menu ordering, deleted-note removal, and correct routing when the app is running and when it is stopped. Linux checks include X11 and Wayland where available. Browser-only tests cannot establish native-window correctness.
- Test a representative group of simultaneous notes, a large existing vault, and a long note with several diagrams; record cold-launch time, new-note time, resource use, save latency, and typing responsiveness. Render heavy content on demand and index in the background. Set numerical targets after the first desktop prototype instead of inventing memory guarantees.
- A successful review scenario: open an existing Obsidian vault, create two differently styled notes, type and format text, render a table and Mermaid diagram, follow a wikilink, tuck one note away, recover it from the main window, switch vaults, restart, and confirm content/appearance/window states survive. Create and edit a note through MCP with the GUI closed, then open it in both Sticky Markers and Obsidian and inspect a clean, ordinary Markdown Git diff.
- A managed-sync review scenario: sign in, create a private GitHub synced vault, save a note offline, reconnect and sync, restore the vault on a second device, and handle a conflicting edit without data loss. Change sync frequency and Sync on exit, then verify the same app performs no Git synchronization for a separate externally managed vault.

## Planning limitations

The repository contained only README.md and LICENSE at inspection. No application code or dependencies have been changed by this plan. The requested ponytail skill was not present in the available skill catalogs or searched local skill locations; its source/location is needed to apply it. This plan has not been reviewed under that skill. No claim is made that the chat's active model was switched to Astra/High.
