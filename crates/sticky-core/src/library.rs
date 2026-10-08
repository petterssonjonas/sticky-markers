//! A bounded, metadata-only library cache. Full note bodies are read on demand.
use crate::{message, Core, NoteRef, Result, NOTE_LIMIT};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    path::Path,
    sync::Mutex,
    time::{Duration, Instant, UNIX_EPOCH},
};
use walkdir::WalkDir;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub vault_id: String,
    pub path: String,
    pub title: String,
    pub modified: u64,
    pub size: u64,
    pub kind: String,
}
#[derive(Serialize)]
pub struct Page {
    pub notes: Vec<Entry>,
    pub total: usize,
}
struct Index {
    scanned: Instant,
    entries: Vec<Entry>,
    searches: BTreeMap<String, std::collections::BTreeSet<String>>,
}
#[derive(Default)]
pub struct Library {
    indexes: Mutex<BTreeMap<String, Index>>,
}
impl Library {
    pub fn invalidate(&self) {
        self.indexes.lock().unwrap().clear();
    }
    pub fn page(
        &self,
        core: &Core,
        id: &str,
        offset: usize,
        limit: usize,
        sort: &str,
        query: &str,
        pinned: bool,
    ) -> Result<Page> {
        let config = core.config()?;
        let vaults: Vec<_> = if id == "*" {
            config.vaults.clone()
        } else {
            vec![core.vault(id)?]
        };
        let mut indexes = self.indexes.lock().unwrap();
        let mut entries = Vec::new();
        for vault in vaults {
            let id = vault.id.as_str();
            if indexes
                .get(id)
                .is_none_or(|i| i.scanned.elapsed() > Duration::from_secs(10))
            {
                if !Path::new(&vault.path).is_dir() {
                    return Err(message("Vault folder is unavailable"));
                }
                let mut entries = Vec::new();
                for item in WalkDir::new(&vault.path)
                    .follow_links(false)
                    .into_iter()
                    .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
                {
                    let item = item.map_err(|e| message(e.to_string()))?;
                    if !item.file_type().is_file() {
                        continue;
                    }
                    let metadata = item.metadata().map_err(|e| message(e.to_string()))?;
                    if metadata.len() > NOTE_LIMIT as u64 {
                        continue;
                    }
                    // Sniff a small prefix, never read 100 KiB per file merely to list names.
                    let mut sample = [0; 512];
                    let Ok(mut file) = File::open(item.path()) else {
                        continue;
                    };
                    let Ok(count) = file.read(&mut sample) else {
                        continue;
                    };
                    let sample = &sample[..count];
                    if sample.iter().any(|b| *b == 0)
                        || std::str::from_utf8(sample)
                            .err()
                            .is_some_and(|e| e.error_len().is_some())
                    {
                        continue;
                    }
                    let path = item
                        .path()
                        .strip_prefix(&vault.path)
                        .map_err(|e| message(e.to_string()))?
                        .to_string_lossy()
                        .replace('\\', "/");
                    let kind = item
                        .path()
                        .extension()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_lowercase();
                    entries.push(Entry {
                        vault_id: id.into(),
                        path,
                        title: item.file_name().to_string_lossy().into(),
                        modified: metadata
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0),
                        size: metadata.len(),
                        kind,
                    });
                }
                indexes.insert(
                    id.into(),
                    Index {
                        scanned: Instant::now(),
                        entries,
                        searches: BTreeMap::new(),
                    },
                );
            }
            let index = indexes.get_mut(id).unwrap();
            let q = query.to_lowercase();
            if !q.is_empty() && !index.searches.contains_key(&q) {
                // Content search remains available, but scanning bodies is lazy and
                // runs only for an explicit query on the desktop worker thread.
                let matches = index
                    .entries
                    .iter()
                    .filter(|e| {
                        e.path.to_lowercase().contains(&q)
                            || crate::safe_path(Path::new(&vault.path), &e.path)
                                .and_then(|p| crate::read_text(&p))
                                .is_ok_and(|text| text.to_lowercase().contains(&q))
                    })
                    .map(|e| e.path.clone())
                    .collect();
                if index.searches.len() >= 8 {
                    index.searches.clear();
                }
                index.searches.insert(q.clone(), matches);
            }
            entries.extend(
                index
                    .entries
                    .iter()
                    .filter(|e| {
                        (q.is_empty() || index.searches[&q].contains(&e.path))
                            && (!pinned || {
                                config
                                    .styles
                                    .get(&format!("{id}/{}", e.path))
                                    .is_some_and(|s| s.pinned)
                            })
                    })
                    .cloned(),
            );
        }
        entries.sort_by(|a, b| match sort {
            "name" => a
                .title
                .to_lowercase()
                .cmp(&b.title.to_lowercase())
                .then(a.path.cmp(&b.path)),
            "size" => b.size.cmp(&a.size).then(a.path.cmp(&b.path)),
            "type" => a.kind.cmp(&b.kind).then(a.path.cmp(&b.path)),
            "oldest" => a.modified.cmp(&b.modified).then(a.path.cmp(&b.path)),
            _ => b.modified.cmp(&a.modified).then(a.path.cmp(&b.path)),
        });
        Ok(Page {
            total: entries.len(),
            notes: entries
                .into_iter()
                .skip(offset)
                .take(limit.clamp(1, 100))
                .collect(),
        })
    }
}

