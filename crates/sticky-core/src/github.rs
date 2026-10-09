//! GitHub Git Data API sync. No Git operations are performed on external vaults.
use crate::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

// These bounds apply before local changes or a remote commit. Payloads are staged on
// disk one at a time; no collection stores file contents.
const SYNC_FILE_LIMIT: u64 = 20 * 1024 * 1024;
const SYNC_VAULT_LIMIT: u64 = 256 * 1024 * 1024;
const SYNC_FILE_COUNT_LIMIT: usize = 10_000;
const API_METADATA_LIMIT: u64 = 4 * 1024 * 1024;
const API_BLOB_LIMIT: u64 = 29 * 1024 * 1024;
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
    /// Git object identities corresponding to the last successful baseline.
    /// Old configurations without this cache perform one bounded initial download.
    #[serde(default)]
    pub remote_blobs: BTreeMap<String, String>,
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
    serde_json::from_value(read_api_response(r, API_METADATA_LIMIT)?)
        .map_err(|e| message(e.to_string()))
}
pub fn poll_device(client_id: &str, device_code: &str) -> Result<Value> {
    let response = client()?
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .map_err(|e| message(e.to_string()))?;
    let v = read_api_response(response, API_METADATA_LIMIT)?;
    if let Some(t) = v["access_token"].as_str() {
        credential()?
            .set_password(t)
            .map_err(|e| message(format!("Cannot securely store GitHub credential: {e}")))?;
        return account();
    }
    Ok(json!({"pending":true,"error":v["error"],"description":v["error_description"]}))
}
fn read_api_response(response: reqwest::blocking::Response, limit: u64) -> Result<Value> {
    if response.content_length().is_some_and(|size| size > limit) {
        return Err(message(format!(
            "GitHub response exceeds the {} MiB safety limit",
            limit / 1024 / 1024
        )));
    }
    let mut bytes = Vec::new();
    response.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(message(format!(
            "GitHub response exceeds the {} MiB safety limit",
            limit / 1024 / 1024
        )));
    }
    serde_json::from_slice(&bytes).map_err(|e| message(e.to_string()))
}
fn api_with_limit(
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    limit: u64,
) -> Result<Value> {
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
    let v = read_api_response(r, limit)?;
    if !status.is_success() {
        return Err(message(format!(
            "GitHub {}: {}",
            status,
            v["message"].as_str().unwrap_or("request failed")
        )));
    }
    Ok(v)
}
fn api(method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
    api_with_limit(method, path, body, API_METADATA_LIMIT)
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
        remote_blobs: BTreeMap::new(),
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
            remote_blobs: BTreeMap::new(),
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
    if v.github.is_none() {
        return Err(message("This vault is externally managed"));
    }
    if !["local", "remote"].contains(&choice) {
        return Err(message("Choose local or remote explicitly"));
    }
    let _global_lock = core.lock("github-payload")?;
    let _sync_lock = core.lock(&format!("sync:{id}"))?;
    let v = core.vault(id)?;
    let cfg = v
        .github
        .ok_or_else(|| message("This vault is externally managed"))?;
    if !cfg.conflicts.iter().any(|p| p == path) {
        return Err(message("This file has no recorded sync conflict"));
    }
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
    let remote = api_with_limit(
        reqwest::Method::GET,
        &format!(
            "/repos/{}/contents/{}?ref={}",
            cfg.repository, encoded, cfg.branch
        ),
        None,
        API_BLOB_LIMIT,
    );
    let staging = tempfile::Builder::new()
        .prefix("github-conflict-")
        .tempdir_in(&core.data)?;
    let mut blob_sha = None;
    let bytes = match remote {
        Ok(value) => {
            let size = value["size"]
                .as_u64()
                .ok_or_else(|| message("Missing remote blob size"))?;
            if size > SYNC_FILE_LIMIT || (!attachment(path) && size > crate::NOTE_LIMIT as u64) {
                return Err(message("Remote conflict content exceeds its sync/editing size limit; both versions were kept unchanged"));
            }
            blob_sha = value["sha"].as_str().map(str::to_owned);
            // The contents endpoint omits encoded content for larger files.
            let blob = if value["encoding"] == "none" {
                let sha = blob_sha
                    .as_ref()
                    .ok_or_else(|| message("Missing remote blob SHA"))?;
                api_with_limit(
                    reqwest::Method::GET,
                    &format!("/repos/{}/git/blobs/{sha}", cfg.repository),
                    None,
                    API_BLOB_LIMIT,
                )?
            } else {
                value
            };
            let file = stage_blob(&blob, path, size, staging.path())?
                .ok_or_else(|| message("Remote conflict content is no longer editable text; both versions were kept unchanged"))?;
            Some(read_sync_file(&file.path, SYNC_FILE_LIMIT)?)
        }
        Err(e) if e.to_string().starts_with("GitHub 404") => None,
        Err(e) => return Err(e),
    };
    let _file_lock = core.lock(&p.to_string_lossy())?;
    if p.exists() {
        core.recovery(id, path, &read_sync_file(&p, SYNC_FILE_LIMIT)?)?;
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
        if let Some(sha) = &blob_sha {
            g.remote_blobs.insert(path.into(), sha.clone());
        } else {
            g.remote_blobs.remove(path);
        }
        g.conflicts.retain(|p| p != path);
        if g.conflicts.is_empty() {
            g.error = None;
        }
        Ok(())
    })?;
    core.vault(id)
}
#[derive(Debug)]
struct LocalFile {
    revision: String,
    size: u64,
    path: PathBuf,
}
#[derive(Debug)]
struct RemoteFile {
    revision: String,
    size: u64,
    sha: String,
    staged: Option<PathBuf>,
}
#[derive(Default)]
struct VaultBudget {
    files: usize,
    bytes: u64,
}
impl VaultBudget {
    fn add(&mut self, size: u64, side: &str) -> Result<()> {
        self.files += 1;
        self.bytes = self.bytes.saturating_add(size);
        if self.files > SYNC_FILE_COUNT_LIMIT || self.bytes > SYNC_VAULT_LIMIT {
            return Err(message(format!(
                "{side} GitHub vault exceeds the 10,000-file or 256 MiB sync safety limit; reduce this vault before retrying. No changes were applied."
            )));
        }
        Ok(())
    }
}
fn read_sync_file(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(message(format!(
            "{} grew beyond its sync size limit; retry after reducing it",
            path.display()
        )));
    }
    Ok(bytes)
}
fn local_files(root: &Path) -> Result<BTreeMap<String, LocalFile>> {
    let mut files = BTreeMap::new();
    let mut budget = VaultBudget::default();
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
        if !supported(&path) {
            continue;
        }
        let size = e.metadata().map_err(|e| message(e.to_string()))?.len();
        if !attachment(&path) && size > crate::NOTE_LIMIT as u64 {
            continue;
        }
        if size > SYNC_FILE_LIMIT {
            return Err(message(format!("{path} exceeds the 20 MiB sync limit")));
        }
        // Reject an aggregate excess using metadata before reading another payload.
        budget.add(size, "Local")?;
        let (hash, actual_size) = if attachment(&path) {
            let mut reader = File::open(e.path())?;
            let mut hasher = blake3::Hasher::new();
            let mut buffer = [0_u8; 64 * 1024];
            let mut total = 0_u64;
            loop {
                let n = reader.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                total += n as u64;
                if total > SYNC_FILE_LIMIT || total > size {
                    return Err(message(format!("{path} changed size during sync; retry")));
                }
                hasher.update(&buffer[..n]);
            }
            (hasher.finalize().to_hex().to_string(), total)
        } else {
            let bytes = read_sync_file(e.path(), crate::NOTE_LIMIT as u64)?;
            if !supported_data(&path, &bytes) {
                continue;
            }
            (revision(&bytes), bytes.len() as u64)
        };
        if actual_size != size {
            return Err(message(format!("{path} changed size during sync; retry")));
        }
        files.insert(
            path,
            LocalFile {
                revision: hash,
                size,
                path: e.path().into(),
            },
        );
    }
    Ok(files)
}
// GitHub wraps base64 content in newlines. Filter whitespace while decoding so
// a second full encoded copy is never allocated.
struct Base64Content<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl Read for Base64Content<'_> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let mut written = 0;
        while written < out.len() && self.offset < self.bytes.len() {
            let b = self.bytes[self.offset];
            self.offset += 1;
            if !b.is_ascii_whitespace() {
                out[written] = b;
                written += 1;
            }
        }
        Ok(written)
    }
}
fn stage_blob(value: &Value, path: &str, size: u64, staging: &Path) -> Result<Option<LocalFile>> {
    if value["encoding"].as_str().is_some_and(|e| e != "base64") {
        return Err(message("GitHub returned an unsupported blob encoding"));
    }
    let content = value["content"]
        .as_str()
        .ok_or_else(|| message("Missing blob content"))?;
    let source = Base64Content {
        bytes: content.as_bytes(),
        offset: 0,
    };
    let mut reader = base64::read::DecoderReader::new(source, &STANDARD);
    let mut file = tempfile::NamedTempFile::new_in(staging)?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let n = reader
            .read(&mut buffer)
            .map_err(|e| message(format!("Invalid GitHub blob: {e}")))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > size || total > SYNC_FILE_LIMIT {
            return Err(message(format!(
                "Remote {path} exceeds its declared sync size; both versions were kept unchanged"
            )));
        }
        file.write_all(&buffer[..n])?;
        hasher.update(&buffer[..n]);
    }
    if total != size {
        return Err(message(format!(
            "Remote {path} does not match its declared size; both versions were kept unchanged"
        )));
    }
    if !attachment(path)
        && !supported_data(
            path,
            &read_sync_file(file.path(), crate::NOTE_LIMIT as u64)?,
        )
    {
        return Ok(None);
    }
    let (_, staged) = file.keep().map_err(|e| message(e.to_string()))?;
    Ok(Some(LocalFile {
        revision: hasher.finalize().to_hex().to_string(),
        size,
        path: staged,
    }))
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
    // Reject external vaults before credentials, network, or vault mutations.
    if core.vault(id)?.github.is_none() {
        return Err(message(
            "Externally managed vault: Sticky Markers never syncs this repository",
        ));
    }
    // A shared file lock bounds payload allocations across managed vaults and
    // processes. Commands run on workers, so waiting does not block the UI thread.
    let _global_lock = core.lock("github-payload")?;
    let _lock = core.lock(&format!("sync:{id}"))?;
    // Another queued operation may have updated the baseline while we waited.
    let v = core.vault(id)?;
    let cfg = v
        .github
        .clone()
        .ok_or_else(|| message("This vault is externally managed"))?;
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
    if cfg.baseline.len() > SYNC_FILE_COUNT_LIMIT || cfg.remote_blobs.len() > SYNC_FILE_COUNT_LIMIT
    {
        return Err(message(
            "Saved GitHub baseline exceeds the 10,000-file sync safety limit",
        ));
    }
    let local = local_files(Path::new(&v.path))?;
    let mut remote_metadata = BTreeMap::new();
    let mut budget = VaultBudget::default();
    // Validate the entire tree's bounds before downloading any payload. Missing
    // sizes cannot bypass the budget; duplicate paths are also rejected.
    for item in tree["tree"]
        .as_array()
        .ok_or_else(|| message("Missing remote file list"))?
    {
        let path = item["path"].as_str().unwrap_or("");
        if item["type"] != "blob" || !supported(path) {
            continue;
        }
        core.resolve(&v.id, path)?;
        let size = item["size"]
            .as_u64()
            .ok_or_else(|| message("Missing remote blob size"))?;
        if !attachment(path) && size > crate::NOTE_LIMIT as u64 {
            if cfg.baseline.contains_key(path) {
                return Err(message(format!(
                    "Synced {path} exceeds the editing limit; both versions are kept unchanged"
                )));
            }
            continue;
        }
        if size > SYNC_FILE_LIMIT {
            return Err(message(format!(
                "Remote {path} exceeds the 20 MiB sync limit"
            )));
        }
        budget.add(size, "Remote")?;
        let blob_sha = item["sha"]
            .as_str()
            .ok_or_else(|| message("Missing blob SHA"))?;
        if remote_metadata
            .insert(path.to_owned(), (size, blob_sha.to_owned()))
            .is_some()
        {
            return Err(message("GitHub returned duplicate file paths"));
        }
    }
    // The directory is outside vaults and is removed on every success/error.
    let staging = tempfile::Builder::new()
        .prefix("github-sync-")
        .tempdir_in(&core.data)?;
    let mut remote = BTreeMap::new();
    for (path, (size, blob_sha)) in remote_metadata {
        if cfg.remote_blobs.get(&path) == Some(&blob_sha) {
            if let Some(hash) = cfg.baseline.get(&path) {
                remote.insert(
                    path,
                    RemoteFile {
                        revision: hash.clone(),
                        size,
                        sha: blob_sha,
                        staged: None,
                    },
                );
                continue;
            }
        }
        let blob = api_with_limit(
            reqwest::Method::GET,
            &format!("/repos/{}/git/blobs/{blob_sha}", cfg.repository),
            None,
            API_BLOB_LIMIT,
        )?;
        if let Some(file) = stage_blob(&blob, &path, size, staging.path())? {
            remote.insert(
                path,
                RemoteFile {
                    revision: file.revision,
                    size,
                    sha: blob_sha,
                    staged: Some(file.path),
                },
            );
        } else if cfg.baseline.contains_key(&path) {
            return Err(message(format!(
                "Synced {path} is no longer editable text; both versions are kept unchanged"
            )));
        }
    }
    for path in cfg.baseline.keys().chain(remote.keys()) {
        if !local.contains_key(path) && core.resolve(&v.id, path)?.exists() {
            return Err(message(format!("Local {path} is too large or is not editable text; sync left both versions unchanged")));
        }
    }
    let paths = cfg
        .baseline
        .keys()
        .chain(local.keys())
        .chain(remote.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    // These maps contain hashes, sizes and blob identifiers only.
    let mut baseline = remote
        .iter()
        .map(|(p, f)| (p.clone(), f.revision.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut merged_sizes = remote
        .iter()
        .map(|(p, f)| (p.clone(), f.size))
        .collect::<BTreeMap<_, _>>();
    let mut remote_blobs = remote
        .iter()
        .map(|(p, f)| (p.clone(), f.sha.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut outgoing = Vec::new();
    let mut incoming = Vec::new();
    let mut conflicts = Vec::new();
    for p in paths {
        let lh = local.get(&p).map(|f| &f.revision);
        let rh = remote.get(&p).map(|f| &f.revision);
        match decide(cfg.baseline.get(&p), lh, rh) {
            Decision::Local => {
                if let Some(file) = local.get(&p) {
                    baseline.insert(p.clone(), file.revision.clone());
                    merged_sizes.insert(p.clone(), file.size);
                } else {
                    baseline.remove(&p);
                    merged_sizes.remove(&p);
                    remote_blobs.remove(&p);
                }
                outgoing.push(p);
            }
            Decision::Remote => incoming.push(p),
            Decision::Same => {}
            Decision::Conflict => conflicts.push(p),
        }
    }
    let mut merged_budget = VaultBudget::default();
    for size in merged_sizes.values() {
        merged_budget.add(*size, "Merged")?;
    }
    if !conflicts.is_empty() {
        for p in &conflicts {
            if let Some(file) = remote.get(p) {
                let staged = file
                    .staged
                    .as_ref()
                    .ok_or_else(|| message("Missing staged conflict content"))?;
                core.recovery(&v.id, p, &read_sync_file(staged, SYNC_FILE_LIMIT)?)?;
            }
            if let Some(file) = local.get(p) {
                core.recovery(&v.id, p, &read_sync_file(&file.path, SYNC_FILE_LIMIT)?)?;
            }
        }
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
    if !outgoing.is_empty() {
        let mut changes = Vec::new();
        for p in outgoing {
            if let Some(file) = local.get(&p) {
                let bytes = read_sync_file(&file.path, SYNC_FILE_LIMIT)?;
                if revision(&bytes) != file.revision {
                    return Err(message(format!(
                        "{p} changed during sync. Local edits were preserved; retry."
                    )));
                }
                let blob = api(
                    reqwest::Method::POST,
                    &format!("/repos/{}/git/blobs", cfg.repository),
                    Some(json!({"content":STANDARD.encode(&bytes),"encoding":"base64"})),
                )?;
                let blob_sha = blob["sha"]
                    .as_str()
                    .ok_or_else(|| message("Missing uploaded blob SHA"))?;
                remote_blobs.insert(p.clone(), blob_sha.to_owned());
                changes.push(json!({"path":p,"mode":"100644","type":"blob","sha":blob_sha}));
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
    // Apply only after all bounds/conflicts and the non-force commit succeeded.
    // Fresh per-file checks continue to preserve edits made during network calls.
    for p in incoming {
        let dest = core.resolve(&v.id, &p)?;
        let _file_lock = core.lock(&dest.to_string_lossy())?;
        let current = if dest.exists() {
            Some(read_sync_file(&dest, SYNC_FILE_LIMIT)?)
        } else {
            None
        };
        if current.as_ref().map(|b| revision(b)).as_ref() != local.get(&p).map(|f| &f.revision) {
            return Err(message(format!(
                "{p} changed during sync. Local edits were preserved; retry."
            )));
        }
        if let Some(b) = &current {
            core.recovery(&v.id, &p, b)?;
        }
        if let Some(file) = remote.get(&p) {
            let staged = file
                .staged
                .as_ref()
                .ok_or_else(|| message("Missing staged remote content"))?;
            atomic_write(&dest, &read_sync_file(staged, SYNC_FILE_LIMIT)?)?;
        } else if dest.exists() {
            fs::remove_file(&dest)?;
        }
    }
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
        g.remote_blobs = remote_blobs;
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
                remote_blobs: BTreeMap::new(),
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
    fn unchanged_sync_uses_blob_identities_without_downloading_contents() {
        let (_d, c, v) = fixture();
        c.create(&v.id, Some("n.md"), "base", None).unwrap();
        let first = server(remote(b"base"));
        let synced = sync(&c, &v.id).unwrap();
        first.join().unwrap();
        assert_eq!(synced.github.as_ref().unwrap().remote_blobs["n.md"], "blob");
        // A download request would fail against this four-request fixture.
        let mut unchanged = remote(b"base");
        unchanged.pop();
        let second = server(unchanged);
        sync(&c, &v.id).unwrap();
        second.join().unwrap();
        assert_eq!(c.read(&v.id, "n.md").unwrap().content, "base");
    }
    #[test]
    fn cached_remote_identity_still_uploads_new_local_changes() {
        let (_d, c, v) = fixture();
        c.create(&v.id, Some("n.md"), "local", None).unwrap();
        c.update_config(|cfg| {
            cfg.vaults[0]
                .github
                .as_mut()
                .unwrap()
                .remote_blobs
                .insert("n.md".into(), "blob".into());
            Ok(())
        })
        .unwrap();
        let mut responses = remote(b"base");
        responses.pop();
        responses.extend([
            (
                "POST /repos/owner/sticky-markers/git/blobs ",
                json!({"sha":"updated"}),
            ),
            (
                "POST /repos/owner/sticky-markers/git/trees ",
                json!({"sha":"updatedtree"}),
            ),
            (
                "POST /repos/owner/sticky-markers/git/commits ",
                json!({"sha":"updatedcommit"}),
            ),
            (
                "PATCH /repos/owner/sticky-markers/git/refs/heads/main ",
                json!({"object":{"sha":"updatedcommit"}}),
            ),
        ]);
        let server = server(responses);
        let synced = sync(&c, &v.id).unwrap();
        server.join().unwrap();
        let cfg = synced.github.unwrap();
        assert_eq!(cfg.baseline["n.md"], revision(b"local"));
        assert_eq!(cfg.remote_blobs["n.md"], "updated");
    }
    #[test]
    fn remote_aggregate_budget_is_checked_before_blobs_or_changes() {
        let (_d, c, v) = fixture();
        c.create(&v.id, Some("n.md"), "base", None).unwrap();
        let mut responses = remote(b"base");
        responses.pop();
        responses[3].1["tree"] = json!((0..14).map(|i| json!({
            "path":format!("asset{i}.png"),"type":"blob","sha":format!("sha{i}"),"size":SYNC_FILE_LIMIT
        })).collect::<Vec<_>>());
        let server = server(responses);
        assert!(sync(&c, &v.id).unwrap_err().to_string().contains("256 MiB"));
        server.join().unwrap();
        assert_eq!(c.read(&v.id, "n.md").unwrap().content, "base");
        assert_eq!(
            c.vault(&v.id).unwrap().github.unwrap().baseline["n.md"],
            revision(b"base")
        );
        assert_eq!(fs::read_dir(&v.path).unwrap().count(), 1);
    }
    #[test]
    fn sync_rejects_lying_blob_sizes_and_cleans_staging() {
        let (_d, c, v) = fixture();
        c.create(&v.id, Some("n.md"), "base", None).unwrap();
        let mut responses = remote(b"remote");
        responses[3].1["tree"][0]["size"] = json!(1);
        let server = server(responses);
        assert!(sync(&c, &v.id)
            .unwrap_err()
            .to_string()
            .contains("declared sync size"));
        server.join().unwrap();
        assert_eq!(c.read(&v.id, "n.md").unwrap().content, "base");
        assert!(!fs::read_dir(&c.data).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("github-sync-")));
    }
    #[test]
    fn api_response_limits_apply_to_streams_without_content_length() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).unwrap();
            let body = json!({"message":"x".repeat(256)}).to_string();
            // Connection-delimited response deliberately has no declared length.
            write!(stream, "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{body}").unwrap();
        });
        let response = client()
            .unwrap()
            .get(format!("http://{addr}"))
            .send()
            .unwrap();
        assert!(read_api_response(response, 128)
            .unwrap_err()
            .to_string()
            .contains("safety limit"));
        server.join().unwrap();
    }
    #[test]
    fn base64_whitespace_is_decoded_without_copying_an_encoded_vault() {
        let d = tempfile::tempdir().unwrap();
        let value = json!({"encoding":"base64","content":"cmVt\nb3Rl\r\n"});
        let file = stage_blob(&value, "n.md", 6, d.path()).unwrap().unwrap();
        assert_eq!(fs::read(file.path).unwrap(), b"remote");
        assert_eq!(file.revision, revision(b"remote"));
    }
    #[test]
    fn conflict_resolution_bounds_content_and_updates_the_blob_cache() {
        let (_d, c, v) = fixture();
        c.create(&v.id, Some("n.md"), "local", None).unwrap();
        c.update_config(|cfg| {
            cfg.vaults[0].github.as_mut().unwrap().conflicts = vec!["n.md".into()];
            Ok(())
        })
        .unwrap();
        let server = server(vec![
            (
                "GET /repos/owner/sticky-markers ",
                json!({"id":42,"private":true}),
            ),
            (
                "GET /repos/owner/sticky-markers/contents/n.md?ref=main ",
                json!({"size":6,"encoding":"none","sha":"changed"}),
            ),
            (
                "GET /repos/owner/sticky-markers/git/blobs/changed ",
                json!({"encoding":"base64","content":STANDARD.encode(b"remote")}),
            ),
        ]);
        let updated = resolve_conflict(&c, &v.id, "n.md", "remote").unwrap();
        server.join().unwrap();
        assert_eq!(c.read(&v.id, "n.md").unwrap().content, "remote");
        assert_eq!(updated.github.unwrap().remote_blobs["n.md"], "changed");
    }
    #[test]
    fn aggregate_budgets_bound_both_bytes_and_file_counts() {
        let mut bytes = VaultBudget::default();
        bytes.add(SYNC_VAULT_LIMIT, "Merged").unwrap();
        assert!(bytes.add(1, "Merged").is_err());
        let mut count = VaultBudget::default();
        for _ in 0..SYNC_FILE_COUNT_LIMIT {
            count.add(0, "Local").unwrap();
        }
        assert!(count.add(0, "Local").is_err());
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
