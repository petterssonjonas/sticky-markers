use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use sticky_core::{
    update::{self, Artifact},
    Core,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

type Result<T> = std::result::Result<T, String>;
const RELEASES: &str = "https://github.com/petterssonjonas/sticky-markers/releases/download/";
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: String,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub progress: u64,
    pub ready: bool,
    pub error: Option<String>,
    pub message: Option<String>,
    pub method: String,
}
struct Prepared {
    update: Update,
    path: PathBuf,
}
pub struct State {
    status: Mutex<Status>,
    candidate: Mutex<Option<Update>>,
    prepared: Mutex<Option<Prepared>>,
    busy: AtomicBool,
    install_requested: AtomicBool,
}
impl Default for State {
    fn default() -> Self {
        Self {
            status: Mutex::new(Status {
                phase: "idle".into(),
                current_version: env!("CARGO_PKG_VERSION").into(),
                version: None,
                notes: None,
                progress: 0,
                ready: false,
                error: None,
                message: None,
                method: if cfg!(target_os = "linux") {
                    if flatpak() {
                        "flatpak"
                    } else {
                        "appimage"
                    }
                } else {
                    "native"
                }
                .into(),
            }),
            candidate: Mutex::new(None),
            prepared: Mutex::new(None),
            busy: AtomicBool::new(false),
            install_requested: AtomicBool::new(false),
        }
    }
}
fn flatpak() -> bool {
    std::path::Path::new("/.flatpak-info").exists()
}
pub fn public_key() -> String {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("Embedded app config");
    config["plugins"]["updater"]["pubkey"]
        .as_str()
        .expect("Embedded updater key")
        .into()
}
pub fn status(app: &AppHandle) -> Status {
    app.state::<State>().status.lock().unwrap().clone()
}
fn publish(app: &AppHandle, edit: impl FnOnce(&mut Status)) {
    let state = app.state::<State>();
    let mut s = state.status.lock().unwrap();
    edit(&mut s);
    let _ = app.emit("update-status", s.clone());
}
fn fail(app: &AppHandle, error: String) -> String {
    publish(app, |s| {
        s.phase = "error".into();
        s.error = Some(error.clone());
    });
    let _ = super::refresh_menu(app, &app.state::<super::Shared>().core);
    error
}
fn validate_source(update: &Update) -> Result<()> {
    let prefix = format!("{RELEASES}v{}/", update.version);
    if !update.download_url.as_str().starts_with(&prefix)
        || update.download_url.query().is_some()
        || update.download_url.fragment().is_some()
    {
        return Err("Update must come from this repository's versioned GitHub release".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Status> {
    let state = app.state::<State>();
    if state.busy.swap(true, Ordering::AcqRel) {
        return Ok(status(&app));
    }
    if state.prepared.lock().unwrap().is_some() {
        state.busy.store(false, Ordering::Release);
        return Ok(status(&app));
    }
    publish(&app, |s| {
        s.phase = "checking".into();
        s.error = None;
        s.message = None;
    });
    let result = async {
        let mut builder = app.updater_builder().timeout(Duration::from_secs(30));
        // Always select portable Linux artifacts, regardless of the initial system package.
        if cfg!(target_os = "linux") {
            builder = builder.target(format!(
                "linux-{}{}",
                if flatpak() { "flatpak-" } else { "" },
                std::env::consts::ARCH
            ));
        }
        let update = match builder.build().map_err(|e| e.to_string())?.check().await {
            Ok(update) => update,
            Err(tauri_plugin_updater::Error::ReleaseNotFound) => {
                publish(&app, |s| {
                    s.phase = "idle".into();
                    s.message = Some("No published update feed is available yet.".into());
                });
                return Ok(());
            }
            Err(e) => return Err(e.to_string()),
        };
        if let Some(update) = update {
            validate_source(&update)?;
            let changed = status(&app).version.as_deref() != Some(&update.version);
            publish(&app, |s| {
                s.phase = "available".into();
                s.version = Some(update.version.clone());
                s.notes = update.body.clone();
                s.progress = 0;
            });
            *state.candidate.lock().unwrap() = Some(update);
            if changed {
                if let Some(tray) = app.tray_by_id("sticky") {
                    let _ = tray.set_tooltip(Some("Sticky Markers — an update is available"));
                }
            }
        } else {
            *state.candidate.lock().unwrap() = None;
            publish(&app, |s| {
                s.phase = "upToDate".into();
                s.version = None;
                s.notes = None;
            });
        }
        Ok(())
    }
    .await;
    state.busy.store(false, Ordering::Release);
    if let Err(e) = result {
        return Err(fail(&app, e));
    }
    let _ = super::refresh_menu(&app, &app.state::<super::Shared>().core);
    Ok(status(&app))
}
#[tauri::command]
pub fn update_status(app: AppHandle) -> Status {
    status(&app)
}
#[tauri::command]
pub async fn update_download(app: AppHandle) -> Result<Status> {
    let state = app.state::<State>();
    if state.busy.swap(true, Ordering::AcqRel) {
        return Err("An update operation is already running".into());
    }
    let update = state.candidate.lock().unwrap().clone();
    let result = async {
        let mut update = update.ok_or_else(|| "Check for an update first".to_owned())?;
        validate_source(&update)?;
        update.timeout = Some(Duration::from_secs(300));
        publish(&app, |s| {
            s.phase = "downloading".into();
            s.error = None;
            s.progress = 0;
        });
        let mut downloaded = 0u64;
        let mut percent = 0u64;
        let bytes = update
            .download(
                |chunk, total| {
                    downloaded += chunk as u64;
                    let next = total
                        .filter(|n| *n > 0)
                        .map(|n| (downloaded.saturating_mul(100) / n).min(99))
                        .unwrap_or(0);
                    if next != percent {
                        percent = next;
                        publish(&app, |s| s.progress = next);
                    }
                },
                || {
                    publish(&app, |s| {
                        s.message = Some("Verifying the signed download…".into())
                    })
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        let core = app.state::<super::Shared>().core.clone();
        let path = core.data.join(if flatpak() {
            "updates/pending.flatpak"
        } else {
            "updates/pending.bin"
        });
        sticky_core::atomic_write(&path, &bytes).map_err(|e| e.to_string())?;
        *state.prepared.lock().unwrap() = Some(Prepared { update, path });
        publish(&app, |s| {
            s.phase = "ready".into();
            s.ready = true;
            s.progress = 100;
            s.message = Some("Verified. Restart to install after all notes are saved.".into());
        });
        Ok(())
    }
    .await;
    state.busy.store(false, Ordering::Release);
    if let Err(e) = result {
        return Err(fail(&app, e));
    }
    let _ = super::refresh_menu(&app, &app.state::<super::Shared>().core);
    Ok(status(&app))
}
#[tauri::command]
pub fn update_restart(app: AppHandle) -> Result<()> {
    if app
        .state::<super::Shared>()
        .quitting
        .lock()
        .unwrap()
        .is_some()
    {
        return Err("The app is already preparing to quit".into());
    }
    if app.state::<State>().prepared.lock().unwrap().is_none() {
        return Err("Download and verify the update first".into());
    }
    app.state::<State>()
        .install_requested
        .store(true, Ordering::Release);
    publish(&app, |s| {
        s.phase = "installing".into();
        s.message = Some("Saving all open notes before installing…".into());
    });
    super::request_quit(&app);
    Ok(())
}
pub fn install_requested(app: &AppHandle) -> bool {
    app.state::<State>()
        .install_requested
        .load(Ordering::Acquire)
}
pub fn cancel_install(app: &AppHandle, message: &str) {
    app.state::<State>()
        .install_requested
        .store(false, Ordering::Release);
    if status(app).ready {
        fail(app, message.into());
    }
}
/// Called only after every note acknowledges that its current buffer is saved.
pub fn apply(app: &AppHandle, core: &Core) -> Result<()> {
    let state = app.state::<State>();
    let pending = state.prepared.lock().unwrap();
    let pending = pending
        .as_ref()
        .ok_or_else(|| "No verified update is ready".to_owned())?;
    publish(app, |s| {
        s.phase = "installing".into();
        s.error = None;
    });
    let bytes = std::fs::read(&pending.path).map_err(|e| e.to_string())?;
    let artifact = Artifact {
        version: pending.update.version.clone(),
        signature: pending.update.signature.clone(),
    };
    // Verify again after staging, before using any bytes on disk.
    update::verify(&bytes, &artifact, &public_key()).map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    {
        if flatpak() {
            let output = std::process::Command::new("flatpak-spawn")
                .args([
                    "--host",
                    "flatpak",
                    "install",
                    "--user",
                    "--noninteractive",
                    "--or-update",
                ])
                .arg(&pending.path)
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(format!(
                    "Flatpak update failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            // Fixed arguments only; restart through the host after this instance exits.
            std::process::Command::new("flatpak-spawn")
                .args([
                    "--host",
                    "sh",
                    "-c",
                    "sleep 2; exec flatpak run --user dev.stickymarkers.desktop",
                ])
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            let path = update::activate_image(
                core,
                &bytes,
                &artifact,
                &public_key(),
                env!("CARGO_PKG_VERSION"),
            )
            .map_err(|e| e.to_string())?;
            spawn_image(path)?;
        }
        app.exit(0);
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = core;
        pending.update.install(&bytes).map_err(|e| e.to_string())?;
        app.restart();
    }
}
#[cfg(target_os = "linux")]
fn spawn_image(path: PathBuf) -> Result<()> {
    std::process::Command::new(path)
        .args(["--sticky-restart-wait", &std::process::id().to_string()])
        .env_remove("APPIMAGE")
        .env_remove("APPDIR")
        .env("APPIMAGE_EXTRACT_AND_RUN", "1")
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn bootstrap(core: &Core) -> bool {
    #[cfg(target_os = "linux")]
    {
        let args = std::env::args().collect::<Vec<_>>();
        if let Some(i) = args.iter().position(|a| a == "--sticky-restart-wait") {
            if let Some(pid) = args.get(i + 1).and_then(|p| p.parse::<u32>().ok()) {
                for _ in 0..100 {
                    if !std::path::Path::new(&format!("/proc/{pid}")).exists() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
        if !flatpak() {
            match update::active_image(core, env!("CARGO_PKG_VERSION"), &public_key()) {
                Ok(Some(path)) => {
                    // Forward launcher actions, preserving access to existing vaults.
                    return std::process::Command::new(path)
                        .args(args.into_iter().skip(1))
                        .env_remove("APPIMAGE")
                        .env_remove("APPDIR")
                        .env("APPIMAGE_EXTRACT_AND_RUN", "1")
                        .spawn()
                        .is_ok();
                }
                Err(e) => eprintln!(
                    "User-managed update could not be started: {e}. Starting installed version."
                ),
                _ => {}
            }
        }
    }
    let _ = core;
    false
}
pub fn start_scheduler(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Checking never blocks opening a window, typing, or local saves.
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(5));
            loop {
                let enabled = app
                    .state::<super::Shared>()
                    .core
                    .config()
                    .map(|c| c.settings.check_updates)
                    .unwrap_or(false);
                if enabled && !install_requested(&app) {
                    let handle = app.clone();
                    tauri::async_runtime::block_on(update_check(handle)).ok();
                }
                std::thread::sleep(Duration::from_secs(6 * 60 * 60));
            }
        });
    });
}
