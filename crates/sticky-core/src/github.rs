//! GitHub Git Data API sync. No Git operations are performed on external vaults.
use crate::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
#[cfg(test)]
thread_local! { static TEST_API: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) }; }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub repository: String,
    pub repository_id: u64,
    pub branch: String,
    pub frequency_minutes: u64,
    pub on_exit: bool,
    pub paused: bool,
    #[serde(default)]
    pub last_sync: Option<u64>,
    #[serde(default)]
    pub baseline: BTreeMap<String, String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub conflicts: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}
fn client() -> Result<Client> {
    Client::builder()
        .user_agent("sticky-markers/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| message(e.to_string()))
}
fn credential() -> Result<keyring::Entry> {
    keyring::Entry::new("dev.stickymarkers.desktop", "github").map_err(|e| message(e.to_string()))
}
fn token() -> Result<String> {
    #[cfg(test)]
    if TEST_API.with(|a| a.borrow().is_some()) {
        return Ok("test-token".into());
    }
    credential()?
        .get_password()
        .map_err(|_| message("Sign in to GitHub first; the OS credential store must be available"))
}
pub fn sign_out() -> Result<()> {
    credential()?
        .delete_credential()
        .map_err(|e| message(e.to_string()))
}
pub fn start_device(client_id: &str) -> Result<DeviceCode> {
    if client_id.trim().is_empty() {
        return Err(message("Set the public GitHub OAuth application client ID in Settings. Device flow must be enabled in that application's GitHub settings."));
    }
    let r = client()?
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id), ("scope", "repo")])
        .send()
        .map_err(|e| message(e.to_string()))?;
    if !r.status().is_success() {
        return Err(message(format!("GitHub sign-in returned {}", r.status())));
    }
    r.json().map_err(|e| message(e.to_string()))
}
pub fn poll_device(client_id: &str, device_code: &str) -> Result<Value> {
    let v: Value = client()?
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .map_err(|e| message(e.to_string()))?
        .json()
        .map_err(|e| message(e.to_string()))?;
    if let Some(t) = v["access_token"].as_str() {
        credential()?
            .set_password(t)
            .map_err(|e| message(format!("Cannot securely store GitHub credential: {e}")))?;
        return account();
    }
    Ok(json!({"pending":true,"error":v["error"],"description":v["error_description"]}))
}
fn api(method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
    let endpoint = "https://api.github.com".to_owned();
    #[cfg(test)]
    let endpoint = TEST_API.with(|a| a.borrow().clone()).unwrap_or(endpoint);
    let mut request = client()?
        .request(method, format!("{endpoint}{path}"))
        .bearer_auth(token()?)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let r = request.send().map_err(|e| message(e.to_string()))?;
    let status = r.status();
    let v: Value = r.json().map_err(|e| message(e.to_string()))?;
    if !status.is_success() {
        return Err(message(format!(
            "GitHub {}: {}",
            status,
            v["message"].as_str().unwrap_or("request failed")
        )));
    }
    Ok(v)
}
pub fn account() -> Result<Value> {
    let v = api(reqwest::Method::GET, "/user", None)?;
    Ok(json!({"login":v["login"],"avatarUrl":v["avatar_url"]}))
}
pub fn create_vault(core: &Core, name: &str, path: &Path) -> Result<Vault> {
    if name.is_empty()
        || name.len() > 100
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(message(
            "Repository name must use letters, digits, periods, dashes or underscores",
        ));
    }
    validate_new_location(core, path)?;
    let repo = api(
        reqwest::Method::POST,
        "/user/repos",
        Some(
            json!({"name":name,"private":true,"auto_init":true,"description":"Sticky Markers notes vault"}),
        ),
    )?;
    if repo["private"] != true {
        return Err(message(
            "GitHub did not create a private repository; no files were uploaded",
        ));
    }
    fs::create_dir_all(path)?;
    let v = core.register(path)?;
    let cfg = SyncConfig {
        repository: repo["full_name"]
            .as_str()
            .ok_or_else(|| message("Invalid GitHub repository response"))?
            .into(),
        repository_id: repo["id"]
            .as_u64()
            .ok_or_else(|| message("Missing repository identity"))?,
        branch: repo["default_branch"].as_str().unwrap_or("main").into(),
        frequency_minutes: 5,
        on_exit: true,
        paused: false,
        last_sync: None,
        baseline: BTreeMap::new(),
        error: None,
        conflicts: Vec::new(),
    };
    core.update_config(|c| {
        c.vaults.iter_mut().find(|x| x.id == v.id).unwrap().github = Some(cfg);
        Ok(())
    })?;
    core.vault(&v.id)
}
pub fn reconnect(core: &Core, repository: &str, path: &Path) -> Result<Vault> {
    validate_repo(repository)?;
    let repo = api(reqwest::Method::GET, &format!("/repos/{repository}"), None)?;
    if repo["private"] != true || repo["description"] != "Sticky Markers notes vault" {
        return Err(message(
            "Reconnect is limited to private repositories created as Sticky Markers vaults",
        ));
    }
    validate_new_location(core, path)?;
    fs::create_dir_all(path)?;
    let v = core.register(path)?;
    core.update_config(|c| {
        c.vaults.iter_mut().find(|x| x.id == v.id).unwrap().github = Some(SyncConfig {
            repository: repository.into(),
            repository_id: repo["id"]
                .as_u64()
                .ok_or_else(|| message("Missing repository ID"))?,
            branch: repo["default_branch"].as_str().unwrap_or("main").into(),
            frequency_minutes: 5,
            on_exit: true,
            paused: false,
            last_sync: None,
            baseline: BTreeMap::new(),
            error: None,
            conflicts: Vec::new(),
        });
        Ok(())
    })?;
    core.vault(&v.id)
}
fn validate_repo(s: &str) -> Result<()> {
    let parts = s.split('/').collect::<Vec<_>>();
    if parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || !p
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        })
    {
        return Err(message("Use owner/repository"));
    }
    Ok(())
}
fn validate_new_location(core: &Core, path: &Path) -> Result<()> {
    let real = if path.exists() {
        fs::canonicalize(path)?
    } else {
        let parent = fs::canonicalize(path.parent().ok_or_else(|| message("Choose a folder"))?)?;
        parent.join(path.file_name().ok_or_else(|| message("Choose a folder"))?)
    };
    if has_git_ancestor(&real) {
        return Err(message(
            "A GitHub synced vault must be outside existing Git repositories",
        ));
    }
    if real.exists() && fs::read_dir(&real)?.next().is_some() {
        return Err(message("Choose a separate new or empty folder"));
    }
    if core
        .config()?
        .vaults
        .iter()
        .any(|v| real.starts_with(&v.path) || Path::new(&v.path).starts_with(&real))
    {
        return Err(message("Choose a separate location outside registered vaults; external vaults cannot be converted"));
    }
    Ok(())
}
pub fn rename(core: &Core, id: &str, name: &str) -> Result<Vault> {
    let v = core.vault(id)?;
    let cfg = v
        .github
        .ok_or_else(|| message("This vault is externally managed"))?;
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    {
        return Err(message("Invalid repository name"));
    }
    let repo = api(
        reqwest::Method::PATCH,
        &format!("/repos/{}", cfg.repository),
        Some(json!({"name":name})),
    )?;
    if repo["id"].as_u64() != Some(cfg.repository_id) {
        return Err(message("Repository identity changed"));
    }
    core.update_config(|c| {
        let v = c
            .vaults
            .iter_mut()
            .find(|v| v.id == id)
            .ok_or_else(|| message("Unknown vault"))?;
        v.github.as_mut().unwrap().repository = repo["full_name"]
            .as_str()
            .ok_or_else(|| message("Missing repository name"))?
            .into();
        Ok(())
    })?;
    core.vault(id)
}
fn supported(path: &str) -> bool {
    !path.is_empty() && !path.split('/').any(|p| p.starts_with('.'))
}
fn attachment(path: &str) -> bool {
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf"]
        .iter()
        .any(|ext| path.to_lowercase().ends_with(&format!(".{ext}")))
}
fn supported_data(path: &str, bytes: &[u8]) -> bool {
    attachment(path)
        || (bytes.len() <= crate::NOTE_LIMIT
            && std::str::from_utf8(bytes)
                .map(|s| crate::validate_content(s).is_ok())
                .unwrap_or(false))
}
pub fn resolve_conflict(core: &Core, id: &str, path: &str, choice: &str) -> Result<Vault> {
    let v = core.vault(id)?;
    if has_git_ancestor(Path::new(&v.path)) {
        return Err(message("Existing Git repositories are externally managed"));
    }
    let cfg = v
        .github
        .ok_or_else(|| message("This vault is externally managed"))?;
    if !cfg.conflicts.iter().any(|p| p == path) {
        return Err(message("This file has no recorded sync conflict"));
    }
    if !["local", "remote"].contains(&choice) {
        return Err(message("Choose local or remote explicitly"));
    }
    let _sync_lock = core.lock(&format!("sync:{id}"))?;
    let p = core.resolve(id, path)?;
    let repo = api(
        reqwest::Method::GET,
        &format!("/repos/{}", cfg.repository),
        None,
    )?;
    if repo["id"].as_u64() != Some(cfg.repository_id) || repo["private"] != true {
        return Err(message("Repository identity or privacy changed"));
    }
    let encoded = path
        .as_bytes()
        .iter()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~/".contains(b) {
                (*b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect::<String>();
    let remote = api(
        reqwest::Method::GET,
        &format!(
            "/repos/{}/contents/{}?ref={}",
            cfg.repository, encoded, cfg.branch
        ),
        None,
    );
    let bytes = match remote {
        Ok(value) => Some(
            STANDARD
                .decode(
                    value["content"]
                        .as_str()
                        .ok_or_else(|| message("Remote content is unavailable"))?
                        .replace('\n', ""),
                )
                .map_err(|e| message(e.to_string()))?,
        ),
        Err(e) if e.to_string().starts_with("GitHub 404") => None,
        Err(e) => return Err(e),
    };
    let _file_lock = core.lock(&p.to_string_lossy())?;
    if let Ok(local) = fs::read(&p) {
        core.recovery(id, path, &local)?;
    }
    if let Some(b) = &bytes {
        core.recovery(id, path, b)?;
    }
    if choice == "remote" {
        if let Some(b) = &bytes {
            atomic_write(&p, b)?;
        } else if p.exists() {
            fs::remove_file(&p)?;
        }
    }
    core.update_config(|c| {
        let g = c
            .vaults
            .iter_mut()
            .find(|x| x.id == id)
            .unwrap()
            .github
            .as_mut()
            .unwrap();
        if let Some(b) = &bytes {
            g.baseline.insert(path.into(), revision(b));
        } else {
            g.baseline.remove(path);
        }
        g.conflicts.retain(|p| p != path);
        if g.conflicts.is_empty() {
            g.error = None;
        }
        Ok(())
    })?;
    core.vault(id)
}
fn local_files(root: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut files = BTreeMap::new();
    for e in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
    {
        let e = e.map_err(|e| message(e.to_string()))?;
        if !e.file_type().is_file() {
            continue;
        }
        let path = e
            .path()
            .strip_prefix(root)
            .map_err(|e| message(e.to_string()))?
            .to_string_lossy()
            .replace('\\', "/");
        if supported(&path) {
            let size = e.metadata().map_err(|e| message(e.to_string()))?.len();
            if !attachment(&path) && size > crate::NOTE_LIMIT as u64 {
                continue;
            }
            if size > 20 * 1024 * 1024 {
                return Err(message(format!("{path} exceeds the 20 MiB sync limit")));
            }
            let b = fs::read(e.path())?;
            if supported_data(&path, &b) {
                files.insert(path, b);
            }
        }
    }
    Ok(files)
}
#[derive(Debug, PartialEq)]
enum Decision {
    Local,
    Remote,
    Same,
    Conflict,
}
fn decide(base: Option<&String>, local: Option<&String>, remote: Option<&String>) -> Decision {
    if local == remote {
        Decision::Same
    } else if local == base {
        Decision::Remote
    } else if remote == base {
        Decision::Local
    } else {
        Decision::Conflict
    }
}
pub fn sync(core: &Core, id: &str) -> Result<Vault> {
    let v = core.vault(id)?;
    // This check precedes credentials, network requests, and file mutations.
    let cfg = v.github.clone().ok_or_else(|| {
        message("Externally managed vault: Sticky Markers never syncs this repository")
    })?;
    let _lock = core.lock(&format!("sync:{id}"))?;
    let result = sync_inner(core, &v, &cfg);
    if let Err(ref e) = result {
        core.update_config(|c| {
            if let Some(v) = c.vaults.iter_mut().find(|v| v.id == id) {
                v.github.as_mut().unwrap().error = Some(e.to_string());
            }
            Ok(())
        })?;
    }
    result?;
    core.vault(id)
}
fn sync_inner(core: &Core, v: &Vault, cfg: &SyncConfig) -> Result<()> {
    validate_repo(&cfg.repository)?;
    if has_git_ancestor(Path::new(&v.path)) {
        return Err(message(
            "Managed vault was moved inside a Git repository; synchronization paused",
        ));
    }
    let repo = api(
        reqwest::Method::GET,
        &format!("/repos/{}", cfg.repository),
        None,
    )?;
    if repo["id"].as_u64() != Some(cfg.repository_id) || repo["private"] != true {
        return Err(message(
            "Repository identity or privacy changed; synchronization paused",
        ));
    }
    let head = api(
        reqwest::Method::GET,
        &format!("/repos/{}/git/ref/heads/{}", cfg.repository, cfg.branch),
        None,
    )?;
    let sha = head["object"]["sha"]
        .as_str()
        .ok_or_else(|| message("No remote branch"))?;
    let commit = api(
        reqwest::Method::GET,
        &format!("/repos/{}/git/commits/{sha}", cfg.repository),
        None,
    )?;
    let tree_sha = commit["tree"]["sha"]
        .as_str()
        .ok_or_else(|| message("Missing Git tree"))?;
    let tree = api(
        reqwest::Method::GET,
        &format!("/repos/{}/git/trees/{tree_sha}?recursive=1", cfg.repository),
        None,
    )?;
    if tree["truncated"] == true {
        return Err(message("Remote vault is too large to enumerate safely"));
    }
    let mut remote = BTreeMap::new();
    for item in tree["tree"]
        .as_array()
        .ok_or_else(|| message("Missing remote file list"))?
    {
        let path = item["path"].as_str().unwrap_or("");
        if item["type"] != "blob" || !supported(path) {
            continue;
        }
        core.resolve(&v.id, path)?;
        if !attachment(path) && item["size"].as_u64().unwrap_or(0) > crate::NOTE_LIMIT as u64 {
            if cfg.baseline.contains_key(path) {
                return Err(message(format!(
                    "Synced {path} exceeds the editing limit; both versions are kept unchanged"
                )));
            }
            continue;
        }
        if item["size"].as_u64().unwrap_or(0) > 20 * 1024 * 1024 {
            return Err(message(format!("Remote {path} exceeds the sync limit")));
        }
        let blob = api(
            reqwest::Method::GET,
            &format!(
                "/repos/{}/git/blobs/{}",
                cfg.repository,
                item["sha"]
                    .as_str()
                    .ok_or_else(|| message("Missing blob SHA"))?
            ),
            None,
        )?;
        let b = STANDARD
            .decode(blob["content"].as_str().unwrap_or("").replace('\n', ""))
            .map_err(|e| message(e.to_string()))?;
        if supported_data(path, &b) {
            remote.insert(path.to_owned(), b);
        } else if cfg.baseline.contains_key(path) {
            return Err(message(format!(
                "Synced {path} is no longer editable text; both versions are kept unchanged"
            )));
        }
    }
    let local = local_files(Path::new(&v.path))?;
    for path in cfg.baseline.keys().chain(remote.keys()) {
        if !local.contains_key(path) && core.resolve(&v.id, path)?.exists() {
            return Err(message(format!("Local {path} is too large or is not editable text; sync left both versions unchanged")));
        }
    }
    let lh = local
        .iter()
        .map(|(p, b)| (p.clone(), revision(b)))
        .collect::<BTreeMap<_, _>>();
    let rh = remote
        .iter()
        .map(|(p, b)| (p.clone(), revision(b)))
        .collect::<BTreeMap<_, _>>();
    let paths = cfg
        .baseline
        .keys()
        .chain(lh.keys())
        .chain(rh.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut merged = remote.clone();
    let mut incoming = Vec::new();
    let mut conflicts = Vec::new();
    for p in paths {
        match decide(cfg.baseline.get(&p), lh.get(&p), rh.get(&p)) {
            Decision::Local => {
                if let Some(b) = local.get(&p) {
                    merged.insert(p, b.clone());
                } else {
                    merged.remove(&p);
                }
            }
            Decision::Remote => incoming.push(p),
            Decision::Same => {}
            Decision::Conflict => {
                if let Some(b) = remote.get(&p) {
                    core.recovery(&v.id, &p, b)?;
                }
                if let Some(b) = local.get(&p) {
                    core.recovery(&v.id, &p, b)?;
                }
                conflicts.push(p);
            }
        }
    }
    if !conflicts.is_empty() {
        core.update_config(|c| {
            c.vaults
                .iter_mut()
                .find(|x| x.id == v.id)
                .unwrap()
                .github
                .as_mut()
                .unwrap()
                .conflicts = conflicts.clone();
            Ok(())
        })?;
        return Err(message(format!(
            "Sync conflict in {}. Both versions are in recovery; resolve before syncing.",
            conflicts.join(", ")
        )));
    }
    if merged != remote {
        let mut changes = Vec::new();
        for p in merged
            .keys()
            .chain(remote.keys())
            .cloned()
            .collect::<BTreeSet<_>>()
        {
            if merged.get(&p) == remote.get(&p) {
                continue;
            }
            if let Some(b) = merged.get(&p) {
                let blob = api(
                    reqwest::Method::POST,
                    &format!("/repos/{}/git/blobs", cfg.repository),
                    Some(json!({"content":STANDARD.encode(b),"encoding":"base64"})),
                )?;
                changes.push(json!({"path":p,"mode":"100644","type":"blob","sha":blob["sha"]}));
            } else {
                changes.push(json!({"path":p,"mode":"100644","type":"blob","sha":null}));
            }
        }
        let new_tree = api(
            reqwest::Method::POST,
            &format!("/repos/{}/git/trees", cfg.repository),
            Some(json!({"base_tree":tree_sha,"tree":changes})),
        )?;
        let new_commit = api(
            reqwest::Method::POST,
            &format!("/repos/{}/git/commits", cfg.repository),
            Some(
                json!({"message":"Sync notes from Sticky Markers","tree":new_tree["sha"],"parents":[sha]}),
            ),
        )?;
        api(
            reqwest::Method::PATCH,
            &format!("/repos/{}/git/refs/heads/{}", cfg.repository, cfg.branch),
            Some(json!({"sha":new_commit["sha"],"force":false})),
        )?;
    }
    // Apply remote-only changes with fresh per-file checks. New local edits are preserved.
    for p in incoming {
        let dest = core.resolve(&v.id, &p)?;
        let _file_lock = core.lock(&dest.to_string_lossy())?;
        let current = fs::read(&dest).ok();
        if current.as_ref().map(|b| revision(b)) != lh.get(&p).cloned() {
            return Err(message(format!(
                "{p} changed during sync. Local edits were preserved; retry."
            )));
        }
        if let Some(b) = &current {
            core.recovery(&v.id, &p, b)?;
        }
        if let Some(b) = remote.get(&p) {
            atomic_write(&dest, b)?;
        } else if dest.exists() {
            fs::remove_file(&dest)?;
        }
    }
    let baseline = merged
        .iter()
        .map(|(p, b)| (p.clone(), revision(b)))
        .collect();
    core.update_config(|c| {
        let g = c
            .vaults
            .iter_mut()
            .find(|x| x.id == v.id)
            .unwrap()
            .github
            .as_mut()
            .unwrap();
        g.baseline = baseline;
        g.last_sync = Some(timestamp());
        g.error = None;
        g.conflicts.clear();
        Ok(())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn three_way_never_silently_picks_conflicts() {
        let a = "a".into();
        let b = "b".into();
        let c = "c".into();
        assert_eq!(decide(Some(&a), Some(&b), Some(&c)), Decision::Conflict);
        assert_eq!(decide(Some(&a), Some(&a), Some(&b)), Decision::Remote);
        assert_eq!(decide(Some(&a), Some(&b), Some(&a)), Decision::Local);
        assert_eq!(decide(Some(&a), None, Some(&a)), Decision::Local);
        assert_eq!(decide(Some(&a), Some(&b), None), Decision::Conflict);
    }
    #[test]
    fn external_vault_rejects_sync_before_network() {
        let d = tempfile::tempdir().unwrap();
        let core = Core::new(d.path().join("state")).unwrap();
        fs::create_dir(d.path().join("vault")).unwrap();
        let v = core.register(&d.path().join("vault")).unwrap();
        assert!(sync(&core, &v.id)
            .unwrap_err()
            .to_string()
            .contains("Externally managed"));
    }
    fn fixture() -> (tempfile::TempDir, Core, Vault) {
        let d = tempfile::tempdir().unwrap();
        let core = Core::new(d.path().join("data")).unwrap();
        fs::create_dir(d.path().join("notes")).unwrap();
        let v = core.register(&d.path().join("notes")).unwrap();
        core.update_config(|c| {
            c.vaults[0].github = Some(SyncConfig {
                repository: "owner/sticky-markers".into(),
                repository_id: 42,
                branch: "main".into(),
                frequency_minutes: 5,
                on_exit: true,
                paused: false,
                last_sync: None,
                baseline: BTreeMap::from([("n.md".into(), revision(b"base"))]),
                error: None,
                conflicts: vec![],
            });
            Ok(())
        })
        .unwrap();
        (d, core, v)
    }
    fn server(responses: Vec<(&'static str, Value)>) -> std::thread::JoinHandle<()> {
        use std::io::{BufRead, Read};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        TEST_API
            .with(|a| *a.borrow_mut() = Some(format!("http://{}", listener.local_addr().unwrap())));
        std::thread::spawn(move || {
            for (expected, value) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                assert!(line.starts_with(expected), "{line} expected {expected}");
                let mut length = 0;
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if line.to_lowercase().starts_with("content-length:") {
                        length = line
                            .split(':')
                            .nth(1)
                            .unwrap()
                            .trim()
                            .parse::<usize>()
                            .unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                if expected.starts_with("PATCH") {
                    let body: Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(body["force"], false);
                }
                let bytes = value.to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",bytes.len(),bytes).unwrap();
            }
        })
    }
    fn remote(content: &[u8]) -> Vec<(&'static str, Value)> {
        vec![
            (
                "GET /repos/owner/sticky-markers ",
                json!({"id":42,"private":true}),
            ),
            (
                "GET /repos/owner/sticky-markers/git/ref/heads/main ",
                json!({"object":{"sha":"head"}}),
            ),
            (
                "GET /repos/owner/sticky-markers/git/commits/head ",
                json!({"tree":{"sha":"tree"}}),
            ),
            (
                "GET /repos/owner/sticky-markers/git/trees/tree?recursive=1 ",
                json!({"truncated":false,"tree":[{"path":"n.md","type":"blob","sha":"blob","size":content.len()}]}),
            ),
            (
                "GET /repos/owner/sticky-markers/git/blobs/blob ",
                json!({"content":STANDARD.encode(content)}),
            ),
        ]
    }
    #[test]
    fn excluded_local_content_is_never_interpreted_as_deletion() {
        let (_d, c, v) = fixture();
        fs::write(
            Path::new(&v.path).join("n.md"),
            vec![b'x'; crate::NOTE_LIMIT + 1],
        )
        .unwrap();
        let server = server(remote(b"base"));
        assert!(sync(&c, &v.id)
            .unwrap_err()
            .to_string()
            .contains("both versions unchanged"));
        server.join().unwrap();
        assert_eq!(
            fs::metadata(Path::new(&v.path).join("n.md")).unwrap().len(),
            (crate::NOTE_LIMIT + 1) as u64
        );
        assert_eq!(
            c.vault(&v.id).unwrap().github.unwrap().baseline["n.md"],
            revision(b"base")
        );
    }
    #[test]
    fn arbitrary_text_extensions_are_synced_and_binary_files_are_skipped() {
        let (_d, _c, v) = fixture();
        for name in ["settings.json", "service.conf", "README"] {
            fs::write(Path::new(&v.path).join(name), "text").unwrap();
        }
        fs::write(Path::new(&v.path).join("binary.dat"), [0, 255]).unwrap();
        let files = local_files(Path::new(&v.path)).unwrap();
        assert_eq!(files.len(), 3);
        assert!(files.contains_key("service.conf"));
    }
    #[test]
    fn remote_only_edit_updates_disk_and_baseline() {
        let (_d, c, v) = fixture();
        c.create(&v.id, Some("n.md"), "base", None).unwrap();
        let server = server(remote(b"remote"));
        let out = sync(&c, &v.id).unwrap();
        server.join().unwrap();
        assert_eq!(c.read(&v.id, "n.md").unwrap().content, "remote");
        assert_eq!(out.github.unwrap().baseline["n.md"], revision(b"remote"));
    }
    #[test]
    fn conflicting_sync_preserves_both_versions() {
        let (_d, c, v) = fixture();
        c.create(&v.id, Some("n.md"), "local", None).unwrap();
        let server = server(remote(b"remote"));
        assert!(sync(&c, &v.id)
            .unwrap_err()
            .to_string()
            .contains("Sync conflict"));
        server.join().unwrap();
        assert_eq!(c.read(&v.id, "n.md").unwrap().content, "local");
        assert_eq!(
            c.vault(&v.id).unwrap().github.unwrap().conflicts,
            vec!["n.md"]
        );
        let copies = fs::read_dir(
            c.data
                .join("recovery")
                .join(revision(format!("{}/n.md", v.id).as_bytes())),
        )
        .unwrap()
        .filter_map(|e| fs::read(e.unwrap().path()).ok())
        .collect::<Vec<_>>();
        assert!(copies.contains(&b"local".to_vec()));
        assert!(copies.contains(&b"remote".to_vec()));
    }
    #[test]
    fn local_only_edit_creates_non_force_commit() {
        let (_d, c, v) = fixture();
        c.create(&v.id, Some("n.md"), "local", None).unwrap();
        let mut responses = remote(b"base");
        responses.extend([
            (
                "POST /repos/owner/sticky-markers/git/blobs ",
                json!({"sha":"newblob"}),
            ),
            (
                "POST /repos/owner/sticky-markers/git/trees ",
                json!({"sha":"newtree"}),
            ),
            (
                "POST /repos/owner/sticky-markers/git/commits ",
                json!({"sha":"newcommit"}),
            ),
            (
                "PATCH /repos/owner/sticky-markers/git/refs/heads/main ",
                json!({"object":{"sha":"newcommit"}}),
            ),
        ]);
        let server = server(responses);
        let out = sync(&c, &v.id).unwrap();
        server.join().unwrap();
        assert_eq!(out.github.unwrap().baseline["n.md"], revision(b"local"));
        assert_eq!(c.read(&v.id, "n.md").unwrap().content, "local");
    }
    #[test]
    fn registered_external_vault_cannot_be_converted() {
        let (d, c, _v) = fixture();
        assert!(validate_new_location(&c, &d.path().join("notes")).is_err());
        let folder = d.path().join("repo");
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join(".git"), "gitdir: elsewhere").unwrap();
        let nested = folder.join("notes");
        fs::create_dir(&nested).unwrap();
        assert!(validate_new_location(&c, &nested).is_err());
    }
    #[test]
    fn github_device_response_uses_snake_case() {
        let d:DeviceCode=serde_json::from_value(json!({"device_code":"test","user_code":"ABCD","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5})).unwrap();
        assert_eq!(serde_json::to_value(d).unwrap()["deviceCode"], "test");
    }
}
