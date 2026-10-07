pub mod github;
pub mod update;

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use walkdir::WalkDir;

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Message(String),
    #[error(
        "Conflict: the file changed. Your edit was preserved in recovery. Reread before saving."
    )]
    Conflict,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
}
pub fn message(s: impl Into<String>) -> Error {
    Error::Message(s.into())
}
/// Read-only repository detection, including linked worktree markers. Empty
/// placeholder .git directories are not initialized Git repositories.
pub fn has_git_ancestor(path: &Path) -> bool {
    path.ancestors().any(|p| {
        let marker = p.join(".git");
        if marker.is_file() {
            return fs::read_to_string(marker)
                .map(|s| s.trim_start().starts_with("gitdir:"))
                .unwrap_or(true);
        }
        if marker.is_dir() {
            return marker.join("HEAD").exists()
                || fs::read_dir(marker)
                    .map(|mut entries| entries.next().is_some())
                    .unwrap_or(true);
        }
        false
    })
}
pub fn revision(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
pub fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub github: Option<github::SyncConfig>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub width: f64,
    pub height: f64,
    pub mode: String,
    pub appearance: String,
    pub palette: String,
    pub color: usize,
    pub font: String,
    pub font_size: f64,
    pub github_client_id: String,
    pub check_updates: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            width: 380.0,
            height: 440.0,
            mode: "edit".into(),
            appearance: "system".into(),
            palette: "classic".into(),
            color: 0,
            font: "sans".into(),
            font_size: 16.0,
            github_client_id: option_env!("STICKY_GITHUB_CLIENT_ID").unwrap_or("").into(),
            check_updates: true,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteStyle {
    pub palette: String,
    pub color: usize,
    pub font: String,
    pub font_size: f64,
    pub mode: String,
    pub open: bool,
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
}
impl Default for NoteStyle {
    fn default() -> Self {
        let s = Settings::default();
        Self {
            palette: s.palette,
            color: s.color,
            font: s.font,
            font_size: s.font_size,
            mode: s.mode,
            open: false,
            width: s.width,
            height: s.height,
            x: None,
            y: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub vaults: Vec<Vault>,
    pub active_vault: Option<String>,
    pub settings: Settings,
    pub styles: BTreeMap<String, NoteStyle>,
    pub recent: Vec<NoteRef>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteRef {
    pub vault_id: String,
    pub path: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub vault_id: String,
    pub path: String,
    pub title: String,
    pub preview: String,
    pub modified: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub vault_id: String,
    pub path: String,
    pub content: String,
    pub revision: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub complete: bool,
    pub fingerprint: String,
    pub document: Document,
}

#[derive(Clone)]
pub struct Core {
    pub data: PathBuf,
}
impl Core {
    pub fn new(data: PathBuf) -> Result<Self> {
        fs::create_dir_all(data.join("locks"))?;
        fs::create_dir_all(data.join("recovery"))?;
        fs::create_dir_all(data.join("requests"))?;
        Ok(Self { data })
    }
    pub fn default_location() -> PathBuf {
        std::env::var_os("STICKY_MARKERS_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::data_local_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join("sticky-markers")
            })
    }
    pub fn lock(&self, key: &str) -> Result<File> {
        let f = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.data.join("locks").join(revision(key.as_bytes())))?;
        f.lock_exclusive()?;
        Ok(f)
    }
    pub fn config(&self) -> Result<Config> {
        let _lock = self.lock("configuration")?;
        self.read_config()
    }
    fn read_config(&self) -> Result<Config> {
        match fs::read(self.data.join("settings.json")) {
            Ok(b) => Ok(serde_json::from_slice(&b)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(e.into()),
        }
    }
    pub fn update_config<T>(&self, f: impl FnOnce(&mut Config) -> Result<T>) -> Result<T> {
        let _lock = self.lock("configuration")?;
        let mut c = self.read_config()?;
        let out = f(&mut c)?;
        atomic_write(
            &self.data.join("settings.json"),
            &serde_json::to_vec_pretty(&c)?,
        )?;
        Ok(out)
    }
    pub fn vault(&self, id: &str) -> Result<Vault> {
        self.config()?
            .vaults
            .into_iter()
            .find(|v| v.id == id)
            .ok_or_else(|| message("Unknown or unregistered vault"))
    }
    pub fn register(&self, path: &Path) -> Result<Vault> {
        let root = fs::canonicalize(path)?;
        if !root.is_dir() {
            return Err(message("Choose a folder"));
        }
        self.update_config(|c| {
            if let Some(v) = c.vaults.iter().find(|v| Path::new(&v.path) == root) {
                c.active_vault = Some(v.id.clone());
                return Ok(v.clone());
            }
            if c.vaults
                .iter()
                .any(|v| root.starts_with(&v.path) || Path::new(&v.path).starts_with(&root))
            {
                return Err(message(
                    "This folder overlaps a registered vault; select its existing vault instead",
                ));
            }
            let v = Vault {
                id: uuid::Uuid::new_v4().to_string(),
                name: root
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into(),
                path: root.to_string_lossy().into(),
                github: None,
            };
            c.active_vault = Some(v.id.clone());
            c.vaults.push(v.clone());
            Ok(v)
        })
    }
    pub fn resolve(&self, vault_id: &str, relative: &str) -> Result<PathBuf> {
        let v = self.vault(vault_id)?;
        safe_path(Path::new(&v.path), relative)
    }
    fn note_path(&self, id: &str, relative: &str) -> Result<PathBuf> {
        if !relative.to_lowercase().ends_with(".md") {
            return Err(message("Notes must be Markdown (.md) files"));
        }
        self.resolve(id, relative)
    }
    pub fn list(&self, id: &str) -> Result<Vec<Note>> {
        let v = self.vault(id)?;
        if !Path::new(&v.path).is_dir() {
            return Err(message("Vault folder is unavailable"));
        }
        let mut notes = Vec::new();
        for entry in WalkDir::new(&v.path)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
        {
            let e = entry.map_err(|e| message(e.to_string()))?;
            if !e.file_type().is_file()
                || e.path()
                    .extension()
                    .map(|s| s.to_string_lossy().to_lowercase())
                    != Some("md".into())
            {
                continue;
            }
            let relative = e
                .path()
                .strip_prefix(&v.path)
                .map_err(|e| message(e.to_string()))?
                .to_string_lossy()
                .replace('\\', "/");
            let content = fs::read_to_string(e.path())?;
            let body = strip_frontmatter(&content);
            let title = body
                .lines()
                .find(|l| !l.trim().is_empty())
                .map(|l| {
                    l.trim()
                        .trim_start_matches('#')
                        .trim()
                        .chars()
                        .take(100)
                        .collect()
                })
                .unwrap_or_else(|| {
                    e.path()
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into()
                });
            notes.push(Note {
                vault_id: id.into(),
                path: relative,
                title,
                preview: body
                    .lines()
                    .take(5)
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(220)
                    .collect(),
                modified: e
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            });
        }
        notes.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.path.cmp(&b.path)));
        Ok(notes)
    }
    pub fn read(&self, id: &str, path: &str) -> Result<Document> {
        let p = self.note_path(id, path)?;
        let bytes = fs::read(p)?;
        if bytes.len() > 10 * 1024 * 1024 {
            return Err(message("Note exceeds the 10 MiB editing limit"));
        }
        let rev = revision(&bytes);
        let content =
            String::from_utf8(bytes).map_err(|_| message("This note is not valid UTF-8"))?;
        Ok(Document {
            vault_id: id.into(),
            path: path.into(),
            content,
            revision: rev,
        })
    }
    pub fn search(&self, id: &str, query: &str) -> Result<Vec<Note>> {
        let q = query.to_lowercase();
        let mut out = Vec::new();
        for note in self.list(id)? {
            if q.is_empty()
                || note.path.to_lowercase().contains(&q)
                || self
                    .read(id, &note.path)?
                    .content
                    .to_lowercase()
                    .contains(&q)
            {
                out.push(note);
            }
        }
        Ok(out)
    }
    pub fn recovery(&self, id: &str, path: &str, bytes: &[u8]) -> Result<PathBuf> {
        let _lock = self.lock(&format!("recovery:{id}/{path}"))?;
        let dir = self
            .data
            .join("recovery")
            .join(revision(format!("{id}/{path}").as_bytes()));
        fs::create_dir_all(&dir)?;
        atomic_write(
            &dir.join("metadata.json"),
            &serde_json::to_vec_pretty(&serde_json::json!({"vaultId":id,"path":path}))?,
        )?;
        let dest = dir.join(format!("{}-{}.md", timestamp(), uuid::Uuid::new_v4()));
        atomic_write(&dest, bytes)?;
        let mut entries = fs::read_dir(&dir)?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|s| s == "md"))
            .collect::<Vec<_>>();
        entries.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
        for e in entries.iter().take(entries.len().saturating_sub(30)) {
            fs::remove_file(e.path())?;
        }
        Ok(dest)
    }
    pub fn journal(&self, id: &str, path: &str, content: &str) -> Result<()> {
        self.note_path(id, path)?;
        self.recovery(id, path, content.as_bytes())?;
        Ok(())
    }
    pub fn create(
        &self,
        id: &str,
        path: Option<&str>,
        content: &str,
        request: Option<&str>,
    ) -> Result<Document> {
        validate_content(content)?;
        let relative = path.map(str::to_owned).unwrap_or_else(|| {
            if let Some(request) = request {
                format!("Note-{}.md", &revision(request.as_bytes())[..24])
            } else {
                format!(
                    "Note-{}-{}.md",
                    timestamp(),
                    &uuid::Uuid::new_v4().to_string()[..8]
                )
            }
        });
        let fingerprint = revision(format!("create:{id}:{path:?}:{content}").as_bytes());
        let _req = self.lock(&format!(
            "request:{}",
            request.unwrap_or(&uuid::Uuid::new_v4().to_string())
        ))?;
        if let Some(d) = self.receipt(request, &fingerprint)? {
            return Ok(d);
        }
        let p = self.note_path(id, &relative)?;
        let _lock = self.lock(&p.to_string_lossy())?;
        if p.exists() {
            return Err(message("A note already exists at that path"));
        }
        let d = Document {
            vault_id: id.into(),
            path: relative.clone(),
            content: content.into(),
            revision: revision(content.as_bytes()),
        };
        self.store_receipt_state(request, &fingerprint, &d, false)?;
        fs::create_dir_all(p.parent().unwrap())?;
        let mut file = tempfile::NamedTempFile::new_in(p.parent().unwrap())?;
        file.write_all(content.as_bytes())?;
        file.as_file().sync_all()?;
        file.persist_noclobber(&p).map_err(|e| Error::Io(e.error))?;
        sync_parent(&p)?;
        self.store_receipt(request, &fingerprint, &d)?;
        Ok(d)
    }
    pub fn save(
        &self,
        id: &str,
        path: &str,
        expected: &str,
        content: &str,
        request: Option<&str>,
    ) -> Result<Document> {
        validate_content(content)?;
        let fingerprint = revision(format!("save:{id}:{path}:{expected}:{content}").as_bytes());
        let _req = self.lock(&format!(
            "request:{}",
            request.unwrap_or(&uuid::Uuid::new_v4().to_string())
        ))?;
        if let Some(d) = self.receipt(request, &fingerprint)? {
            return Ok(d);
        }
        let p = self.note_path(id, path)?;
        let _lock = self.lock(&p.to_string_lossy())?;
        let old = match fs::read(&p) {
            Ok(b) => b,
            Err(e) => {
                self.recovery(id, path, content.as_bytes())?;
                return Err(e.into());
            }
        };
        if revision(&old) != expected {
            self.recovery(id, path, content.as_bytes())?;
            return Err(Error::Conflict);
        }
        let d = Document {
            vault_id: id.into(),
            path: path.into(),
            content: content.into(),
            revision: revision(content.as_bytes()),
        };
        self.store_receipt_state(request, &fingerprint, &d, false)?;
        if old != content.as_bytes() {
            self.recovery(id, path, &old)?;
            self.recovery(id, path, content.as_bytes())?;
            atomic_write(&p, content.as_bytes())?;
        }
        self.store_receipt(request, &fingerprint, &d)?;
        Ok(d)
    }
    pub fn append(
        &self,
        id: &str,
        path: &str,
        expected: &str,
        text: &str,
        request: &str,
    ) -> Result<Document> {
        let fingerprint = revision(format!("append:{id}:{path}:{expected}:{text}").as_bytes());
        let _req = self.lock(&format!("request:{request}"))?;
        if let Some(d) = self.receipt(Some(request), &fingerprint)? {
            return Ok(d);
        }
        let d = self.read(id, path)?;
        if d.revision != expected {
            return Err(Error::Conflict);
        }
        let content = format!("{}{}", d.content, text);
        validate_content(&content)?;
        let pending = Document {
            vault_id: id.into(),
            path: path.into(),
            revision: revision(content.as_bytes()),
            content,
        };
        self.store_receipt_state(Some(request), &fingerprint, &pending, false)?;
        let out = self.save(id, path, expected, &format!("{}{}", d.content, text), None)?;
        self.store_receipt(Some(request), &fingerprint, &out)?;
        Ok(out)
    }
    fn receipt_path(&self, key: &str) -> Result<PathBuf> {
        if key.is_empty() || key.len() > 128 {
            return Err(message("Request ID must be 1–128 characters"));
        }
        Ok(self
            .data
            .join("requests")
            .join(format!("{}.json", revision(key.as_bytes()))))
    }
    fn receipt(&self, request: Option<&str>, fingerprint: &str) -> Result<Option<Document>> {
        let Some(key) = request else {
            return Ok(None);
        };
        let p = self.receipt_path(key)?;
        let mut receipt: Receipt = match fs::read(&p) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        if receipt.fingerprint != fingerprint {
            return Err(message(
                "Request ID was already used for a different operation",
            ));
        }
        if !receipt.complete {
            let d = &receipt.document;
            if self
                .read(&d.vault_id, &d.path)
                .map(|n| n.revision == d.revision)
                .unwrap_or(false)
            {
                receipt.complete = true;
                atomic_write(&p, &serde_json::to_vec(&receipt)?)?;
            } else {
                return Ok(None);
            }
        }
        Ok(Some(receipt.document))
    }
    fn store_receipt(&self, request: Option<&str>, fingerprint: &str, d: &Document) -> Result<()> {
        self.store_receipt_state(request, fingerprint, d, true)
    }
    fn store_receipt_state(
        &self,
        request: Option<&str>,
        fingerprint: &str,
        d: &Document,
        complete: bool,
    ) -> Result<()> {
        if let Some(key) = request {
            let p = self.receipt_path(key)?;
            atomic_write(
                &p,
                &serde_json::to_vec(&Receipt {
                    fingerprint: fingerprint.into(),
                    document: d.clone(),
                    complete,
                })?,
            )?;
            if complete {
                let _lock = self.lock("receipt-retention")?;
                let mut files = fs::read_dir(self.data.join("requests"))?
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().extension().is_some_and(|s| s == "json"))
                    .collect::<Vec<_>>();
                files.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
                let mut count = files.len();
                let mut size = files
                    .iter()
                    .filter_map(|e| e.metadata().ok())
                    .map(|m| m.len())
                    .sum::<u64>();
                for f in files {
                    if count <= 512 && size <= 32 * 1024 * 1024 {
                        break;
                    }
                    if f.path() == p {
                        continue;
                    }
                    let r: Receipt = serde_json::from_slice(&fs::read(f.path())?)?;
                    if !r.complete {
                        continue;
                    }
                    size = size.saturating_sub(f.metadata()?.len());
                    fs::remove_file(f.path())?;
                    count -= 1;
                }
            }
        }
        Ok(())
    }
    pub fn delete(&self, id: &str, path: &str, expected: &str) -> Result<()> {
        let p = self.note_path(id, path)?;
        let _lock = self.lock(&p.to_string_lossy())?;
        let bytes = fs::read(&p)?;
        if revision(&bytes) != expected {
            return Err(Error::Conflict);
        }
        self.recovery(id, path, &bytes)?;
        if trash::delete(&p).is_err() {
            fs::remove_file(&p)?;
        }
        self.update_config(|c| {
            c.styles.remove(&format!("{id}/{path}"));
            c.recent.retain(|n| n.vault_id != id || n.path != path);
            Ok(())
        })?;
        Ok(())
    }
    pub fn rename(&self, id: &str, path: &str, new_path: &str, expected: &str) -> Result<Document> {
        let source = self.note_path(id, path)?;
        let _lock = self.lock(&source.to_string_lossy())?;
        let d = self.read(id, path)?;
        if d.revision != expected {
            return Err(Error::Conflict);
        }
        if path == new_path {
            return Ok(d);
        }
        let new = self.create(id, Some(new_path), &d.content, None)?;
        if revision(&fs::read(&source)?) != expected {
            return Err(Error::Conflict);
        }
        self.recovery(id, path, d.content.as_bytes())?;
        fs::remove_file(source)?;
        self.update_config(|c| {
            if let Some(style) = c.styles.remove(&format!("{id}/{path}")) {
                c.styles.insert(format!("{id}/{new_path}"), style);
            }
            for n in &mut c.recent {
                if n.vault_id == id && n.path == path {
                    n.path = new_path.into();
                }
            }
            Ok(())
        })?;
        Ok(new)
    }
    pub fn style(&self, id: &str, path: &str) -> Result<NoteStyle> {
        let c = self.config()?;
        Ok(c.styles
            .get(&format!("{id}/{path}"))
            .cloned()
            .unwrap_or_else(|| NoteStyle {
                palette: c.settings.palette,
                color: c.settings.color,
                font: c.settings.font,
                font_size: c.settings.font_size,
                mode: c.settings.mode,
                width: c.settings.width,
                height: c.settings.height,
                ..NoteStyle::default()
            }))
    }
    pub fn set_style(&self, id: &str, path: &str, style: NoteStyle) -> Result<()> {
        self.note_path(id, path)?;
        self.update_config(|c| {
            c.styles.insert(format!("{id}/{path}"), style);
            Ok(())
        })
    }
    pub fn opened(&self, id: &str, path: &str, open: bool) -> Result<()> {
        self.note_path(id, path)?;
        let mut s = self.style(id, path)?;
        s.open = open;
        self.update_config(|c| {
            c.styles.insert(format!("{id}/{path}"), s);
            if open {
                c.recent.retain(|n| n.vault_id != id || n.path != path);
                c.recent.insert(
                    0,
                    NoteRef {
                        vault_id: id.into(),
                        path: path.into(),
                    },
                );
                c.recent.truncate(50);
            }
            Ok(())
        })
    }
}
pub fn strip_frontmatter(content: &str) -> &str {
    if content.starts_with("---\n") || content.starts_with("---\r\n") {
        let mut pos = content.find('\n').unwrap() + 1;
        for line in content[pos..].split_inclusive('\n') {
            pos += line.len();
            if line.trim() == "---" {
                return &content[pos..];
            }
        }
    }
    content
}
pub fn safe_path(root: &Path, relative: &str) -> Result<PathBuf> {
    if fs::symlink_metadata(root)?.file_type().is_symlink() {
        return Err(message(
            "Vault root changed to a symlink; reselect its real folder",
        ));
    }
    let base = fs::canonicalize(root)?;
    let path = Path::new(relative);
    if relative.is_empty()
        || relative.contains('\\')
        || relative.chars().any(|c| c.is_control())
        || path.is_absolute()
    {
        return Err(message("Use a vault-relative path"));
    }
    let mut out = base;
    for part in path.components() {
        match part {
            Component::Normal(name) => {
                if name.to_string_lossy().starts_with('.') || name.to_string_lossy().contains(':') {
                    return Err(message("Hidden or reserved paths are not notes"));
                }
                out.push(name);
                if let Ok(m) = fs::symlink_metadata(&out) {
                    if m.file_type().is_symlink() {
                        return Err(message("Symlinks are not followed inside vaults"));
                    }
                }
            }
            _ => return Err(message("Path must stay inside its vault")),
        }
    }
    Ok(out)
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or_else(|| message("Path has no parent"))?;
    fs::create_dir_all(parent)?;
    let mut f = tempfile::NamedTempFile::new_in(parent)?;
    if let Ok(m) = fs::metadata(path) {
        f.as_file().set_permissions(m.permissions())?;
    }
    f.write_all(bytes)?;
    f.as_file().sync_all()?;
    f.persist(path).map_err(|e| Error::Io(e.error))?;
    sync_parent(path)?;
    Ok(())
}
fn sync_parent(_path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(_path.parent().unwrap())?.sync_all()?;
    Ok(())
}

