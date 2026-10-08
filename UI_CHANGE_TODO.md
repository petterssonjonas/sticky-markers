# Library and editor update checklist

- [x] Diagnose library/dropdown lag; cached metadata index, paginated note lists, lazy previews; load only expanded vaults/tabs.
- [x] App launch/relaunch opens main window; start as sidebar; toggle collection panel and native window size.
- [x] Replace vault dropdown and sidebar All/Pinned buttons with expandable configured vaults; compact filename-only note cards.
- [x] New note under logo; bottom Add vault menu: Open folder/vault, Import note(s), Create GitHub synced vault.
- [x] Choose/pin a main vault; all new notes and imports target it; footer shows vault name.
- [x] Ctrl/Cmd and Shift multi-selection; drag notes across vaults; delayed hover expansion; safe moves, collisions and open editors handled.
- [x] Remove decorative copy/spark and right-side headline; tabs/cards just below header divider.
- [x] Remove preview dates/type footers; sort by date (latest first), name, size, type.
- [x] Global Edit/Rendered setting for Markdown windows; keep other text formats in source mode.
- [x] Rendered lists line spacing 1; only selected source line reveals markers, preserving row positions; tables stay rendered.
- [x] Remove normal Saved locally indicator; preserve visible save errors/recovery; footer vault indicator.
- [x] Formatting actions below font controls; individually pin to toolbar; global pinned toolbar preferences.
- [x] Compact Edit/Rendered/font controls to font-size height; green font selector; remove color label and theme chooser.
- [x] Classic only: yellow/orange/pink/red/purple/green/gray/blue, pastel top row and vibrant bottom row; light/dark.
- [x] Regression, performance and native package checks; push main without release; build/installable RPM.

Verification: 27 core Rust tests, 9 editor tests, 27 browser tests and 4 release tests passed. Windows cross-compilation passed. Linux RPM/DEB permissions and packaged native lifecycle checks passed. Browser timing with 2,500 notes: first 80 names in 97 ms, vault menu in 93 ms; these are local fixture measurements, not hardware-independent guarantees.

## Navigation, defaults and fonts follow-up

- [x] Pinned note filename group above all vaults; All/Pinned aggregate every vault.
- [x] Note-specific colors; app default in Settings; optional per-vault defaults with inheritance.
- [x] Vibrant swatches above pastels; no visible theme name.
- [x] Warm grey/brown white light appearance; dark green dark appearance across the main app.
- [x] Remove redundant settings footer, main vault footer, pane vault header and top divider.
- [x] Collapsed width fixed at 300 px; vertical resize retained; expanded pane minimum 300 px.
- [x] Settings in an expandable pane tab; tabs for All, Pinned and every configured vault.
- [x] Newest/Oldest/Name/Size/Type sorting; tighter search/sort controls and legible filename cards.
- [x] Bundle Libron 0.30, Barlow and Noto Sans offline, with licenses; font menu divider before system fonts.
- [x] Browser, core and packaged window checks; push main and produce refreshed RPM.

Follow-up validation includes bundled font loading, global/vault color inheritance and note independence, multi-vault tabs, fixed collapsed width and vertical resize, expanded minimum size, and packaged save/close/quit behavior. RPM package revision: 6.


## Immediate preferences and compact vault controls

- [x] Appearance applies immediately across windows and saves without Save preferences.
- [x] Barlow application/default note font; migrate old Libron defaults once, preserve individual note fonts.
- [x] Padded tabs, swatches and reusable action spacing; aligned vault identities and spaced Main pins.
- [x] Default-color dropdown to the right of each vault, with compact responsive fallback.
- [x] Folder/GitHub icons in vault navigation/settings/tabs; Pin/Settings icons in tabs.
- [x] Remove unmanaged sync claims and Obsidian references from GitHub settings.
- [x] Open/Create vault controls; exclusive folder creation; remove Settings close X.
- [x] Native expanded maximum width supports six preview columns; default Note font/size labels.
- [x] Immediately create new blank files, remove untouched blanks on close/quit, name first content safely.
- [x] Flush-before-close and cross-vault save; preserve pins; reject collisions without overwriting.
- [x] Pinnable Delete action retains confirmation and global toolbar settings.
- [x] Triple-click selects only the clicked source row, excludes newline and next rendered row.
- [x] Final packaged native checks, push main and refreshed RPM revision 7.

Validation: 31 Rust core tests, 9 editor tests, 33 browser tests and 4 release tests passed. The final spacing adjustment passed targeted layout/font/six-column checks. Windows cross-compilation, packaged MCP stdio checks, RPM/DEB payload permissions, and native Linux close/save/blank cleanup/quit/restore checks passed. RPM package revision: 7.


## 0.5 beta

- [x] Restore system app typography; remove bundled font assets; Generic families before System fonts.
- [x] Migrate removed bundled font IDs to sans while retaining user-selected system fonts.
- [x] Persisted global Edit-mode line-number toggle, including already-open notes.
- [x] Separate titled Rename note... window; save before opening, cancel safely, reject collisions.
- [x] Extensionless rename gets .md; explicit formats stay unchanged.
- [x] README screenshot additions deferred at the user's request.
- [x] Validate native rename, packaged MCP and RPM/DEB permissions.
- [x] Publish 0.5 Beta; fix Windows timestamp test handles and Python 3.10 release collection.
- [ ] Fix the Flatpak release failure and verify all published release assets.

Validation: 32 Rust core tests, 9 editor tests, 36 browser tests and 5 release tests passed. Windows cross-compilation passed. The installed Linux package passed separate-window rename with automatic .md extension, save/close/quit/restore checks, MCP stdio checks and RPM/DEB payload permission checks. A sample signature verified against the embedded release public key. Version: 0.5.0; RPM revision: 1.

Release run 37848184716: Windows and both Mac package jobs passed. Linux RPM/DEB/AppImage collection, permissions and native lifecycle passed, but the Flatpak build failed. Asset publication is waiting on that failure's log output; the environment blocks GitHub's log-download endpoints. Only failed jobs have been retried, retaining successful platform artifacts.
