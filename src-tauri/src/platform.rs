use sticky_core::Core;
use tauri::AppHandle;
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    macos::init(app);
    #[cfg(target_os = "windows")]
    unsafe {
        let _ = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(
            windows::core::w!("dev.stickymarkers.desktop"),
        );
    }
    let _ = app;
}
pub fn refresh(app: &AppHandle, core: &Core) {
    #[cfg(target_os = "windows")]
    let _ = windows_menu::refresh(app, core);
    #[cfg(target_os = "linux")]
    let _ = linux_menu::refresh(core);
    let _ = (app, core);
}

#[cfg(target_os = "linux")]
mod linux_menu {
    use super::*;
    use std::{fs, path::PathBuf};
    fn arg(s: &str) -> String {
        format!(
            "\"{}\"",
            s.replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('%', "%%")
                .replace('\n', "\\n")
                .replace('\r', "\\r")
                .replace('`', "\\`")
                .replace('$', "\\$")
        )
    }
    pub fn refresh(core: &Core) -> sticky_core::Result<()> {
        let data = if std::env::var_os("FLATPAK_ID").is_some() {
            std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))
        } else {
            std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        }
        .ok_or_else(|| sticky_core::message("No desktop data directory"))?;
        let entry = data.join("applications/dev.stickymarkers.desktop.desktop");
        if entry.exists() && !fs::read_to_string(&entry)?.contains("X-StickyMarkers-Owned=true") {
            return Ok(());
        }
        let exe = std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .unwrap_or(std::env::current_exe()?);
        let exe = if std::env::var_os("FLATPAK_ID").is_some() {
            "flatpak run dev.stickymarkers.desktop".to_owned()
        } else {
            arg(&exe.to_string_lossy())
        };
        let icon = core.data.join("desktop-icon.png");
        if !icon.exists() {
            sticky_core::atomic_write(&icon, include_bytes!("../icons/icon.png"))?;
        }
        let recent = core.pinned()?;
        let actions = recent
            .iter()
            .enumerate()
            .map(|(i, _)| format!("Recent{i};"))
            .collect::<String>();
        let mut content=format!("[Desktop Entry]\nType=Application\nName=Sticky Markers\nComment=Markdown sticky notes\nExec={exe}\nIcon={}\nTerminal=false\nCategories=Utility;Office;\nStartupWMClass=dev.stickymarkers.desktop\nX-StickyMarkers-Owned=true\nActions=Main;New;{actions}\n\n[Desktop Action Main]\nName=Open Main Window\nExec={exe} --main\n\n[Desktop Action New]\nName=New Note\nExec={exe}\n",icon.display());
        for (i, n) in recent.iter().enumerate() {
            let title = n.path.trim_end_matches(".md").replace(['\n', '\r'], " ");
            content.push_str(&format!(
                "\n[Desktop Action Recent{i}]\nName={title}\nExec={exe} --open-note {} {}\n",
                arg(&n.vault_id),
                arg(&n.path)
            ));
        }
        sticky_core::atomic_write(&entry, content.as_bytes())?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&entry, fs::Permissions::from_mode(0o644))?;
        // Retire only our own legacy launcher, preserving user-created entries.
        let legacy = data.join("applications/Sticky Markers.desktop");
        if fs::read_to_string(&legacy)
            .map(|s| s.contains("X-StickyMarkers-Owned=true"))
            .unwrap_or(false)
        {
            fs::remove_file(legacy)?;
        }
        Ok(())
    }
}
pub fn handle_args(app: &AppHandle, core: &Core, args: &[String]) -> bool {
    if args.iter().any(|s| s == "--main") {
        let _ = super::show_main(app);
        return true;
    }
    if let Some(i) = args.iter().position(|s| s == "--open-note") {
        if let (Some(vault), Some(path)) = (args.get(i + 1), args.get(i + 2)) {
            let _ = super::open_note(app, core, vault, path);
            return true;
        }
    }
    false
}