fn validate_content(content: &str) -> Result<()> {
    if content.len() > 10 * 1024 * 1024 {
        Err(message("Note exceeds the 10 MiB editing limit"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Core, Vault) {
        let d = tempfile::tempdir().unwrap();
        let core = Core::new(d.path().join("state")).unwrap();
        fs::create_dir(d.path().join("vault")).unwrap();
        let v = core.register(&d.path().join("vault")).unwrap();
        (d, core, v)
    }
    #[test]
    fn exact_round_trip_and_stale_save() {
        let (_d, c, v) = fixture();
        let text = "---\r\nunknown: [1,2]\r\n---\r\n# Hi\r\n[[Other]]\r\n";
        let n = c.create(&v.id, Some("sub/n.md"), text, None).unwrap();
        assert_eq!(c.read(&v.id, &n.path).unwrap().content, text);
        assert!(c.save(&v.id, &n.path, "wrong", "lost", None).is_err());
        assert_eq!(c.read(&v.id, &n.path).unwrap().content, text);
        let s = c.save(&v.id, &n.path, &n.revision, "new", None).unwrap();
        assert_ne!(s.revision, n.revision);
        assert!(c.save(&v.id, &n.path, &n.revision, "old", None).is_err());
    }
    #[test]
    fn paths_cannot_escape_or_touch_git() {
        let (_d, c, v) = fixture();
        for p in [
            "../evil.md",
            "/tmp/evil.md",
            ".git/config.md",
            "x/../../evil.md",
            "C:\\file.md",
            ".obsidian/x.md",
        ] {
            assert!(c.create(&v.id, Some(p), "x", None).is_err(), "{p}");
        }
    }
    #[test]
    fn create_and_append_are_idempotent() {
        let (_d, c, v) = fixture();
        let n = c.create(&v.id, None, "a", Some("first")).unwrap();
        assert_eq!(
            c.create(&v.id, None, "a", Some("first")).unwrap().path,
            n.path
        );
        let a = c
            .append(&v.id, &n.path, &n.revision, "b", "second")
            .unwrap();
        assert_eq!(
            c.append(&v.id, &n.path, &n.revision, "b", "second")
                .unwrap()
                .revision,
            a.revision
        );
        assert_eq!(c.read(&v.id, &n.path).unwrap().content, "ab");
        assert!(c
            .append(&v.id, &n.path, &a.revision, "c", "second")
            .is_err());
    }
    #[test]
    fn interrupted_confirmation_does_not_repeat_append() {
        let (_d, c, v) = fixture();
        let n = c.create(&v.id, Some("n.md"), "first", None).unwrap();
        let fingerprint =
            revision(format!("append:{}:n.md:{}: second", v.id, n.revision).as_bytes());
        let pending = Document {
            vault_id: v.id.clone(),
            path: "n.md".into(),
            content: "first second".into(),
            revision: revision(b"first second"),
        };
        c.store_receipt_state(Some("interrupted"), &fingerprint, &pending, false)
            .unwrap();
        c.save(&v.id, "n.md", &n.revision, &pending.content, None)
            .unwrap();
        // Simulate a process exit after the atomic save, before its acknowledgement.
        let restarted = Core::new(c.data.clone()).unwrap();
        let retried = restarted
            .append(&v.id, "n.md", &n.revision, " second", "interrupted")
            .unwrap();
        assert_eq!(retried.content, "first second");
        assert_eq!(
            restarted.read(&v.id, "n.md").unwrap().content,
            "first second"
        );
    }
    #[test]
    fn discovery_preserves_existing_repository() {
        let (_d, c, v) = fixture();
        fs::create_dir(Path::new(&v.path).join(".git")).unwrap();
        fs::write(Path::new(&v.path).join(".git/config"), "owner config").unwrap();
        c.create(&v.id, Some("n.md"), "---\nx: y\n---\n# Title\n", None)
            .unwrap();
        let notes = c.list(&v.id).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].title, "Title");
        assert_eq!(
            fs::read_to_string(Path::new(&v.path).join(".git/config")).unwrap(),
            "owner config"
        );
        assert!(c.vault(&v.id).unwrap().github.is_none());
    }
    #[test]
    fn concurrent_revisions_have_one_winner() {
        let (_d, c, v) = fixture();
        let n = c.create(&v.id, Some("n.md"), "initial", None).unwrap();
        let handles = (0..8)
            .map(|i| {
                let c = c.clone();
                let id = v.id.clone();
                let rev = n.revision.clone();
                std::thread::spawn(move || {
                    c.save(&id, "n.md", &rev, &format!("edit {i}"), None)
                        .is_ok()
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .filter(|ok| *ok)
                .count(),
            1
        );
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape() {
        let (d, c, v) = fixture();
        std::os::unix::fs::symlink(d.path(), Path::new(&v.path).join("escape")).unwrap();
        assert!(c.create(&v.id, Some("escape/evil.md"), "x", None).is_err());
    }
}
