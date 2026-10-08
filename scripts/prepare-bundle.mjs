import { chmodSync, existsSync, readdirSync, rmSync } from "node:fs";
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
    rmSync(join(directory, "bundle"), { recursive: true, force: true });
    for (const name of ["sticky-markers"]) {
      const binary = join(directory, name);
      if (existsSync(binary)) {
        chmodSync(binary, 0o755);
        if (name === "sticky-markers") found = true;
      }
    }
  }
  if (!found) throw new Error("Built desktop executable not found before bundling");
  chmodSync(join(root, "packaging/linux/dev.stickymarkers.desktop.desktop"), 0o644);
  const icons = join(root, "src-tauri/icons");
  for (const name of readdirSync(icons)) chmodSync(join(icons, name), 0o644);
}