#[cfg(target_os = "windows")]
mod windows_menu {
    use super::*;
    use windows::{
        core::{w, Interface, GUID, HSTRING, PCWSTR},
        Win32::{
            Foundation::PROPERTYKEY,
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, StructuredStorage::PROPVARIANT,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
            },
            UI::Shell::{
                Common::{IObjectArray, IObjectCollection},
                DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW,
                PropertiesSystem::IPropertyStore,
                ShellLink,
            },
        },
    };
    fn quote(s: &str) -> String {
        let mut out = String::from("\"");
        let mut slashes = 0;
        for c in s.chars() {
            if c == '\\' {
                slashes += 1;
                continue;
            }
            if c == '"' {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
            } else {
                out.push_str(&"\\".repeat(slashes));
            }
            out.push(c);
            slashes = 0;
        }
        out.push_str(&"\\".repeat(slashes * 2));
        out.push('"');
        out
    }
    pub fn refresh(_app: &AppHandle, core: &Core) -> windows::core::Result<()> {
        let recent = core.pinned().unwrap_or_default();
        let exe = std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        std::thread::spawn(move || unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
            struct ComGuard;
            impl Drop for ComGuard {
                fn drop(&mut self) {
                    unsafe { CoUninitialize() }
                }
            }
            let _guard = ComGuard;
            let list: ICustomDestinationList =
                CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
            list.SetAppID(w!("dev.stickymarkers.desktop"))?;
            let mut slots = 0;
            let _removed: IObjectArray = list.BeginList(&mut slots)?;
            let tasks: IObjectCollection =
                CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            let mut entries = vec![("Open Main Window".to_owned(), "--main".to_owned())];
            for n in recent {
                entries.push((
                    n.path.trim_end_matches(".md").into(),
                    format!("--open-note {} {}", quote(&n.vault_id), quote(&n.path)),
                ));
            }
            for (title, args) in entries {
                let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                let executable = HSTRING::from(&exe);
                let arguments = HSTRING::from(&args);
                let description = HSTRING::from(&title);
                link.SetPath(PCWSTR(executable.as_ptr()))?;
                link.SetArguments(PCWSTR(arguments.as_ptr()))?;
                link.SetDescription(PCWSTR(description.as_ptr()))?;
                let store: IPropertyStore = link.cast()?;
                let key = PROPERTYKEY {
                    fmtid: GUID::from_u128(0xf29f85e0_4ff9_1068_ab91_08002b27b3d9),
                    pid: 2,
                };
                let value = PROPVARIANT::from(title.as_str());
                store.SetValue(&key, &value)?;
                store.Commit()?;
                tasks.AddObject(&link)?;
            }
            let array: IObjectArray = tasks.cast()?;
            list.AddUserTasks(&array)?;
            list.CommitList()
        })
        .join()
        .unwrap_or_else(|_| {
            Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                0x80004005u32 as i32,
            )))
        })
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc::{
        msg_send,
        runtime::{Class, Object, Sel},
        sel, sel_impl,
    };
    use std::{
        ffi::{c_char, c_void, CStr, CString},
        sync::OnceLock,
    };
    static APP: OnceLock<AppHandle> = OnceLock::new();
    #[link(name = "objc")]
    extern "C" {
        fn class_replaceMethod(
            cls: *const Class,
            name: Sel,
            imp: *const c_void,
            types: *const c_char,
        ) -> *const c_void;
    }
    unsafe fn text(s: &str) -> *mut Object {
        let string = CString::new(s.replace('\0', "")).unwrap();
        msg_send![Class::get("NSString").unwrap(),stringWithUTF8String:string.as_ptr()]
    }
    extern "C" fn dock_menu(_this: &Object, _sel: Sel, _sender: *mut Object) -> *mut Object {
        unsafe {
            let menu: *mut Object = msg_send![Class::get("NSMenu").unwrap(), new];
            if let Some(app) = APP.get() {
                let nsapp: *mut Object =
                    msg_send![Class::get("NSApplication").unwrap(), sharedApplication];
                let delegate: *mut Object = msg_send![nsapp, delegate];
                let mut entries = vec![
                    ("Open Main Window".to_owned(), "main".to_owned()),
                    ("New Note".into(), "new".into()),
                ];
                let core = app.state::<super::super::Shared>().core.clone();
                if core.config().is_ok() {
                    for (i, n) in core.pinned().unwrap_or_default().iter().enumerate() {
                        entries
                            .push((n.path.trim_end_matches(".md").into(), format!("recent-{i}")));
                    }
                }
                entries.push(("Quit Sticky Markers".into(), "quit".into()));
                for (title, action) in entries {
                    let item: *mut Object = msg_send![Class::get("NSMenuItem").unwrap(), alloc];
                    let item: *mut Object = msg_send![item,initWithTitle:text(&title) action:sel!(stickyMarkersAction:) keyEquivalent:text("")];
                    let _: () = msg_send![item,setTarget:delegate];
                    let _: () = msg_send![item,setRepresentedObject:text(&action)];
                    let _: () = msg_send![menu,addItem:item];
                    let _: () = msg_send![item, release];
                }
            }
            msg_send![menu, autorelease]
        }
    }
    extern "C" fn action(_this: &Object, _sel: Sel, sender: *mut Object) {
        unsafe {
            let represented: *mut Object = msg_send![sender, representedObject];
            let ptr: *const c_char = msg_send![represented, UTF8String];
            if !ptr.is_null() {
                if let Some(app) = APP.get() {
                    super::super::menu_action(app, &CStr::from_ptr(ptr).to_string_lossy());
                }
            }
        }
    }
    pub fn init(app: &AppHandle) {
        let _ = APP.set(app.clone());
        unsafe {
            let nsapp: *mut Object =
                msg_send![Class::get("NSApplication").unwrap(), sharedApplication];
            let delegate: *mut Object = msg_send![nsapp, delegate];
            let class: *const Class = msg_send![delegate, class];
            class_replaceMethod(
                class,
                sel!(applicationDockMenu:),
                dock_menu as *const c_void,
                b"@@:@\0".as_ptr() as *const c_char,
            );
            class_replaceMethod(
                class,
                sel!(stickyMarkersAction:),
                action as *const c_void,
                b"v@:@\0".as_ptr() as *const c_char,
            );
        }
    }
    use tauri::Manager;
}
