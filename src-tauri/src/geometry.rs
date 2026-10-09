//! Native move/resize callbacks only enqueue a small update. One worker batches
//! persistence away from the GTK/event thread and merges current note styles.
use std::{
    collections::BTreeMap,
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
use sticky_core::{Core, Result};

#[derive(Clone)]
struct Note {
    vault: String,
    path: String,
}
#[derive(Clone, Default)]
pub struct Change {
    pub size: Option<(f64, f64)>,
    pub position: Option<(f64, f64)>,
}
impl Change {
    fn merge(&mut self, change: &Self) {
        if change.size.is_some() {
            self.size = change.size;
        }
        if change.position.is_some() {
            self.position = change.position;
        }
    }
}
#[derive(Default)]
struct Queue {
    notes: BTreeMap<String, Note>,
    pending: BTreeMap<String, Change>,
    closed: Vec<(Note, Change)>,
    deadline: Option<Instant>,
    flushes: Vec<std::sync::mpsc::Sender<std::result::Result<(), String>>>,
}
struct Shared {
    queue: Mutex<Queue>,
    wake: Condvar,
}
#[derive(Clone)]
pub struct Worker(Arc<Shared>);
impl Worker {
    pub fn start(core: Core) -> Self {
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue::default()),
            wake: Condvar::new(),
        });
        let worker = Self(shared.clone());
        std::thread::spawn(move || loop {
            let (changes, flushes) = {
                let mut queue = shared.queue.lock().unwrap();
                while queue.deadline.is_none() {
                    queue = shared.wake.wait(queue).unwrap();
                }
                while let Some(deadline) = queue.deadline {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    queue = shared.wake.wait_timeout(queue, deadline - now).unwrap().0;
                }
                queue.deadline = None;
                let mut changes = std::mem::take(&mut queue.closed);
                for (label, change) in std::mem::take(&mut queue.pending) {
                    if let Some(note) = queue.notes.get(&label) {
                        changes.push((note.clone(), change));
                    }
                }
                (changes, std::mem::take(&mut queue.flushes))
            };
            // The queue lock is released before any filesystem/config lock.
            // A busy disk therefore cannot block the native event callback.
            let result = persist(&core, &changes).map_err(|e| e.to_string());
            if let Err(error) = &result {
                eprintln!("Could not save note window placement: {error}");
            }
            for flush in flushes {
                let _ = flush.send(result.clone());
            }
        });
        worker
    }
    pub fn register(&self, label: &str, vault: &str, path: &str) {
        self.0.queue.lock().unwrap().notes.insert(
            label.into(),
            Note {
                vault: vault.into(),
                path: path.into(),
            },
        );
    }
    pub fn renamed(&self, label: &str, path: &str) {
        if let Some(note) = self.0.queue.lock().unwrap().notes.get_mut(label) {
            note.path = path.into();
        }
    }
    pub fn record(&self, label: &str, change: Change) {
        let mut queue = self.0.queue.lock().unwrap();
        if !queue.notes.contains_key(label) {
            return;
        }
        queue
            .pending
            .entry(label.into())
            .or_default()
            .merge(&change);
        // Coalesce at most four writes/second, including throughout a drag;
        // continuous changes cannot postpone saving indefinitely.
        queue
            .deadline
            .get_or_insert_with(|| Instant::now() + Duration::from_millis(250));
        self.0.wake.notify_one();
    }
    pub fn closed(&self, label: &str) {
        let mut queue = self.0.queue.lock().unwrap();
        if let Some(note) = queue.notes.remove(label) {
            if let Some(change) = queue.pending.remove(label) {
                queue.closed.push((note, change));
                queue.deadline = Some(Instant::now());
                self.0.wake.notify_one();
            }
        }
    }
    /// Called by the existing quit worker, never a native window callback.
    /// The acknowledgement follows any in-progress write and final batch.
    pub fn flush(&self) -> std::result::Result<(), String> {
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let mut queue = self.0.queue.lock().unwrap();
            queue.flushes.push(tx);
            queue.deadline = Some(Instant::now());
            self.0.wake.notify_one();
        }
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "Window placement save timed out".to_owned())?
    }
}
fn persist(core: &Core, changes: &[(Note, Change)]) -> Result<()> {
    if changes.is_empty() {
        return Ok(());
    }
    core.update_config(|config| {
        for (note, change) in changes {
            // Deleted/renamed notes must not have their old style resurrected.
            if let Some(style) = config
                .styles
                .get_mut(&format!("{}/{}", note.vault, note.path))
            {
                if let Some((width, height)) = change.size {
                    style.width = width.max(340.0);
                    style.height = height.max(240.0);
                }
                if let Some((x, y)) = change.position {
                    style.x = Some(x);
                    style.y = Some(y);
                }
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn geometry_updates_merge_latest_style_and_never_recreate_deleted_styles() {
        let root = std::env::temp_dir().join(format!("sticky-geometry-{}", uuid::Uuid::new_v4()));
        let core = Core::new(root.join("data")).unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        let vault = core.register(&root.join("notes")).unwrap();
        let doc = core
            .create(&vault.id, Some("Note.md"), "A note", None)
            .unwrap();
        let mut style = core.style(&vault.id, &doc.path).unwrap();
        style.color = 9;
        style.font_size = 24.0;
        style.pinned = true;
        core.set_style(&vault.id, &doc.path, style).unwrap();
        let note = Note {
            vault: vault.id.clone(),
            path: doc.path.clone(),
        };
        let change = Change {
            size: Some((720.0, 600.0)),
            position: Some((50.0, 80.0)),
        };
        persist(&core, &[(note.clone(), change.clone())]).unwrap();
        let current = core.style(&vault.id, &doc.path).unwrap();
        assert_eq!(
            (current.color, current.font_size, current.pinned),
            (9, 24.0, true)
        );
        assert_eq!(
            (current.width, current.height, current.x, current.y),
            (720.0, 600.0, Some(50.0), Some(80.0))
        );
        core.update_config(|c| {
            c.styles.clear();
            Ok(())
        })
        .unwrap();
        persist(&core, &[(note, change)]).unwrap();
        assert!(core.config().unwrap().styles.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn queue_coalesces_movement_and_size_without_disk_work() {
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue::default()),
            wake: Condvar::new(),
        });
        let worker = Worker(shared.clone());
        worker.register("window", "vault", "Note.md");
        worker.record(
            "window",
            Change {
                size: Some((500.0, 400.0)),
                position: None,
            },
        );
        let deadline = shared.queue.lock().unwrap().deadline;
        for x in 0..1000 {
            worker.record(
                "window",
                Change {
                    size: None,
                    position: Some((f64::from(x), 20.0)),
                },
            );
        }
        let queue = shared.queue.lock().unwrap();
        assert_eq!(queue.pending.len(), 1);
        assert_eq!(queue.deadline, deadline);
        assert_eq!(queue.pending["window"].size, Some((500.0, 400.0)));
        assert_eq!(queue.pending["window"].position, Some((999.0, 20.0)));
        drop(queue);
        worker.renamed("window", "Renamed.md");
        worker.closed("window");
        let queue = shared.queue.lock().unwrap();
        assert!(queue.pending.is_empty());
        assert!(queue.notes.is_empty());
        assert_eq!(queue.closed[0].0.path, "Renamed.md");
    }
}
