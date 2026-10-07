import { run } from "@tauri-apps/cli";

// Bundler-generated desktop entries must be readable in system installations,
// even when the invoking shell uses a private-file umask such as 077.
if (process.platform !== "win32") process.umask(0o022);
await run(process.argv.slice(2), "npm run tauri --");
