# Release and update workflow

Changes go to `main`. Publishing a GitHub release is a separate, deliberate step. Neither the version helper nor an ordinary push creates a tag or release.

## One-time signing setup

The public updater verification key is embedded in `src-tauri/tauri.conf.json`. The matching private key was generated in this cloud workspace at `.release-keys/updater.key`; it is ignored by Git. Download and retain that file before discarding this workspace. **Keep this key**: replacing it would prevent already installed copies from verifying future updates.

Set repository **Settings → Secrets and variables → Actions → New repository secret**:

- `TAURI_SIGNING_PRIVATE_KEY`: the entire contents of `.release-keys/updater.key`.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: not needed for the initially generated key, whose password is empty. Set this if an encrypted key is used later.

From an authenticated local GitHub CLI, the equivalent command is:

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo petterssonjonas/sticky-markers < .release-keys/updater.key
```

GitHub API access is blocked in this cloud environment, so this secret could not be installed automatically. The release workflow fails clearly if it is absent. It also verifies every updater signature against the application's embedded key before uploading anything, so a mismatched secret cannot publish a working update feed.

Optional repository variable `STICKY_GITHUB_CLIENT_ID` supplies the public GitHub device-flow OAuth ID for notes synchronization. This is unrelated to release signing.

Updater signing is implemented. Apple Developer ID/notarization and Windows Authenticode signing are not configured; these require separate platform credentials. The resulting DMG/EXE may show the OS's unsigned-application prompt.

## When a change is ready for release

1. Update versions together, for example:

   ```sh
   npm run release:version -- 0.1.1
   ```

   Review and commit the changed npm, Cargo, and Tauri version/lock files, then push to `main`. This command does not publish anything.

2. In the repository's Releases page, publish a release with tag **`v0.1.1`** at that reviewed commit. The tag must match the app versions. Draft releases do not trigger builds; publishing does. Stable update checks follow GitHub's latest stable release, excluding prereleases.

3. `.github/workflows/release.yml` builds Linux, Windows x64, and macOS Intel/Apple Silicon packages. After **every build succeeds**, the final job attaches these assets to that existing release:

   - Linux `.AppImage`, `.rpm`, `.deb`, and `.flatpak` (x86_64).
   - macOS `.dmg` and signed `.app.tar.gz` update archives, for x86_64 and aarch64.
   - Windows `.exe` NSIS installer and its update signature (x86_64).
   - `sticky-markers-VERSION-arch-pacman.tar.gz`, plus standalone PKGBUILD and Makefile assets.
   - `sticky-markers-VERSION-source.tar.gz`, created from the exact release tag, including source, lockfiles, and packaging recipes.
   - `latest.json`, updater signatures, and `SHA256SUMS`.

The workflow uploads assets to the release that you published; it never runs `gh release create`. Building takes time. Until `latest.json` has been uploaded, the app may report that an update feed is not available. A failed build does not publish a partial feed; fix the failure and rerun that tag's workflow. Reruns replace assets for the same tag, so avoid rerunning a tag with different source or a different key.

The Linux release runner uses Ubuntu 22.04 for a broader glibc baseline. RPM/DEB still require the distribution's GTK 3, WebKitGTK 4.1, AppIndicator, and D-Bus libraries. The Flatpak stages the app, MCP, WebKit subprocesses, and dependent libraries into the GNOME 49 runtime, relocating WebKit's compiled subprocess path to `/app/lib`; its dependency and native lifecycle checks run before publication. The complete platform/Flatpak workflow has not been run yet; local checks cover Linux native packages and Windows cross-compilation.

## In-app updates

**Settings → Updates** provides manual checks, release notes, download progress, and **Restart and install**. Checks also run five seconds after launch and every six hours while enabled. An available update appears in an in-app notice and the tray menu; closed notes do not quit the scheduler. These notices do not download or install without the user's action.

The endpoint is:

```
https://github.com/petterssonjonas/sticky-markers/releases/latest/download/latest.json
```

The app accepts versioned download URLs from this repository only. Downloads are verified against the embedded public key and the signed version. A signature mismatch, a downgrade, or a failed note-save acknowledgement cancels installation. Downloading runs separately from local note editing. Before installation, every open note must acknowledge that its current text was saved. Normal sync-on-exit settings also apply.

### Linux RPM, DEB, Arch, and AppImage

In-app updates install a verified AppImage under the user's app-data directory, regardless of the original Linux installation format. Version directories and the active pointer are written atomically; the original package and previous images remain available. Subsequent launches through the original launcher redirect to a newer verified user-managed image. If the installed system package is newer, the app uses it instead. Notes, vault registration, settings, and recovery remain in the same data directory.

Updated images run with AppImage's extract-and-run mode, so FUSE is not required for this update path. They still require a compatible Linux architecture/runtime. Restart waits for the old process to exit before initializing the replacement's single-instance handler.

You can alternatively update the native packages through your package manager using downloaded releases. This repository does not publish an APT/DNF/pacman package repository. For an RPM:

```sh
sudo dnf install ./sticky-markers-VERSION-linux-x86_64.rpm
```

On Arch, extract the `arch-pacman` release archive and run `make`, then `make install`, as your normal user. Its PKGBUILD compiles the immutable release source and validates its checksum. The generated package is installed/updated by pacman; the Makefile wraps makepkg rather than modifying system files directly. Arch supports native x86_64/aarch64 builds; portable release AppImage updates are currently published for x86_64.

### Flatpak

Install the downloaded bundle with:

```sh
flatpak install --user ./sticky-markers-VERSION-linux-flatpak-x86_64.flatpak
flatpak run dev.stickymarkers.desktop
```

In-app updates download the signed Flatpak bundle, verify it, and use `flatpak-spawn --host` to install/update the user Flatpak before restarting it. The manifest grants that host integration, network, Secret Service, tray integration, and home-folder access for vaults. It is not a Flathub submission or a public Flatpak update repository. Flatpak keeps its own sandbox app-data directory; switching between Flatpak and a native install does not automatically migrate settings, though both can open the same Markdown folders.

For a host MCP harness, use `flatpak` as the command and `["run", "--user", "--command=sticky-markers-mcp", "dev.stickymarkers.desktop", "--vault", "YOUR_VAULT_ID"]` as its arguments. This runs MCP inside the same sandbox/data directory as the Flatpak desktop.

### macOS and Windows

macOS replaces the installed application using the signed app archive and restarts it. A read-only DMG must first be copied to a writable installation location. Windows downloads the signed EXE installer; the Tauri updater starts the installer after notes are saved, exits, and lets the installer relaunch the app. Default installation is per user; the OS can still request permission for protected installation locations.

## Local package and validation commands

```sh
node scripts/prepare-mcp.mjs
npm run tauri -- build --bundles rpm,deb --config src-tauri/tauri.package.conf.json
```

Outputs are in `target/release/bundle`. These local packages include the verification key and can update from future signed releases, but do not create a GitHub release or need the private signing key to build.

The initial cloud-built x86_64 RPM was tested by extracting its executable and exercising the native note lifecycle. Its executable requires **glibc 2.39 or newer**, in addition to the desktop libraries above. The release workflow builds Linux packages on Ubuntu 22.04 rather than this Debian 13 development machine.

```sh
python3 -m unittest discover -s tests -p '*_test.py'
cargo test --locked -p sticky-core -p sticky-markers-mcp
npm test
npm run test:e2e
```

The release tests check version/tag consistency, required signed targets, asset-name collisions, and checksums. Core tests verify genuine signed bytes/version binding, tampering rejection, downgrade prevention, and that a failed update leaves notes and the active installation untouched. The signing helper verifies all five updater targets before publishing.
