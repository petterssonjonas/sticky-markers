---
name: write-vault-note
description: Save supplied Markdown text as a .md note in the user's vault directory. Use when asked to save a note for Sticky Markers or an existing Markdown vault.
---

Save the user's Markdown text directly to a file. No running app or special connection is required.

1. Use the vault directory supplied by the user or established in the conversation. If the path is unknown, ask which directory to use.
2. Use the requested filename with a `.md` extension. Otherwise, derive a short filename from the note's first words, at most 20 characters before `.md`; replace spaces with underscores and remove filename separators. Keep the file inside the selected directory. If the name already exists, add a numeric suffix instead of overwriting it, unless the user requested editing that file.
3. Save the supplied Markdown as UTF-8, preserving its text and formatting. Use the harness's file-writing tools; prefer an atomic file replacement when available. For an edit, read the existing file first and preserve unrelated content. Sticky Markers opens text files up to 100 KiB.
4. Verify the saved content and report the file's path. Saving locally does not confirm any external synchronization.
