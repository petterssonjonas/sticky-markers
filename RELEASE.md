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

## In-app update checks

**Settings → Updates** provides manual checks, release notes, and **Open release packages**. Checks also run five seconds after launch and every six hours while enabled. An available release appears in an in-app notice and the tray menu. Every installation format uses this check-only flow: the app does not download installers, install updates, restart to update, or redirect a system installation to a user AppImage.

Checks read version and release-note metadata from:

```
https://github.com/petterssonjonas/sticky-markers/releases/latest/download/latest.json
```

The package link opens this repository's release page for that version. Install the same package format you originally used, or use your existing package manager. Release artifact signing and verification remain part of publishing; they are independent of these read-only checks.

### Linux RPM, DEB, Arch, and AppImage

RPM, DEB, and Arch packages stay managed by their package manager. AppImage users can manually replace their AppImage with the new release file. No application-data executable or active-image redirect is created or used. Previously staged updater files are left untouched and ignored by this version.

Update native packages through your package manager using downloaded releases. This repository does not publish an APT/DNF/pacman package repository. For an RPM:

```sh
sudo dnf install ./sticky-markers-VERSION-linux-x86_64.rpm
```

On Arch, extract the `arch-pacman` release archive and run `make`, then `make install`, as your normal user. Its PKGBUILD compiles the immutable release source and validates its checksum. The generated package is installed/updated by pacman; the Makefile wraps makepkg rather than modifying system files directly. Arch supports native x86_64/aarch64 builds; release AppImages are currently published for x86_64.

### Flatpak

Install the downloaded bundle with:

```sh
flatpak install --user ./sticky-markers-VERSION-linux-flatpak-x86_64.flatpak
flatpak run dev.stickymarkers.desktop
```

Update a Flatpak with the new release bundle using `flatpak install --or-update`, preserving your existing user or system installation scope. The app does not invoke `flatpak-spawn` or modify the Flatpak installation. The manifest grants network, Secret Service, tray integration, and home-folder access for vaults. It is not a Flathub submission or a public Flatpak update repository. Flatpak keeps its own sandbox app-data directory; switching between Flatpak and a native install does not automatically migrate settings, though both can open the same note folders.

For a host MCP harness, use `flatpak` as the command and `["run", "--user", "--command=sticky-markers-mcp", "dev.stickymarkers.desktop", "--vault", "YOUR_VAULT_ID"]` as its arguments. This runs MCP inside the same sandbox/data directory as the Flatpak desktop.

### macOS and Windows

Download the macOS DMG or Windows EXE from the release packages link. On macOS, replace your installed application from the DMG. On Windows, run the new installer using the existing installation location and scope. Quit Sticky Markers first so open notes are saved. The app does not run installers or restart itself to apply updates.

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

The release tests check version/tag consistency, required signed targets, asset-name collisions, and checksums. Core tests verify signed bytes/version binding, tampering rejection, numeric version comparisons, and read-only checks of published/unpublished release feeds. The signing helper verifies all five updater targets before publishing.
