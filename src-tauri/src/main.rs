#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod platform;
mod updates;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::Mutex,
};
use sticky_core::{message, Core, NoteStyle, Result, Settings};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowSizeConstraints,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

#[derive(Clone)]
struct Draft {
    vault: String,
    path: String,
}
struct Shared {
    core: Core,
    quitting: Mutex<Option<BTreeSet<String>>>,
    abort_quit: Mutex<bool>,
    drafts: Mutex<BTreeMap<String, Draft>>,
    library: sticky_core::library::Library,
}
fn label(id: &str, path: &str) -> String {
    format!(
        "note-{}",
        &blake3::hash(format!("{id}/{path}").as_bytes()).to_hex()[..20]
    )
}
fn window_label(app: &AppHandle, id: &str, path: &str) -> String {
    let shared = app.state::<Shared>();
    let drafts = shared.drafts.lock().unwrap();
    let alias = drafts
        .iter()
        .find(|(_, d)| d.vault == id && d.path == path)
        .map(|(k, _)| k.as_str());
    label(id, alias.unwrap_or(path))
}
fn window_icon(app: &AppHandle, window: &tauri::WebviewWindow) {
    if let Some(icon) = app.default_window_icon() {
        let _ = window.set_icon(icon.clone());
    }
}
fn main_constraints(expanded: bool) -> WindowSizeConstraints {
    WindowSizeConstraints {
        min_width: Some(tauri::LogicalUnit::new(if expanded { 600.0 } else { 300.0 }).into()),
        max_width: Some(tauri::LogicalUnit::new(if expanded { 1629.0 } else { 300.0 }).into()),
        min_height: Some(tauri::LogicalUnit::new(400.0).into()),
        ..Default::default()
    }
}
fn show_main(app: &AppHandle) -> std::result::Result<(), String> {
    show_main_page(app, false)
}
fn show_main_page(app: &AppHandle, updates: bool) -> std::result::Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
        if updates {
            let _ = w.emit("show-updates", ());
        }
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::App(
            if updates {
                "index.html?updates=1"
            } else {
                "index.html"
            }
            .into(),
        ),
    )
    .title("Sticky Markers")
    .inner_size(300.0, 700.0)
    .inner_size_constraints(main_constraints(false))
    .decorations(false)
    // Use the DOM drag events for moving selected notes between vaults.
    .disable_drag_drop_handler()
    .build()
    .map_err(|e| e.to_string())?;
    window_icon(app, &window);
    Ok(())
}
fn open_note(
    app: &AppHandle,
    core: &Core,
    id: &str,
    path: &str,
) -> std::result::Result<(), String> {
    open_note_at(app, core, id, path, None)
}
fn open_note_at(
    app: &AppHandle,
    core: &Core,
    id: &str,
    path: &str,
    heading: Option<&str>,
) -> std::result::Result<(), String> {
    if app.state::<Shared>().quitting.lock().unwrap().is_some() {
        return Err("The app is saving notes before quitting".into());
    }
    core.read(id, path).map_err(|e| e.to_string())?;
    let mut name = window_label(app, id, path);
    if let Some(w) = app.get_webview_window(&name) {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
        if let Some(heading) = heading {
            let _ = w.emit("navigate-heading", heading);
        }
        return Ok(());
    }
    let s = core.style(id, path).map_err(|e| e.to_string())?;
    let token = if s.provisional {
        let token = format!("draft-{}", uuid::Uuid::new_v4());
        app.state::<Shared>().drafts.lock().unwrap().insert(
            token.clone(),
            Draft {
                vault: id.into(),
                path: path.into(),
            },
        );
        name = label(id, &token);
        token
    } else {
        path.into()
    };
    let query = format!(
        "index.html?vault={}&note={}{}",
        encode(id),
        encode(&token),
        heading
            .map(|h| format!("&heading={}", encode(h)))
            .unwrap_or_default()
    );
    let builder = WebviewWindowBuilder::new(app, &name, WebviewUrl::App(query.into()))
        .title(if s.provisional { "New note" } else { path })
        .decorations(false)
        .inner_size(s.width.max(340.0), s.height.max(240.0))
        .min_inner_size(340.0, 240.0);
    let w = builder.build().map_err(|e| e.to_string())?;
    window_icon(app, &w);
    if let (Some(x), Some(y)) = (s.x, s.y) {
        if let Ok(monitors) = w.available_monitors() {
            if monitors.iter().any(|m| {
                let scale = m.scale_factor();
                let p = m.position();
                let sz = m.size();
                x >= p.x as f64 / scale
                    && y >= p.y as f64 / scale
                    && x < p.x as f64 / scale + sz.width as f64 / scale - 80.0
                    && y < p.y as f64 / scale + sz.height as f64 / scale - 80.0
            }) {
                let _ = w.set_position(tauri::LogicalPosition::new(x, y));
            }
        }
    }
    core.opened(id, path, true).map_err(|e| e.to_string())?;
    let _ = app.emit("notes-changed", ());
    let _ = refresh_menu(app, core);
    Ok(())
}
fn encode(s: &str) -> String {
    s.as_bytes()
        .iter()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(b) {
                (*b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn new_note(app: &AppHandle, core: &Core, id: Option<&str>) -> std::result::Result<Value, String> {
    if app.state::<Shared>().quitting.lock().unwrap().is_some() {
        return Err("The app is saving notes before quitting".into());
    }
    let c = core.config().map_err(|e| e.to_string())?;
    let chosen = id
        .map(str::to_owned)
        .or(c.main_vault)
        .or(c.active_vault)
        .or_else(|| c.vaults.first().map(|v| v.id.clone()));
    let Some(id) = chosen else {
        show_main(app)?;
        return Ok(Value::Null);
    };
    let document = core.create_new_note(&id).map_err(|e| e.to_string())?;
    app.state::<Shared>().library.invalidate();
    open_note(app, core, &id, &document.path)?;
    Ok(json!(document))
}
fn refresh_menu(app: &AppHandle, core: &Core) -> tauri::Result<()> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        "main",
        "Open Main Window",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "new",
        "New Note",
        true,
        Some("CmdOrCtrl+N"),
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let update = updates::status(app);
    menu.append(&MenuItem::with_id(
        app,
        "updates",
        update
            .version
            .map(|v| format!("Update to {v}…"))
            .unwrap_or_else(|| "Check for updates…".into()),
        true,
        None::<&str>,
    )?)?;
    if let Ok(c) = core.config() {
        for (i, n) in core.pinned().unwrap_or_default().iter().enumerate() {
            let vault = c
                .vaults
                .iter()
                .find(|v| v.id == n.vault_id)
                .map(|v| v.name.as_str())
                .unwrap_or("");
            menu.append(&MenuItem::with_id(
                app,
                format!("recent-{i}"),
                format!("{} · {vault}", n.path.trim_end_matches(".md")),
                true,
                None::<&str>,
            )?)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Quit Sticky Markers",
        true,
        Some("CmdOrCtrl+Q"),
    )?)?;
    if let Some(tray) = app.tray_by_id("sticky") {
        tray.set_menu(Some(menu))?;
    }
    platform::refresh(app, core);
    Ok(())
}
fn menu_action(app: &AppHandle, id: &str) {
    let core = app.state::<Shared>().core.clone();
    match id {
        "main" => {
            let _ = show_main(app);
        }
        "new" => {
            let _ = new_note(app, &core, None);
        }
        "quit" => request_quit(app),
        "updates" => {
            let _ = show_main_page(app, true);
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = updates::update_check(handle).await;
            });
        }
        _ => {
            if let Some(index) = id
                .strip_prefix("recent-")
                .and_then(|s| s.parse::<usize>().ok())
            {
                if core.config().is_ok() {
                    if let Some(n) = core.pinned().unwrap_or_default().get(index) {
                        let _ = open_note(app, &core, &n.vault_id, &n.path);
                    }
                }
            }
        }
    }
}
fn request_quit(app: &AppHandle) {
    let shared = app.state::<Shared>();
    let mut q = shared.quitting.lock().unwrap();
    if q.is_some() {
        return;
    }
    *shared.abort_quit.lock().unwrap() = false;
    *q = Some(
        app.webview_windows()
            .keys()
            .filter(|l| l.starts_with("note-"))
            .cloned()
            .collect(),
    );
    drop(q);
    let _ = app.emit("prepare-quit", ());
    let app = app.clone();
    std::thread::spawn(move || {
        for _ in 0..150 {
            if app
                .state::<Shared>()
                .abort_quit
                .lock()
                .map(|x| *x)
                .unwrap_or(true)
            {
                *app.state::<Shared>().quitting.lock().unwrap() = None;
                let _ = app.emit("quit-cancelled", ());
                return;
            }
            if app
                .state::<Shared>()
                .quitting
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|q| q.is_empty())
            {
                let core = app.state::<Shared>().core.clone();
                let (tx, rx) = std::sync::mpsc::channel();
                std::thread::spawn(move || {
                    let mut errors = Vec::new();
                    if let Ok(c) = core.config() {
                        for v in c.vaults {
                            if v.github.as_ref().is_some_and(|g| g.on_exit && !g.paused) {
                                if let Err(e) = sticky_core::github::sync(&core, &v.id) {
                                    errors.push(e.to_string());
                                }
                            }
                        }
                    }
                    let _ = tx.send(errors);
                });
                let errors=rx.recv_timeout(std::time::Duration::from_secs(15)).unwrap_or_else(|_|vec!["Exit sync did not finish within 15 seconds. Local notes are safe; upload remains pending.".into()]);
                if !errors.is_empty() {
                    let quit=app.dialog().message(format!("Notes are saved locally, but GitHub sync is pending:\n{}\n\nQuit and sync next time?",errors.join("\n"))).title("Sync pending").buttons(MessageDialogButtons::YesNo).blocking_show();
                    if !quit {
                        *app.state::<Shared>().quitting.lock().unwrap() = None;
                        let _ = app.emit("quit-cancelled", ());
                        return;
                    }
                }
                app.exit(0);
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        *app.state::<Shared>().quitting.lock().unwrap() = None;
        let _ = app.emit("quit-cancelled", ());
        let _ = app.emit(
            "quit-error",
            "Could not confirm all notes were saved. Quit was cancelled.",
        );
        let _ = show_main(&app);
    });
}
fn string<'a>(a: &'a Value, k: &str) -> Result<&'a str> {
    a[k].as_str().ok_or_else(|| message(format!("Missing {k}")))
}
#[tauri::command]
async fn dispatch(
    app: AppHandle,
    operation: String,
    args: Value,
) -> std::result::Result<Value, String> {
    let core = app.state::<Shared>().core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        route(&app, &core, &operation, &args).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
fn route(app: &AppHandle, core: &Core, op: &str, a: &Value) -> Result<Value> {
    if let (Some(id), Some(token)) = (a["vaultId"].as_str(), a["path"].as_str()) {
        if token.starts_with("draft-") {
            let path = app
                .state::<Shared>()
                .drafts
                .lock()
                .unwrap()
                .get(token)
                .filter(|d| d.vault == id)
                .map(|d| d.path.clone());
            if let Some(path) = path {
                let mut args = a.clone();
                args["path"] = json!(path);
                return route(app, core, op, &args);
            }
        }
    }
    let id = || string(a, "vaultId");
    let path = || string(a, "path");
    let mut changed = false;
    let result = match op {
        "bootstrap" => json!(core.config()?),
        "system_fonts" => {
            static FONTS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
            json!(FONTS.get_or_init(|| {
                let mut db = fontdb::Database::new();
                db.load_system_fonts();
                let mut names: Vec<_> = db
                    .faces()
                    .flat_map(|f| f.families.iter().map(|(name, _)| name.clone()))
                    .filter(|n| !n.chars().any(char::is_control))
                    .collect();
                names.sort_by_key(|a| a.to_lowercase());
                names.dedup();
                names
            }))
        }
        "register_vault" => {
            changed = true;
            json!(core.register(Path::new(path()?))?)
        }
        "create_vault" => {
            changed = true;
            json!(core.create_vault(Path::new(string(a, "parent")?), string(a, "name")?)?)
        }
        "select_vault" => {
            let id = id()?.to_owned();
            core.vault(&id)?;
            core.update_config(|c| {
                c.active_vault = Some(id);
                Ok(())
            })?;
            changed = true;
            Value::Null
        }
        "list_notes" => json!(core.list(id()?)?),
        "library_page" => json!(app.state::<Shared>().library.page(
            core,
            id()?,
            a["offset"].as_u64().unwrap_or(0) as usize,
            a["limit"].as_u64().unwrap_or(24) as usize,
            a["sort"].as_str().unwrap_or("date"),
            a["query"].as_str().unwrap_or(""),
            a["pinned"].as_bool().unwrap_or(false)
        )?),
        "set_vault_defaults" => {
            let color: Option<usize> = serde_json::from_value(a["color"].clone())?;
            core.set_vault_default_color(id()?, color)?;
            changed = true;
            Value::Null
        }
        "set_main_vault" => {
            let id = id()?.to_owned();
            core.vault(&id)?;
            core.update_config(|c| {
                c.main_vault = Some(id);
                Ok(())
            })?;
            changed = true;
            Value::Null
        }
        "main_panel" => {
            if let Some(w) = app.get_webview_window("main") {
                let expanded = a["expanded"].as_bool().unwrap_or(false);
                let height = w
                    .inner_size()
                    .map(|s| s.height as f64 / w.scale_factor().unwrap_or(1.0))
                    .unwrap_or(700.0);
                w.set_size_constraints(main_constraints(expanded))
                    .map_err(|e| message(e.to_string()))?;
                w.set_size(tauri::LogicalSize::new(
                    if expanded { 1120.0 } else { 300.0 },
                    height,
                ))
                .map_err(|e| message(e.to_string()))?;
            }
            Value::Null
        }
        "editor_preferences" => {
            core.update_config(|c| {
                if let Some(mode) = a["mode"].as_str() {
                    if !["edit", "view"].contains(&mode) {
                        return Err(message("Unknown editor mode"));
                    }
                    c.settings.mode = mode.into();
                }
                if let Some(pins) = a.get("toolbarPins") {
                    c.settings.toolbar_pins = serde_json::from_value(pins.clone())?;
                }
                Ok(())
            })?;
            changed = true;
            Value::Null
        }
        "move_notes" => {
            let notes: Vec<sticky_core::NoteRef> = serde_json::from_value(a["notes"].clone())?;
            let destination = string(a, "destination")?;
            if notes.len() > 100 {
                return Err(message("Move at most 100 notes at once"));
            }
            for note in &notes {
                if note.vault_id == destination {
                    continue;
                }
                if let Some(w) =
                    app.get_webview_window(&window_label(app, &note.vault_id, &note.path))
                {
                    w.emit("prepare-move", ())
                        .map_err(|e| message(e.to_string()))?;
                }
            }
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
            while notes.iter().any(|n| {
                n.vault_id != destination
                    && app
                        .get_webview_window(&window_label(app, &n.vault_id, &n.path))
                        .is_some()
            }) {
                if std::time::Instant::now() >= deadline {
                    return Err(message("A selected note could not finish saving. Resolve its save error before moving."));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            core.move_notes(&notes, destination)?;
            changed = true;
            Value::Null
        }
        "search_notes" => json!(core.search(id()?, string(a, "query")?)?),
        "read_note" => json!(core.read(id()?, path()?)?),
        "import_note" => {
            let mut imported = Vec::new();
            if let Some(sources) = app.dialog().file().blocking_pick_files() {
                for source in sources {
                    let source = source.into_path().map_err(|e| message(e.to_string()))?;
                    let name = source
                        .file_name()
                        .and_then(|s| s.to_str())
                        .ok_or_else(|| message("Invalid filename"))?;
                    let content = sticky_core::read_text(&source)?;
                    imported.push(core.create(id()?, Some(name), &content, None)?);
                    app.state::<Shared>().library.invalidate();
                    let _ = app.emit("notes-changed", ());
                }
                changed = true;
            }
            json!(imported)
        }
        "save_note" => {
            let old_path = path()?.to_owned();
            let name = window_label(app, id()?, &old_path);
            let saved = core.save(
                id()?,
                &old_path,
                string(a, "expected")?,
                string(a, "content")?,
                a["requestId"].as_str(),
            )?;
            let doc = core.finish_new_note(saved)?;
            if doc.path != old_path {
                for draft in app.state::<Shared>().drafts.lock().unwrap().values_mut() {
                    if draft.vault == id()? && draft.path == old_path {
                        draft.path = doc.path.clone();
                    }
                }
                if let Some(w) = app.get_webview_window(&name) {
                    let _ = w.set_title(&doc.path);
                }
            }
            changed = true;
            json!(doc)
        }
        "journal" => {
            core.journal(id()?, path()?, string(a, "content")?)?;
            Value::Null
        }
        "new_note" => new_note(app, core, a["vaultId"].as_str()).map_err(message)?,
        "open_note" => {
            open_note_at(app, core, id()?, path()?, a["heading"].as_str()).map_err(message)?;
            Value::Null
        }
        "show_main" => {
            show_main(app).map_err(message)?;
            Value::Null
        }
        "hide_main" => {
            if let Some(w) = app.get_webview_window("main") {
                w.hide().map_err(|e| message(e.to_string()))?;
            }
            Value::Null
        }
        "tuck_note" => {
            if !core.cleanup_empty_new_note(id()?, path()?)? {
                core.opened(id()?, path()?, false)?;
            }
            app.state::<Shared>().library.invalidate();
            if let Some(w) = app.get_webview_window(&window_label(app, id()?, path()?)) {
                w.destroy().map_err(|e| message(e.to_string()))?;
            }
            changed = true;
            Value::Null
        }
        "cleanup_new_note" => {
            changed = core.cleanup_empty_new_note(id()?, path()?)?;
            if changed {
                app.state::<Shared>().library.invalidate();
            }
            Value::Null
        }
        "save_to_vault" => {
            let destination = string(a, "destination")?;
            if destination == id()? {
                return Err(message("Choose another vault"));
            }
            if core.read(id()?, path()?)?.revision != string(a, "expected")? {
                return Err(sticky_core::Error::Conflict);
            }
            let name = window_label(app, id()?, path()?);
            core.move_notes(
                &[sticky_core::NoteRef {
                    vault_id: id()?.into(),
                    path: path()?.into(),
                }],
                destination,
            )?;
            let mut style = core.style(destination, path()?)?;
            style.provisional = false;
            core.set_style(destination, path()?, style)?;
            let doc = core.read(destination, path()?)?;
            if let Some(w) = app.get_webview_window(&name) {
                w.destroy().map_err(|e| message(e.to_string()))?;
            }
            open_note(app, core, destination, &doc.path).map_err(message)?;
            changed = true;
            json!(doc)
        }
        "delete_note" => {
            core.delete(id()?, path()?, string(a, "expected")?)?;
            if let Some(w) = app.get_webview_window(&window_label(app, id()?, path()?)) {
                w.destroy().map_err(|e| message(e.to_string()))?;
            }
            changed = true;
            Value::Null
        }
        "rename_note" => {
            let d = core.rename(
                id()?,
                path()?,
                string(a, "newPath")?,
                string(a, "expected")?,
            )?;
            if let Some(w) = app.get_webview_window(&window_label(app, id()?, path()?)) {
                w.destroy().map_err(|e| message(e.to_string()))?;
            }
            open_note(app, core, id()?, &d.path).map_err(message)?;
            changed = true;
            json!(d)
        }
        "set_style" => {
            let mut s: NoteStyle = serde_json::from_value(a["style"].clone())?;
            if s.font_size < 10.0 || s.font_size > 48.0 || s.color > 15 {
                return Err(message("Invalid note appearance"));
            }
            let current = core.style(id()?, path()?)?;
            s.width = current.width;
            s.height = current.height;
            s.x = current.x;
            s.y = current.y;
            s.open = current.open;
            s.provisional = current.provisional;
            if s.pinned && !current.pinned {
                s.pinned_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
            }
            if s.pinned && current.pinned {
                s.pinned_at = current.pinned_at;
            }
            if !s.pinned {
                s.pinned_at = 0;
            }
            core.set_style(id()?, path()?, s)?;
            changed = true;
            Value::Null
        }
        "set_appearance" => {
            let appearance = string(a, "appearance")?;
            if !["system", "light", "dark"].contains(&appearance) {
                return Err(message("Invalid appearance"));
            }
            core.update_config(|c| {
                c.settings.appearance = appearance.into();
                Ok(())
            })?;
            changed = true;
            Value::Null
        }
        "set_settings" => {
            let s: Settings = serde_json::from_value(a["settings"].clone())?;
            if !(340.0..=1600.0).contains(&s.width)
                || !(240.0..=1600.0).contains(&s.height)
                || !(10.0..=48.0).contains(&s.font_size)
                || s.color > 15
            {
                return Err(message(
                    "Note size or font size is outside its supported range",
                ));
            }
            core.update_config(|c| {
                c.settings = s;
                Ok(())
            })?;
            changed = true;
            Value::Null
        }
        "read_asset" => {
            let p = core.resolve(id()?, path()?)?;
            let b = std::fs::read(p)?;
            if b.len() > 20 * 1024 * 1024 {
                return Err(message("Attachment is too large"));
            }
            let mime = match path()?
                .rsplit('.')
                .next()
                .unwrap_or("")
                .to_lowercase()
                .as_str()
            {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                "svg" => "image/svg+xml",
                _ => return Err(message("Not an image")),
            };
            use base64::Engine;
            json!(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(b)
            ))
        }
        "export_note" => {
            let d = core.read(id()?, path()?)?;
            if let Some(p) = app
                .dialog()
                .file()
                .set_file_name(path()?.split('/').next_back().unwrap_or("Note.md"))
                .blocking_save_file()
            {
                let dest = p.into_path().map_err(|e| message(e.to_string()))?;
                sticky_core::atomic_write(&dest, d.content.as_bytes())?;
            }
            Value::Null
        }
        "open_recovery" => {
            app.opener()
                .open_path(core.data.join("recovery").to_string_lossy(), None::<&str>)
                .map_err(|e| message(e.to_string()))?;
            Value::Null
        }
        "recovery_path" => json!(core.data.join("recovery")),
        "github_start" => json!(sticky_core::github::start_device(string(a, "clientId")?)?),
        "github_poll" => {
            sticky_core::github::poll_device(string(a, "clientId")?, string(a, "deviceCode")?)?
        }
        "github_account" => sticky_core::github::account()?,
        "github_sign_out" => {
            sticky_core::github::sign_out()?;
            core.update_config(|c| {
                for v in &mut c.vaults {
                    if let Some(g) = &mut v.github {
                        g.paused = true;
                    }
                }
                Ok(())
            })?;
            changed = true;
            Value::Null
        }
        "github_create" => {
            changed = true;
            json!(sticky_core::github::create_vault(
                core,
                string(a, "name")?,
                Path::new(path()?)
            )?)
        }
        "github_reconnect" => {
            changed = true;
            json!(sticky_core::github::reconnect(
                core,
                string(a, "repository")?,
                Path::new(path()?)
            )?)
        }
        "github_rename" => {
            changed = true;
            json!(sticky_core::github::rename(
                core,
                id()?,
                string(a, "name")?
            )?)
        }
        "resolve_sync_conflict" => {
            changed = true;
            json!(sticky_core::github::resolve_conflict(
                core,
                id()?,
                path()?,
                string(a, "choice")?
            )?)
        }
        "sync_vault" => {
            let out = sticky_core::github::sync(core, id()?);
            let _ = app.emit("notes-changed", ());
            json!(out?)
        }
        "set_sync_options" => {
            let id = id()?;
            core.update_config(|c| {
                let g = c
                    .vaults
                    .iter_mut()
                    .find(|v| v.id == id)
                    .and_then(|v| v.github.as_mut())
                    .ok_or_else(|| message("This vault is externally managed"))?;
                g.frequency_minutes = a["frequencyMinutes"]
                    .as_u64()
                    .filter(|n| *n <= 1440)
                    .ok_or_else(|| message("Invalid sync interval"))?;
                g.on_exit = a["onExit"].as_bool().unwrap_or(true);
                g.paused = a["paused"].as_bool().unwrap_or(false);
                Ok(())
            })?;
            changed = true;
            Value::Null
        }
        "quit_ready" => {
            let shared = app.state::<Shared>();
            if a["ok"] == false {
                *shared.abort_quit.lock().unwrap() = true;
            }
            if let Some(q) = shared.quitting.lock().unwrap().as_mut() {
                q.remove(string(a, "label")?);
            }
            Value::Null
        }
        "quit" => {
            request_quit(app);
            Value::Null
        }
        _ => return Err(message("Unknown operation")),
    };
    if changed {
        if [
            "save_note",
            "register_vault",
            "rename_note",
            "delete_note",
            "move_notes",
            "save_to_vault",
            "create_vault",
            "import_note",
            "github_create",
            "sync_vault",
        ]
        .contains(&op)
        {
            app.state::<Shared>().library.invalidate();
        }
        let _ = app.emit("notes-changed", ());
        let _ = refresh_menu(app, core);
    }
    Ok(result)
}
fn main() {
    let core =
        Core::new(Core::default_location()).expect("Cannot open Sticky Markers app-data directory");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            let core = app.state::<Shared>().core.clone();
            if !platform::handle_args(app, &core, &args) {
                let _ = show_main(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(updates::State::default())
        .manage(Shared {
            core: core.clone(),
            quitting: Mutex::new(None),
            abort_quit: Mutex::new(false),
            drafts: Mutex::new(BTreeMap::new()),
            library: sticky_core::library::Library::default(),
        })
        .invoke_handler(tauri::generate_handler![
            dispatch,
            updates::update_status,
            updates::update_check
        ])
        .setup(move |app| {
            let menu = Menu::new(app)?;
            menu.append(&MenuItem::with_id(
                app,
                "main",
                "Open Main Window",
                true,
                None::<&str>,
            )?)?;
            let mut tray = TrayIconBuilder::with_id("sticky")
                .tooltip("Sticky Markers")
                .menu(&menu)
                .on_menu_event(|app, event| menu_action(app, event.id.as_ref()));
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            let _ = tray.build(app);
            platform::init(app.handle());
            #[cfg(target_os = "linux")]
            platform::refresh(app.handle(), &core);
            updates::start_scheduler(app.handle());
            let args = std::env::args().collect::<Vec<_>>();
            if !platform::handle_args(app.handle(), &core, &args) {
                show_main(app.handle()).map_err(std::io::Error::other)?;
                // Restore only recorded open notes, without scanning every vault
                // or repeatedly parsing the configuration on the GTK thread.
                let restore_app = app.handle().clone();
                let restore_core = core.clone();
                std::thread::spawn(move || {
                    if let Ok(c) = restore_core.config() {
                        for (key, style) in c.styles {
                            if !style.open {
                                continue;
                            }
                            if let Some((id, path)) = key.split_once('/') {
                                let _ = open_note(&restore_app, &restore_core, id, path);
                            }
                        }
                    }
                });
            }
            let _ = refresh_menu(app.handle(), &core);
            let handle = app.handle().clone();
            let worker = core.clone();
            std::thread::spawn(move || {
                let mut attempts = std::collections::BTreeMap::<String, u64>::new();
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(15));
                    if handle.state::<Shared>().quitting.lock().unwrap().is_some() {
                        continue;
                    }
                    if let Ok(c) = worker.config() {
                        for v in c.vaults {
                            if v.github.as_ref().is_some_and(|g| {
                                !g.paused
                                    && g.frequency_minutes > 0
                                    && sticky_core::timestamp()
                                        .saturating_sub(*attempts.get(&v.id).unwrap_or(&0))
                                        >= g.frequency_minutes * 60
                            }) {
                                attempts.insert(v.id.clone(), sticky_core::timestamp());
                                let _ = sticky_core::github::sync(&worker, &v.id);
                                let _ = handle.emit("notes-changed", ());
                            }
                        }
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|w, event| {
            if w.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = w.hide();
                }
                return;
            }
            if !w.label().starts_with("note-") {
                return;
            }
            if let tauri::WindowEvent::Destroyed = event {
                let shared = w.app_handle().state::<Shared>();
                shared
                    .drafts
                    .lock()
                    .unwrap()
                    .retain(|token, d| label(&d.vault, token) != w.label());
                return;
            }
            let core = w.app_handle().state::<Shared>().core.clone();
            if let Ok(c) = core.config() {
                for v in c.vaults {
                    for (key, mut s) in c.styles.clone() {
                        let prefix = format!("{}/", v.id);
                        if let Some(path) = key.strip_prefix(&prefix) {
                            if window_label(w.app_handle(), &v.id, path) != w.label() {
                                continue;
                            }
                            let scale = w.scale_factor().unwrap_or(1.0);
                            match event {
                                tauri::WindowEvent::Resized(size) => {
                                    s.width = size.width as f64 / scale;
                                    s.height = size.height as f64 / scale;
                                }
                                tauri::WindowEvent::Moved(pos) => {
                                    s.x = Some(pos.x as f64 / scale);
                                    s.y = Some(pos.y as f64 / scale);
                                }
                                _ => continue,
                            }
                            let _ = core.set_style(&v.id, path, s);
                        }
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Cannot start Sticky Markers");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { code, api, .. } if code.is_none() => {
            api.prevent_exit();
            // Tauri also requests exit when the last sticky window is destroyed.
            // Keep the tray and sync scheduler alive after tucking every note.
            if !app.webview_windows().is_empty() {
                request_quit(app);
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            let core = app.state::<Shared>().core.clone();
            let _ = show_main(app);
        }
        _ => {}
    });
}
