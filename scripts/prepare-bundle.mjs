import { chmodSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const target = process.env.TAURI_ENV_TARGET_TRIPLE ?? process.env.STICKY_BUILD_TARGET;
  const profile = process.env.TAURI_ENV_DEBUG === "true" ? "debug" : "release";
  const targetDir = resolve(root, process.env.CARGO_TARGET_DIR ?? "target");
  const directories = [join(targetDir, profile)];
  if (target) directories.push(join(targetDir, target, profile));
  let found = false;
  for (const directory of directories) {
    for (const name of ["sticky-markers", "sticky-markers-mcp"]) {
      const binary = join(directory, name);
      if (existsSync(binary)) {
        chmodSync(binary, 0o755);
        if (name === "sticky-markers") found = true;
      }
    }
  }
  if (!found) throw new Error("Built desktop executable not found before bundling");
  const sidecars = join(root, "src-tauri/binaries");
  if (existsSync(sidecars)) {
    for (const name of readdirSync(sidecars)) {
      if (name.startsWith("sticky-markers-mcp-")) chmodSync(join(sidecars, name), 0o755);
    }
  }
  const icons = join(root, "src-tauri/icons");
  for (const name of readdirSync(icons)) chmodSync(join(icons, name), 0o644);
}
