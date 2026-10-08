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

Verification: 25 core Rust tests, 9 editor tests, 24 browser tests and 4 release tests passed. Windows cross-compilation passed. Linux RPM/DEB permissions and packaged native lifecycle checks passed. Browser timing with 2,500 notes: first 80 names in 97 ms, vault menu in 93 ms; these are local fixture measurements, not hardware-independent guarantees.
