use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Duration;
use sticky_core::update;
use tauri::{AppHandle, Emitter, Manager};

type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: String,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub release_url: String,
    pub error: Option<String>,
    pub message: Option<String>,
}
pub struct State {
    status: Mutex<Status>,
    busy: AtomicBool,
}
impl Default for State {
    fn default() -> Self {
        Self {
            status: Mutex::new(Status {
                phase: "idle".into(),
                current_version: env!("CARGO_PKG_VERSION").into(),
                version: None,
                notes: None,
                release_url: update::RELEASES_URL.into(),
                error: None,
                message: None,
            }),
            busy: AtomicBool::new(false),
        }
    }
}
pub fn status(app: &AppHandle) -> Status {
    app.state::<State>().status.lock().unwrap().clone()
}
fn publish(app: &AppHandle, edit: impl FnOnce(&mut Status)) {
    let state = app.state::<State>();
    let mut status = state.status.lock().unwrap();
    edit(&mut status);
    let _ = app.emit("update-status", status.clone());
}
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Status> {
    let state = app.state::<State>();
    if state.busy.swap(true, Ordering::AcqRel) {
        return Ok(status(&app));
    }
    publish(&app, |s| {
        s.phase = "checking".into();
        s.error = None;
        s.message = None;
    });
    let result = tauri::async_runtime::spawn_blocking(|| update::check(env!("CARGO_PKG_VERSION")))
        .await
        .map_err(|e| e.to_string())
        .and_then(|result| result.map_err(|e| e.to_string()));
    publish(&app, |s| match &result {
        Ok(Some(Some(release))) => {
            s.phase = "available".into();
            s.version = Some(release.version.clone());
            s.notes = release.notes.clone();
            s.release_url = release.release_url.clone();
        }
        Ok(other) => {
            s.version = None;
            s.notes = None;
            s.release_url = update::RELEASES_URL.into();
            if other.is_none() {
                s.phase = "idle".into();
                s.message = Some("No published release packages are available yet.".into());
            } else {
                s.phase = "upToDate".into();
            }
        }
        Err(error) => {
            s.phase = "error".into();
            s.error = Some(error.clone());
        }
    });
    state.busy.store(false, Ordering::Release);
    if let Some(tray) = app.tray_by_id("sticky") {
        let _ = tray.set_tooltip(Some(if status(&app).version.is_some() {
            "Sticky Markers — an update is available"
        } else {
            "Sticky Markers"
        }));
    }
    let _ = super::refresh_menu(&app, &app.state::<super::Shared>().core);
    result?;
    Ok(status(&app))
}
#[tauri::command]
pub fn update_status(app: AppHandle) -> Status {
    status(&app)
}
pub fn start_scheduler(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        loop {
            if app
                .state::<super::Shared>()
                .core
                .config()
                .map(|c| c.settings.check_updates)
                .unwrap_or(false)
            {
                tauri::async_runtime::block_on(update_check(app.clone())).ok();
            }
            std::thread::sleep(Duration::from_secs(6 * 60 * 60));
        }
    });
}