impl Core {
    /// Cross-vault moves never overwrite a target. Recovery is recorded before
    /// deletion, and every target is safely written before any source is removed.
    pub fn move_notes(&self, notes: &[NoteRef], destination: &str) -> Result<()> {
        if notes.is_empty() {
            return Ok(());
        }
        self.vault(destination)?;
        let _batch = self.lock("vault-moves")?;
        let mut sources = Vec::new();
        let mut names = std::collections::BTreeSet::new();
        for note in notes {
            if note.vault_id == destination {
                continue;
            }
            if !names.insert(note.path.clone()) {
                return Err(message("Selected notes have the same target path"));
            }
            let target = self.resolve(destination, &note.path)?;
            if target.exists() {
                return Err(message(format!(
                    "A note already exists in the target vault: {}",
                    note.path
                )));
            }
            sources.push((note.clone(), self.resolve(&note.vault_id, &note.path)?));
        }
        sources.sort_by(|a, b| a.1.cmp(&b.1));
        let _locks = sources
            .iter()
            .map(|(_, p)| self.lock(&p.to_string_lossy()))
            .collect::<Result<Vec<_>>>()?;
        let documents = sources
            .iter()
            .map(|(n, _)| self.read(&n.vault_id, &n.path))
            .collect::<Result<Vec<_>>>()?;
        for d in &documents {
            self.recovery(&d.vault_id, &d.path, d.content.as_bytes())?;
        }
        for d in &documents {
            self.create(destination, Some(&d.path), &d.content, None)?;
        }
        // A source edited externally while copying is kept; all target copies
        // and recovery copies are also retained, rather than losing either edit.
        for (d, (_, p)) in documents.iter().zip(&sources) {
            if crate::revision(&std::fs::read(p)?) != d.revision {
                return Err(message(
                    "A source changed during the move. Both copies were preserved.",
                ));
            }
        }
        self.update_config(|c| {
            for d in &documents {
                if let Some(mut style) = c.styles.remove(&format!("{}/{}", d.vault_id, d.path)) {
                    style.open = false;
                    c.styles.insert(format!("{destination}/{}", d.path), style);
                }
                for n in &mut c.recent {
                    if n.vault_id == d.vault_id && n.path == d.path {
                        n.vault_id = destination.into();
                    }
                }
            }
            Ok(())
        })?;
        for (_, p) in sources {
            std::fs::remove_file(p)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn library_is_paged_cached_and_sorted_without_note_bodies() {
        let root = tempfile::tempdir().unwrap();
        let core = Core::new(root.path().join("data")).unwrap();
        let folder = root.path().join("vault");
        std::fs::create_dir(&folder).unwrap();
        let v = core.register(&folder).unwrap();
        for i in 0..300 {
            std::fs::write(
                folder.join(format!("n{i:03}.md")),
                format!("# Secret title\n{}", "x".repeat(i + 1)),
            )
            .unwrap();
        }
        std::fs::write(folder.join("binary.bin"), b"\0\x01").unwrap();
        let library = Library::default();
        let start = Instant::now();
        let page = library
            .page(&core, &v.id, 0, 24, "name", "", false)
            .unwrap();
        eprintln!("Indexed 300 notes in {:?}", start.elapsed());
        assert_eq!(page.total, 300);
        assert_eq!(page.notes.len(), 24);
        assert_eq!(page.notes[0].title, "n000.md");
        let last = library
            .page(&core, &v.id, 299, 24, "name", "", false)
            .unwrap();
        assert_eq!(last.notes[0].path, "n299.md");
        let biggest = library.page(&core, &v.id, 0, 1, "size", "", false).unwrap();
        assert_eq!(biggest.notes[0].path, "n299.md");
        assert!(serde_json::to_string(&page).unwrap().len() < 6000);
        let content = library
            .page(&core, &v.id, 0, 24, "name", "Secret title", false)
            .unwrap();
        assert_eq!(content.total, 300);
        assert_eq!(
            library
                .page(&core, &v.id, 0, 24, "name", "Secret title", false)
                .unwrap()
                .total,
            300
        );
    }
    #[test]
    fn global_tabs_page_across_vaults_and_sort_oldest() {
        let root = tempfile::tempdir().unwrap();
        let core = Core::new(root.path().join("data")).unwrap();
        let mut refs = Vec::new();
        for (name, time) in [("first", 10), ("second", 20)] {
            let folder = root.path().join(name);
            std::fs::create_dir(&folder).unwrap();
            let v = core.register(&folder).unwrap();
            core.create(&v.id, Some("same.md"), name, None).unwrap();
            // Windows requires a writable handle to change file timestamps.
            std::fs::OpenOptions::new()
                .write(true)
                .open(folder.join("same.md"))
                .unwrap()
                .set_times(
                    std::fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(time)),
                )
                .unwrap();
            let mut style = core.style(&v.id, "same.md").unwrap();
            style.pinned = name == "second";
            core.set_style(&v.id, "same.md", style).unwrap();
            refs.push(v.id);
        }
        let library = Library::default();
        let newest = library.page(&core, "*", 0, 1, "date", "", false).unwrap();
        assert_eq!(newest.total, 2);
        assert_eq!(newest.notes[0].vault_id, refs[1]);
        let oldest = library.page(&core, "*", 0, 1, "oldest", "", false).unwrap();
        assert_eq!(oldest.notes[0].vault_id, refs[0]);
        let next = library.page(&core, "*", 1, 1, "oldest", "", false).unwrap();
        assert_eq!(next.notes[0].vault_id, refs[1]);
        let pinned = library.page(&core, "*", 0, 24, "date", "", true).unwrap();
        assert_eq!(pinned.total, 1);
        assert_eq!(pinned.notes[0].vault_id, refs[1]);
        assert_eq!(
            library
                .page(&core, &refs[0], 0, 24, "date", "", false)
                .unwrap()
                .total,
            1
        );
    }
    #[test]
    fn moves_preserve_bytes_styles_and_reject_collisions_before_mutation() {
        let root = tempfile::tempdir().unwrap();
        let core = Core::new(root.path().join("data")).unwrap();
        let a = root.path().join("a");
        let b = root.path().join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        let a = core.register(&a).unwrap();
        let b = core.register(&b).unwrap();
        core.create(&a.id, Some("sub/n.md"), "# Exact\r\n\r\n- Text\r\n", None)
            .unwrap();
        core.create(&a.id, Some("config.toml"), "key = true", None)
            .unwrap();
        core.create(&b.id, Some("config.toml"), "existing", None)
            .unwrap();
        let notes = vec![
            NoteRef {
                vault_id: a.id.clone(),
                path: "sub/n.md".into(),
            },
            NoteRef {
                vault_id: a.id.clone(),
                path: "config.toml".into(),
            },
        ];
        assert!(core.move_notes(&notes, &b.id).is_err());
        assert!(!core.resolve(&b.id, "sub/n.md").unwrap().exists());
        std::fs::remove_file(core.resolve(&b.id, "config.toml").unwrap()).unwrap();
        let mut style = core.style(&a.id, "sub/n.md").unwrap();
        style.pinned = true;
        core.set_style(&a.id, "sub/n.md", style).unwrap();
        core.move_notes(&notes, &b.id).unwrap();
        assert_eq!(
            core.read(&b.id, "sub/n.md").unwrap().content,
            "# Exact\r\n\r\n- Text\r\n"
        );
        assert!(!core.resolve(&a.id, "sub/n.md").unwrap().exists());
        assert!(core.style(&b.id, "sub/n.md").unwrap().pinned);
        assert!(core
            .move_notes(
                &[NoteRef {
                    vault_id: b.id.clone(),
                    path: "../outside".into()
                }],
                &a.id
            )
            .is_err());
    }
}
