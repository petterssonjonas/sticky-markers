import {
  useCallback,
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Plus,
  Menu,
  X,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  ArrowUpRight,
  FolderOpen,
  Search,
  Settings as SettingsIcon,
  ChevronDown,
  ArrowLeft,
  FileText,
  Check,
  Trash2,
  ArrowRight,
  Sun,
  Moon,
  Monitor,
  Code2,
  Eye,
  RefreshCw,
  Github,
  Leaf,
  PanelLeft,
  Ellipsis,
  Download,
  Upload,
  Copy,
  Pin,
  List,
  Heading,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { call, desktop, registerFolder, pickFolder, external } from "./api";
import {
  type Config,
  type Document,
  type Note,
  type NoteStyle,
  type Settings,
  type Vault,
  defaultStyle,
} from "./types";
import { palettes, colors, fonts } from "./palettes";
import { UpdateNotice, UpdatePanel } from "./updates";
import { type EditorHandle } from "./editor";
const MarkdownEditor = lazy(() =>
  import("./editor").then((m) => ({ default: m.MarkdownEditor })),
);
const Markdown = lazy(() =>
  import("./markdown").then((m) => ({ default: m.Markdown })),
);

function Button({
  label,
  children,
  onClick,
  className = "",
  disabled = false,
  pressed,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
    >
      {children}
    </button>
  );
}
function useDark(appearance: string) {
  const [system, setSystem] = useState(
    matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const m = matchMedia("(prefers-color-scheme: dark)");
    const fn = () => setSystem(m.matches);
    m.addEventListener("change", fn);
    return () => m.removeEventListener("change", fn);
  }, []);
  return appearance === "dark" || (appearance === "system" && system);
}
export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [route, setRoute] = useState(location.search);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setConfig(await call<Config>("bootstrap"));
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const route = () => setRoute(location.search);
    window.addEventListener("popstate", route);
    return () => window.removeEventListener("popstate", route);
  }, [refresh]);
  useEffect(() => {
    if (!desktop) return;
    const un = listen("notes-changed", () => void refresh());
    return () => {
      void un.then((f) => f());
    };
  }, [refresh]);
  const dark = useDark(config?.settings.appearance ?? "system");
  useEffect(() => {
    document.documentElement.dataset.appearance = dark ? "dark" : "light";
  }, [dark]);
  if (error && !config)
    return (
      <div className="startup-error">
        <Leaf />
        <h1>We couldn’t open your settings.</h1>
        <p>{error}</p>
        <button onClick={() => void refresh()}>Try again</button>
      </div>
    );
  if (!config)
    return (
      <div className="loading">
        <Leaf size={30} />
        <span>Making a little space…</span>
      </div>
    );
  const q = new URLSearchParams(route);
  const path = q.get("note"),
    vaultId = q.get("vault");
  return <><UpdateNotice/>{path && vaultId ? (
    <NoteWindow
      key={`${vaultId}/${path}`}
      vaultId={vaultId}
      path={path}
      config={config}
      dark={dark}
      refresh={refresh}
    />
  ) : (
    <Collection config={config} refresh={refresh} dark={dark} />
  )}</>;
}

function Collection({
  config,
  refresh,
  dark,
}: {
  config: Config;
  refresh: () => Promise<void>;
  dark: boolean;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [settings, setSettings] = useState(false);
  const [vaultMenu, setVaultMenu] = useState(false);
  const [filter, setFilter] = useState("all");
  const [folder, setFolder] = useState("");
  const [matches, setMatches] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const active =
    config.vaults.find((v) => v.id === config.activeVault) ?? config.vaults[0];
  const load = useCallback(async () => {
    if (!active) {
      setNotes([]);
      return;
    }
    try {
      setNotes(await call<Note[]>("list_notes", { vaultId: active.id }));
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, [active?.id]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!active || !query.trim()) {
      setMatches(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void call<Note[]>("search_notes", { vaultId: active.id, query })
        .then((found) => {
          if (live) setMatches(new Set(found.map((n) => n.path)));
        })
        .catch((e) => setError(String(e)));
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, active?.id]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n" && active) {
        e.preventDefault();
        void call("new_note", { vaultId: active.id }).catch((e) =>
          setError(String(e)),
        );
      } else if (
        (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "q" && desktop
      ) {
        e.preventDefault();
        void call("quit");
      } else if (
        e.key === "/" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".search input")?.focus();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [active?.id]);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      setBusy(true);
      await fn();
      await refresh();
      await load();
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const visible = notes.filter(
    (n) =>
      (matches
        ? matches.has(n.path)
        : `${n.title} ${n.preview} ${n.path}`
            .toLowerCase()
            .includes(query.toLowerCase())) &&
      (!folder || n.path.startsWith(folder + "/")) &&
      (filter === "all" || config.styles[`${n.vaultId}/${n.path}`]?.pinned),
  );
  return (
    <div className="collection">
      <aside className="sidebar">
        <div className="brand" data-tauri-drag-region>
          <span className="brand-mark">
            <Leaf size={20} />
          </span>
          <span>
            sticky markers<span className="brand-dot">.</span>
          </span>
        </div>
        <div className="vault-picker">
          <button onClick={() => setVaultMenu(!vaultMenu)}>
            <span className="vault-icon">
              <FolderOpen size={18} />
            </span>
            <span>
              <strong>{active?.name ?? "Choose a vault"}</strong>
              <small>
                {active?.github ? "GitHub synced" : "Your little corner"}
              </small>
            </span>
            <ChevronDown size={15} />
          </button>
          {vaultMenu && (
            <div className="vault-menu">
              {config.vaults.map((v) => (
                <button
                  key={v.id}
                  onClick={() => {
                    setVaultMenu(false);
                    void run(() => call("select_vault", { vaultId: v.id }));
                  }}
                >
                  <FolderOpen size={15} />
                  {v.name}
                  {v.id === active?.id && <Check size={14} />}
                </button>
              ))}
              <button
                onClick={() => {
                  setVaultMenu(false);
                  void run(registerFolder);
                }}
              >
                <Plus size={15} />
                Open another folder
              </button>
              <button
                onClick={() => {
                  setVaultMenu(false);
                  setSettings(true);
                }}
              >
                <Github size={15} />
                Create GitHub synced vault
              </button>
            </div>
          )}
        </div>
        <p className="nav-label">YOUR SPACE</p>
        <button
          className={`nav-item ${filter === "all" ? "selected" : ""}`}
          onClick={() => setFilter("all")}
        >
          <FileText size={17} />
          All notes<span>{notes.length}</span>
        </button>
        <button
          className={`nav-item ${filter === "pinned" ? "selected" : ""}`}
          onClick={() => setFilter("pinned")}
        >
          <PanelLeft size={17} />
          Pinned notes
          <span>
            {
              notes.filter((n) => config.styles[`${n.vaultId}/${n.path}`]?.pinned)
                .length
            }
          </span>
        </button>
        <div className="sidebar-note">
          <span className="tiny-spark">✳</span>
          <p>
            A thought worth keeping?
            <br />
            Give it a little window.
          </p>
        </div>
        <div className="sidebar-bottom">
          {desktop && active && (
            <button className="nav-item" onClick={() => void run(() => call("import_note", { vaultId: active.id }))}>
              <Upload size={17} />Import note
            </button>
          )}
          {active?.github && (
            <button
              className="nav-item"
              onClick={() =>
                void run(() => call("sync_vault", { vaultId: active.id }))
              }
            >
              <RefreshCw size={17} />
              {active.github.error ? "Sync needs attention" : "Sync now"}
            </button>
          )}
          <button className="nav-item" onClick={() => setSettings(true)}>
            <SettingsIcon size={17} />
            Settings
          </button>
          <div className="local-status">
            <span />
            {desktop
              ? "Saved on your device"
              : "Browser demo · local browser storage"}
          </div>
        </div>
      </aside>
      <main className="collection-main">
        <header className="main-header" data-tauri-drag-region>
          <span className="breadcrumb">
            <FolderOpen size={14} />
            {active?.name ?? "Welcome"}
          </span>
          <div className="header-actions">
            <span className="version-label">
              A little space for your thoughts
            </span>
            {desktop && (
              <Button
                label="Close main window"
                onClick={() => void call("hide_main")}
              >
                <X size={16} />
              </Button>
            )}
          </div>
        </header>
        <section className="collection-heading">
          <div>
            <div className="eyebrow">THOUGHTS, PLANS & LITTLE REMINDERS</div>
            <h1>
              Your notes,
              <br />
              <span>a little closer.</span>
            </h1>
            <p>Out of your head. Somewhere you can find them.</p>
          </div>
          <button
            className="primary new-note"
            disabled={busy || !active}
            onClick={() =>
              void run(() => call("new_note", { vaultId: active!.id }))
            }
          >
            <Plus size={19} />
            New note<span>⌘ N</span>
          </button>
        </section>
        {error && (
          <div role="alert" className="error-banner">
            {error}
            <button onClick={() => setError("")} aria-label="Dismiss error">
              <X size={14} />
            </button>
          </div>
        )}
        {!active ? (
          <div className="empty-state">
            <FolderOpen size={36} />
            <h2>Make yourself a little space.</h2>
            <p>
              Choose a folder, open an Obsidian vault, or create a private
              GitHub synced vault. Your notes stay ordinary text files.
            </p>
            <button
              className="primary"
              onClick={() => void run(registerFolder)}
            >
              <FolderOpen size={17} />
              Choose a notes folder
            </button>
            <button className="text-button" onClick={() => setSettings(true)}>
              Create a GitHub synced vault <ArrowRight size={15} />
            </button>
          </div>
        ) : (
          <>
            <div className="collection-tools">
              <div className="tabs">
                <button
                  className={filter === "all" ? "active" : ""}
                  onClick={() => setFilter("all")}
                >
                  All notes <span>{notes.length}</span>
                </button>
                <button
                  className={filter === "pinned" ? "active" : ""}
                  onClick={() => setFilter("pinned")}
                >
                  Pinned notes
                </button>
              </div>
              <select
                className="folder-filter"
                aria-label="Note folder"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
              >
                <option value="">All folders</option>
                {Array.from(
                  new Set(
                    notes
                      .map((n) => n.path.split("/").slice(0, -1).join("/"))
                      .filter(Boolean),
                  ),
                )
                  .sort()
                  .map((f) => (
                    <option value={f} key={f}>
                      {f}
                    </option>
                  ))}
              </select>
              <label className="search">
                <Search size={16} />
                <input
                  aria-label="Search notes"
                  placeholder="Find a little thought…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <kbd>/</kbd>
              </label>
            </div>
            <div className="notes-grid">
              {visible.map((n, i) => {
                const s =
                  config.styles[`${n.vaultId}/${n.path}`] ??
                  defaultStyle(config.settings);
                const c = colors(s.palette, s.color, dark);
                return (
                  <button
                    className="note-card"
                    style={
                      {
                        "--paper": c.body,
                        "--ink": c.ink,
                        "--rotation": `${[-0.6, 0.5, -0.35, 0.65, 0][i % 5]}deg`,
                      } as CSSProperties
                    }
                    key={n.path}
                    onClick={() =>
                      void run(() =>
                        call("open_note", { vaultId: n.vaultId, path: n.path }),
                      )
                    }
                  >
                    <div className="card-top">
                      <span>
                        {new Date(n.modified * 1000).toLocaleDateString(
                          undefined,
                          { month: "short", day: "numeric" },
                        )}
                      </span>
                      <ArrowUpRight size={17} />
                    </div>
                    <h2>{n.title || "Untitled note"}</h2>
                    <div className="card-preview"><Suspense fallback={null}>{/\.(md|markdown|mdown)$/i.test(n.path) ? <Markdown content={n.preview.replace(/^#{1,6} [^\n]*(?:\r?\n)?/, "")} dark={dark} vaultId={n.vaultId} path={n.path} onWiki={() => {}} preview /> : <pre>{n.preview}</pre>}</Suspense></div>
                    <div className="card-bottom">
                      <span>
                        <FileText size={12} />
                        {n.path.includes("/")
                          ? n.path.split("/").slice(0, -1).join("/")
                          : (/\.(md|markdown|mdown)$/i.test(n.path) ? "Markdown note" : "Text note")}
                      </span>
                      {s.pinned && <span className="open-badge"><Pin size={12}/> Pinned</span>}
                    </div>
                  </button>
                );
              })}
              <button
                className="add-card"
                onClick={() =>
                  void run(() => call("new_note", { vaultId: active.id }))
                }
              >
                <span>
                  <Plus size={24} />
                </span>
                <strong>A fresh little page</strong>
                <small>What’s on your mind?</small>
              </button>
            </div>
            {query && visible.length === 0 && (
              <p className="no-results">
                No notes match “{query}”. Try another word.
              </p>
            )}
            <footer className="collection-footer">
              <span>
                {notes.length} little{" "}
                {notes.length === 1 ? "thought" : "thoughts"}, safely kept.
              </span>
              <span>
                Plain Markdown. Always yours. <Leaf size={13} />
              </span>
            </footer>
          </>
        )}
      </main>
      {settings && (
        <SettingsDialog
          config={config}
          close={() => setSettings(false)}
          refresh={refresh}
        />
      )}
    </div>
  );
}

function NoteWindow({
  vaultId,
  path,
  config,
  dark,
  refresh,
}: {
  vaultId: string;
  path: string;
  config: Config;
  dark: boolean;
  refresh: () => Promise<void>;
}) {
  const [document, setDocument] = useState<Document | null>(null);
  const [text, setText] = useState("");
  const [style, setStyle] = useState<NoteStyle>(
    config.styles[`${vaultId}/${path}`] ?? defaultStyle(config.settings),
  );
  const [menu, setMenu] = useState(false);
  const [headings, setHeadings] = useState(false);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [status, setStatus] = useState(path.startsWith("draft-") ? "Empty draft" : "Saved locally");
  const [error, setError] = useState("");
  const editor = useRef<EditorHandle>(null);
  const current = useRef("");
  const saved = useRef<Document | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const styleRef = useRef(style);
  styleRef.current = style;
  const closing = useRef(false);
  const [finishing, setFinishing] = useState(false);
  const [heading, setHeading] = useState(new URLSearchParams(location.search).get("heading") ?? "");
  const journalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vault = config.vaults.find((v) => v.id === vaultId);
  const c = colors(style.palette, style.color, dark);
  const actualPath = document?.path ?? path;
  const plain = !path.startsWith("draft-") && !/\.(md|markdown|mdown)$/i.test(actualPath);
  useEffect(() => {
    if (menu && !systemFonts.length) void call<string[]>("system_fonts").then(setSystemFonts).catch((e) => setError(String(e)));
  }, [menu]);
  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (journalTimer.current) { clearTimeout(journalTimer.current); journalTimer.current = null; }
    if (pending.current) await pending.current;
    while (saved.current && current.current !== saved.current.content) {
      const content = current.current,
        expected = saved.current.revision;
      setStatus("Saving…");
      const task = (async () => {
        try {
          const d = await call<Document>("save_note", {
            vaultId,
            path,
            expected,
            content,
            requestId: crypto.randomUUID(),
          });
          saved.current = d;
          setDocument(d);
          setStatus("Saved locally");
          setError("");
        } catch (e) {
          setStatus("Not saved");
          setError(String(e));
          throw e;
        }
      })();
      pending.current = task;
      try {
        await task;
      } finally {
        pending.current = null;
      }
    }
  }, [vaultId, path]);
  const close = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    setFinishing(true);
    editor.current?.setReadOnly(true);
    try {
      await flush();
      await call("tuck_note", { vaultId, path });
    } catch {
      closing.current = false;
      setFinishing(false);
      editor.current?.setReadOnly(false);
    }
  }, [flush, vaultId, path]);
  useEffect(() => {
    let live = true;
    call<Document>("read_note", { vaultId, path })
      .then((d) => {
        if (live) {
          saved.current = d;
          current.current = d.content;
          setDocument(d);
          setText(d.content);
          const persistedStyle = config.styles[`${vaultId}/${d.path}`];
          if (persistedStyle) setStyle(persistedStyle);
          else if (!/\.(md|markdown|mdown)$/i.test(d.path) && !d.path.startsWith("draft-")) setStyle((s) => ({ ...s, mode: "edit", font: "mono" }));
          setStatus(d.path.startsWith("draft-") ? "Empty draft" : "Saved locally");
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
      if (journalTimer.current) clearTimeout(journalTimer.current);
      if (journalTimer.current) clearTimeout(journalTimer.current);
    };
  }, [vaultId, path]);
  useEffect(() => {
    if (!desktop) return;
    const closeListener = getCurrentWindow().onCloseRequested((e) => {
      e.preventDefault();
      void close();
    });
    const quitListener = listen("prepare-quit", () => {
      closing.current = true;
      setFinishing(true);
      editor.current?.setReadOnly(true);
      void flush()
        .then(() =>
          call("quit_ready", { label: getCurrentWindow().label, ok: true }),
        )
        .catch(() =>
          call("quit_ready", { label: getCurrentWindow().label, ok: false }),
        );
    });
    const cancelListener = listen("quit-cancelled", () => {
      closing.current = false;
      setFinishing(false);
      editor.current?.setReadOnly(false);
    });
    return () => {
      void closeListener.then((f) => f());
      void quitListener.then((f) => f());
      void cancelListener.then((f) => f());
    };
  }, [close, flush]);
  useEffect(() => {
    const interval = setInterval(() => {
      if (pending.current || !saved.current) return;
      void call<Document>("read_note", { vaultId, path })
        .then((d) => {
          if (d.revision === saved.current?.revision) return;
          if (current.current === saved.current?.content) {
            saved.current = d;
            current.current = d.content;
            setDocument(d);
            setText(d.content);
            setStatus("Updated from disk");
          } else {
            setStatus("Conflict");
            setError(
              "The file changed outside this window. Your text is preserved. Save a recovery copy before loading the disk version.",
            );
          }
        })
        .catch((e) => setError(String(e)));
    }, 2500);
    return () => clearInterval(interval);
  }, [vaultId, path]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        void flush().catch(() => {});
      } else if (k === "q" && desktop) {
        e.preventDefault();
        void call("quit");
      } else if (k === "n") {
        e.preventDefault();
        void flush()
          .then(() => call("new_note", { vaultId }))
          .catch((e) => setError(String(e)));
      } else if (["b", "i", "u"].includes(k)) {
        e.preventDefault();
        editor.current?.format(
            { b: "bold", i: "italic", u: "underline" }[k]!,
          );
      }
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [flush, vaultId]);
  const change = (s: string) => {
    current.current = s;
    setText(s);
    if (!saved.current || s === saved.current.content) return;
    setStatus("Unsaved");
    if (journalTimer.current) clearTimeout(journalTimer.current);
    journalTimer.current = setTimeout(() => {
      void call("journal", { vaultId, path, content: current.current }).catch(
        (e) => setError(String(e)),
      );
    }, 150);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flush().catch(() => {});
    }, 450);
  };
  const updateStyle = async (patch: Partial<NoteStyle>) => {
    const next = { ...styleRef.current, ...patch };
    styleRef.current = next;
    setStyle(next);
    try {
      await call("set_style", { vaultId, path, style: next });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };
  const mode = async (next: "edit" | "view") => {
    if (closing.current) return;
    try {
      await flush();
      await updateStyle({ mode: next });
      setMenu(false);
    } catch {}
  };
  useEffect(() => {
    if (heading && style.mode !== "view" && document) void mode("view");
  }, [heading, document?.path]);
  useEffect(() => {
    if (!desktop) return;
    const un = listen<string>("navigate-heading", (e) => {
      setHeading(e.payload); void mode("view");
    });
    return () => { void un.then((f) => f()); };
  }, [vaultId, path]);
  const format = (kind: string) => {
    if (closing.current) return;
    editor.current?.format(kind);
  };
  const newNote = async () => {
    if (closing.current) return;
    try {
      await flush();
      await call("new_note", { vaultId });
    } catch (e) {
      setError(String(e));
    }
  };
  const wiki = async (target: string) => {
    try {
      const [name, anchor] = target.split("#");
      if (!name && anchor) { setHeading(anchor); await mode("view"); return; }
      const notes = await call<Note[]>("list_notes", { vaultId });
      const filename = name.endsWith(".md") ? name : `${name}.md`;
      const relative = [...path.split("/").slice(0, -1)];
      for (const part of filename.split("/")) { if (part === "..") relative.pop(); else if (part !== ".") relative.push(part); }
      const found =
        notes.find((n) => n.path === relative.join("/")) ||
        notes.find((n) => n.path === filename) ||
        notes.find((n) => n.path.split("/").pop() === filename);
      if (!found) throw new Error(`No note named “${name}” in this vault.`);
      await call("open_note", { vaultId, path: found.path, heading: anchor });
    } catch (e) {
      setError(String(e));
    }
  };
  const remove = async () => {
    if (
      !confirm(
        "Move this note to Trash? Close keeps it in your vault; Delete removes the file.",
      )
    )
      return;
    try {
      await flush();
      await call("delete_note", {
        vaultId,
        path,
        expected: saved.current?.revision,
      });
    } catch (e) {
      setError(String(e));
    }
  };
  const reload = async () => {
    try {
      await call("journal", { vaultId, path, content: current.current });
      const d = await call<Document>("read_note", { vaultId, path });
      saved.current = d;
      current.current = d.content;
      setText(d.content);
      setDocument(d);
      setError("");
      setStatus("Loaded from disk");
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div
      className={`note-window ${dark ? "dark-note" : ""}`}
      style={
        {
          "--paper": c.body,
          "--header": c.header,
          "--ink": c.ink,
          "--note-font": fonts[style.font] ?? `${JSON.stringify(style.font)}, system-ui, sans-serif`,
          "--note-font-size": `${style.fontSize}px`,
        } as CSSProperties
      }
    >
      <header className="note-header">
        <Button label="New note" onClick={() => void newNote()}>
          <Plus size={19} />
        </Button>
        <Button label={style.pinned ? "Unpin note" : "Pin note"} pressed={!!style.pinned} onClick={() => void updateStyle({ pinned: !style.pinned, pinnedAt: !style.pinned ? Date.now() : 0 })}><Pin size={17} /></Button>
        <div
          className="note-drag"
          data-tauri-drag-region
          title={`${vault?.name} / ${actualPath}`}
        >
          {actualPath.startsWith("draft-") ? "New note" : actualPath.split("/").pop()?.replace(/\.(md|markdown|mdown)$/i, "")}
        </div>
        <span className={`note-save-status ${status === "Unsaved" || status === "Not saved" || status === "Conflict" ? "save-warning" : ""}`} role="status"><span className="status-dot" />{status}</span>
        <div className="format-buttons">
          {[
            [Bold, "bold"],
            [Italic, "italic"],
            [Underline, "underline"],
            [Strikethrough, "strike"],
            [List, "bullets"],
          ].map(([Icon, kind]) => {
            const I = Icon as typeof Bold;
            return (
              <Button
                key={String(kind)}
                label={String(kind)}
                onClick={() => format(String(kind))}
              >
                <I size={15} />
              </Button>
            );
          })}
          <div className="heading-control"><Button label="Insert heading" onClick={() => setHeadings(!headings)}><Heading size={15}/><ChevronDown size={10}/></Button>
            {headings && <div className="heading-menu">{[1,2,3,4,5,6].map((n) => <button key={n} onClick={() => { format(`heading${n}`); setHeadings(false); }}>Heading {n} <span>{"#".repeat(n)}</span></button>)}</div>}
          </div>
        </div>
        <Button label="Note menu" onClick={() => setMenu(!menu)}>
          <Menu size={19} />
        </Button>
        <Button label="Close note to collection" onClick={() => void close()}>
          <X size={19} />
        </Button>
      </header>
      {menu && (
        <>
          <div className="menu-dismiss" onClick={() => setMenu(false)} />
          <div className="note-menu">
            <div className="menu-vault"><FolderOpen size={13}/>{vault?.name}</div>
            <div className="menu-save-status" role="status"><span className="status-dot"/>{status}</div>
            <div className="menu-label">A COLOR FOR YOUR THOUGHT</div>
            <select
              aria-label="Color palette"
              value={style.palette}
              onChange={(e) => void updateStyle({ palette: e.target.value })}
            >
              {Object.entries(palettes).map(([id, p]) => (
                <option value={id} key={id}>
                  {p.name}
                </option>
              ))}
            </select>
            <div className="swatches">
              {(dark
                ? palettes[style.palette]?.dark
                : palettes[style.palette]?.light
              )?.map((color, i) => (
                <button
                  aria-label={`Color ${i + 1}`}
                  aria-pressed={style.color === i}
                  className={style.color === i ? "chosen" : ""}
                  style={{ background: color }}
                  key={i}
                  onClick={() => void updateStyle({ color: i })}
                >
                  {style.color === i && <Check size={15} />}
                </button>
              ))}
            </div>
            <div className="mode-switch">
              <button
                className={style.mode === "edit" ? "active" : ""}
                onClick={() => void mode("edit")}
              >
                <Code2 size={14} />
                Edit
              </button>
              <button
                className={style.mode === "view" ? "active" : ""}
                disabled={plain}
                title={plain ? "Rendered mode is available for Markdown notes" : undefined}
                onClick={() => void mode("view")}
              >
                <Eye size={14} />
                Rendered mode
              </button>
            </div>
            <div className="font-controls">
              <label>
                Font
                <select
                  aria-label="Note font"
                  value={style.font}
                  onChange={(e) => void updateStyle({ font: e.target.value })}
                >
                  <option value="sans">Sans serif</option>
                  <option value="serif">Serif</option>
                  <option value="mono">Monospace</option>
                  {style.font && !["sans", "serif", "mono", ...systemFonts].includes(style.font) && <option value={style.font}>{style.font}</option>}
                  <optgroup label="System fonts">{systemFonts.map((font) => <option value={font} key={font}>{font}</option>)}</optgroup>
                </select>
              </label>
              <label>
                Size
                <input
                  aria-label="Note font size"
                  type="number"
                  min="10"
                  max="48"
                  value={style.fontSize}
                  onChange={(e) =>
                    void updateStyle({
                      fontSize: Math.min(
                        48,
                        Math.max(10, Number(e.target.value)),
                      ),
                    })
                  }
                />
              </label>
            </div>
            <button
              className="menu-action"
              onClick={() => {
                format("table");
                setMenu(false);
              }}
            >
              Insert table
            </button>
            <hr />
            <button
              className="menu-action"
              onClick={() => void call("show_main")}
            >
              <PanelLeft size={15} />
              Open main window
            </button>
            <button
              className="menu-action"
              onClick={() =>
                void call("export_note", { vaultId, path }).catch((e) =>
                  setError(String(e)),
                )
              }
            >
              <Download size={15} />
              Export note
            </button>
            <button
              className="menu-action"
              onClick={() => {
                const newPath = prompt(
                  "New vault-relative filename. Links in other notes will not be rewritten.",
                  actualPath.startsWith("draft-") ? "Note.md" : actualPath,
                );
                if (newPath && newPath !== path)
                  void flush()
                    .then(() =>
                      call("rename_note", {
                        vaultId,
                        path,
                        newPath,
                        expected: saved.current?.revision,
                      }),
                    )
                    .catch((e) => setError(String(e)));
              }}
            >
              Rename note
            </button>
            <button
              className="menu-action danger"
              onClick={() => void remove()}
            >
              <Trash2 size={15} />
              Delete note
            </button>
          </div>
        </>
      )}
      {error && (
        <div className="note-error" role="alert">
          <p>{error}</p>
          <div>
            <button onClick={() => void flush().catch(() => {})}>
              Retry save
            </button>
            <button onClick={() => void reload()}>
              Preserve mine & load disk
            </button>
            <button
              onClick={() =>
                void call("open_recovery").catch((e) => setError(String(e)))
              }
            >
              Recovery copies
            </button>
          </div>
        </div>
      )}
      <div className="note-content">
        <Suspense fallback={<div className="loading">Opening your note…</div>}>
          {document ? (
            <MarkdownEditor readOnly={finishing} ref={editor} value={text} onChange={change} dark={dark} onLink={(u) => void external(u)} rendered={style.mode === "view" && !plain} plain={plain} preview={{ dark, vaultId, path: actualPath, onWiki: (t) => void wiki(t) }} heading={heading} />
          ) : <div className="loading">Opening your note…</div>}
        </Suspense>
      </div>
      {!desktop && (
        <button className="demo-back" onClick={() => void call("show_main")}>
          <ArrowLeft size={14} />
          All notes
        </button>
      )}
    </div>
  );
}

function SettingsDialog({
  config,
  close,
  refresh,
}: {
  config: Config;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings>(config.settings);
  const [tab, setTab] = useState("general");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [repo, setRepo] = useState("sticky-markers");
  const [account, setAccount] = useState("");
  const [device, setDevice] = useState<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    interval: number;
  } | null>(null);
  const active = config.vaults.find((v) => v.id === config.activeVault);
  const [frequency, setFrequency] = useState(
    active?.github?.frequencyMinutes ?? 5,
  );
  const [exitSync, setExitSync] = useState(active?.github?.onExit ?? true);
  const [paused, setPaused] = useState(active?.github?.paused ?? false);
  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
      if (success) setMessage(success);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!desktop) return;
    void call<{ login: string }>("github_account")
      .then((a) => setAccount(a.login))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!device) return;
    let live = true;
    const timer = setInterval(
      () => {
        void call<{ login?: string; error?: string }>("github_poll", {
          clientId: settings.githubClientId,
          deviceCode: device.deviceCode,
        })
          .then((r) => {
            if (!live) return;
            if (r.login) {
              setAccount(r.login);
              setDevice(null);
              setMessage(
                "Signed in. You can now create a private synced vault.",
              );
            } else if (r.error === "slow_down") {
              setDevice((d) => (d ? { ...d, interval: d.interval + 5 } : null));
            } else if (r.error && r.error !== "authorization_pending") {
              setError(r.error);
              setDevice(null);
            }
          })
          .catch((e) => {
            if (live) setError(String(e));
          });
      },
      Math.max(5, device.interval) * 1000,
    );
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [device, settings.githubClientId]);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  useEffect(() => { void call<string[]>("system_fonts").then(setSystemFonts).catch((e) => setError(String(e))); }, []);
  const field = (patch: Partial<Settings>) =>
    setSettings((s) => ({ ...s, ...patch }));
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <header>
          <div>
            <small>MAKE IT YOURS</small>
            <h2>A little personal.</h2>
          </div>
          <Button label="Close settings" onClick={close}>
            <X size={19} />
          </Button>
        </header>
        <nav className="settings-tabs">
          {[
            ["general", "Notes & appearance"],
            ["vaults", "Vaults & GitHub"],
            ["mcp", "MCP access"],
            ["updates", "Updates"],
          ].map(([id, label]) => (
            <button
              className={tab === id ? "active" : ""}
              key={id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {tab === "updates" && <>
            <UpdatePanel/>
            <label className="setting-row"><span><strong>Automatic update checks</strong><small>Check shortly after launch and every six hours.</small></span><input type="checkbox" checked={settings.checkUpdates ?? true} onChange={e=>field({checkUpdates:e.target.checked})}/></label>
            <button className="secondary" disabled={busy} onClick={()=>void run(()=>call("set_settings",{settings}),"Update preferences saved.")}>Save update preferences</button>
          </>}
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          {message && <div className="success-banner">{message}</div>}
          {tab === "general" && (
            <>
              <label className="setting-row">
                <span>
                  <strong>Appearance</strong>
                  <small>Follow your day, or choose a mood.</small>
                </span>
                <select
                  value={settings.appearance}
                  onChange={(e) =>
                    field({
                      appearance: e.target.value as Settings["appearance"],
                    })
                  }
                >
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <label className="setting-row">
                <span>
                  <strong>New notes open in</strong>
                  <small>Both modes are editable. Rendered mode previews Markdown as you type.</small>
                </span>
                <select
                  value={settings.mode}
                  onChange={(e) =>
                    field({ mode: e.target.value as Settings["mode"] })
                  }
                >
                  <option value="edit">Edit mode</option>
                  <option value="view">Rendered mode</option>
                </select>
              </label>
              <div className="setting-row">
                <span>
                  <strong>New note size</strong>
                  <small>Logical pixels. Each note can be resized.</small>
                </span>
                <div className="size-fields">
                  <input
                    aria-label="Default width"
                    type="number"
                    min="340"
                    max="1600"
                    value={settings.width}
                    onChange={(e) => field({ width: Number(e.target.value) })}
                  />
                  <span>×</span>
                  <input
                    aria-label="Default height"
                    type="number"
                    min="240"
                    max="1600"
                    value={settings.height}
                    onChange={(e) => field({ height: Number(e.target.value) })}
                  />
                </div>
              </div>
              <label className="setting-row">
                <strong>Default palette</strong>
                <select
                  value={settings.palette}
                  onChange={(e) => field({ palette: e.target.value })}
                >
                  {Object.entries(palettes).map(([id, p]) => (
                    <option value={id} key={id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="setting-row">
                <strong>Default font</strong>
                <select
                  value={settings.font}
                  onChange={(e) => field({ font: e.target.value })}
                >
                  <option value="sans">Sans serif</option>
                  <option value="serif">Serif</option>
                  <option value="mono">Monospace</option>
                  {settings.font && !["sans", "serif", "mono", ...systemFonts].includes(settings.font) && <option value={settings.font}>{settings.font}</option>}
                  <optgroup label="System fonts">{systemFonts.map((font) => <option key={font} value={font}>{font}</option>)}</optgroup>
                </select>
              </label>
              <label className="setting-row">
                <strong>Default font size</strong>
                <input
                  type="number"
                  min="10"
                  max="48"
                  value={settings.fontSize}
                  onChange={(e) => field({ fontSize: Number(e.target.value) })}
                />
              </label>
              <p className="settings-help">
                Defaults apply to new notes. Existing notes keep their own
                style.
              </p>
              <button
                className="text-button"
                onClick={() => void run(() => call("open_recovery"))}
              >
                Open local recovery copies <ArrowUpRight size={14} />
              </button>
            </>
          )}
          {tab === "vaults" && (
            <>
              <h3>Your folders</h3>
              {config.vaults.map((v) => (
                <div className="vault-setting" key={v.id}>
                  <FolderOpen size={18} />
                  <div>
                    <strong>{v.name}</strong>
                    <small>{v.path}</small>
                    <small>
                      {v.github
                        ? `GitHub synced · ${v.github.repository}`
                        : "Externally managed · no app sync"}
                    </small>
                  </div>
                </div>
              ))}
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void run(registerFolder)}
              >
                <Plus size={15} />
                Open a folder or Obsidian vault
              </button>
              <hr />
              <h3>Private GitHub vault</h3>
              <p className="settings-help">
                A separate private repository, managed by Sticky Markers.
                Existing Git repositories and Obsidian sync remain managed by
                their owners.
              </p>
              {account ? (
                <div className="account">
                  <Github size={17} />
                  Signed in as <strong>{account}</strong>
                  <button
                    onClick={() =>
                      void run(async () => {
                        await call("github_sign_out");
                        setAccount("");
                      })
                    }
                  >
                    Sign out
                  </button>
                </div>
              ) : (
                <>
                  <label className="stacked-label">
                    GitHub OAuth client ID
                    <input
                      placeholder="Public application client ID"
                      value={settings.githubClientId}
                      onChange={(e) =>
                        field({ githubClientId: e.target.value })
                      }
                    />
                  </label>
                  <p className="settings-help">
                    Development builds need a registered GitHub OAuth app with
                    device flow enabled. This is a public identifier, not a
                    token.
                  </p>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await call("set_settings", { settings });
                        setDevice(
                          await call("github_start", {
                            clientId: settings.githubClientId,
                          }),
                        );
                      })
                    }
                  >
                    <Github size={16} />
                    Sign in to GitHub
                  </button>
                </>
              )}
              {device && (
                <div className="device-code">
                  <p>Enter this code on GitHub:</p>
                  <strong>{device.userCode}</strong>
                  <button
                    className="text-button"
                    onClick={() => void external(device.verificationUri)}
                  >
                    Open GitHub authorization <ArrowUpRight size={14} />
                  </button>
                </div>
              )}
              <label className="stacked-label">
                New private repository name
                <input value={repo} onChange={(e) => setRepo(e.target.value)} />
              </label>
              <button
                className="primary"
                disabled={busy || !account}
                onClick={() =>
                  void run(async () => {
                    const path = await pickFolder();
                    if (!path) return;
                    await call<Vault>("github_create", { name: repo, path });
                  }, "Private vault created. Use Sync Now to download its initial contents.")
                }
              >
                <Plus size={16} />
                Create in an empty folder
              </button>
              <button
                className="text-button"
                disabled={busy || !account}
                onClick={() =>
                  void run(async () => {
                    const repository = prompt(
                      "Existing app-created repository (owner/name)",
                    );
                    if (!repository) return;
                    const path = await pickFolder();
                    if (path)
                      await call("github_reconnect", { repository, path });
                  })
                }
              >
                Reconnect an app-created vault
              </button>
              {active?.github && (
                <div className="sync-options">
                  <h3>Sync · {active.name}</h3>
                  <label className="setting-row">
                    <span>
                      Every (minutes)<small>0 means manual only.</small>
                    </span>
                    <input
                      type="number"
                      min="0"
                      max="1440"
                      value={frequency}
                      onChange={(e) => setFrequency(Number(e.target.value))}
                    />
                  </label>
                  <label className="setting-row">
                    Sync on exit
                    <input
                      type="checkbox"
                      checked={exitSync}
                      onChange={(e) => setExitSync(e.target.checked)}
                    />
                  </label>
                  <label className="setting-row">
                    Pause scheduled sync
                    <input
                      type="checkbox"
                      checked={paused}
                      onChange={(e) => setPaused(e.target.checked)}
                    />
                  </label>
                  <button
                    className="secondary"
                    onClick={() =>
                      void run(
                        () =>
                          call("set_sync_options", {
                            vaultId: active.id,
                            frequencyMinutes: frequency,
                            onExit: exitSync,
                            paused,
                          }),
                        "Sync settings saved.",
                      )
                    }
                    disabled={busy}
                  >
                    Save sync settings
                  </button>
                  <button
                    className="text-button"
                    onClick={() =>
                      void run(
                        () => call("sync_vault", { vaultId: active.id }),
                        "Synced to GitHub.",
                      )
                    }
                    disabled={busy}
                  >
                    <RefreshCw size={15} />
                    Sync now
                  </button>
                  <button
                    className="text-button"
                    onClick={() => {
                      const name = prompt(
                        "Rename the GitHub repository",
                        active.github?.repository.split("/")[1],
                      );
                      if (name)
                        void run(() =>
                          call("github_rename", { vaultId: active.id, name }),
                        );
                    }}
                  >
                    Rename repository
                  </button>
                  {active.github.error && (
                    <p className="error-text">{active.github.error}</p>
                  )}
                  {active.github.conflicts?.map((path) => (
                    <div className="sync-conflict" key={path}>
                      <strong>{path}</strong>
                      <p className="settings-help">
                        Both versions are in recovery. Choose which file should
                        be kept, then sync again.
                      </p>
                      {["local", "remote"].map((choice) => (
                        <button
                          className="secondary"
                          key={choice}
                          disabled={busy}
                          onClick={() => {
                            if (
                              confirm(
                                `Keep ${choice === "local" ? "this device’s" : "GitHub’s"} version of ${path}? Both copies stay in local recovery.`,
                              )
                            )
                              void run(
                                () =>
                                  call("resolve_sync_conflict", {
                                    vaultId: active.id,
                                    path,
                                    choice,
                                  }),
                                "Conflict choice saved. Sync again when ready.",
                              );
                          }}
                        >
                          {choice === "local" ? "Keep local" : "Use GitHub"}
                        </button>
                      ))}
                    </div>
                  ))}
                  <small>
                    {active.github.lastSync
                      ? `Last synced ${new Date(active.github.lastSync * 1000).toLocaleString()}`
                      : "Not synced yet. Your notes are saved locally."}
                  </small>
                </div>
              )}
            </>
          )}
          {tab === "mcp" && (
            <>
              <h3>A note from anywhere you work.</h3>
              <p className="settings-help">
                Connect a local MCP harness to create, read, and edit notes.
                Dictation works if your harness supports it. The desktop app can
                be closed.
              </p>
              <p className="settings-help">
                Grant each vault explicitly. The server never pushes or pulls
                externally managed repositories.
              </p>
              {config.vaults.map((v) => (
                <div className="mcp-vault" key={v.id}>
                  <strong>{v.name}</strong>
                  <code>{v.id}</code>
                </div>
              ))}
              <pre className="config-code">
                {JSON.stringify(
                  {
                    mcpServers: {
                      "sticky-markers": {
                        command: "sticky-markers-mcp",
                        args: config.vaults
                          .slice(0, 1)
                          .flatMap((v) => ["--vault", v.id]),
                      },
                    },
                  },
                  null,
                  2,
                )}
              </pre>
              <button
                className="secondary"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(
                      JSON.stringify(
                        {
                          mcpServers: {
                            "sticky-markers": {
                              command: "sticky-markers-mcp",
                              args: config.vaults
                                .slice(0, 1)
                                .flatMap((v) => ["--vault", v.id]),
                            },
                          },
                        },
                        null,
                        2,
                      ),
                    )
                    .then(() =>
                      setMessage(
                        "MCP configuration copied. Use the installed executable’s full path.",
                      ),
                    )
                    .catch((e) => setError(String(e)))
                }
              >
                <Copy size={15} />
                Copy configuration
              </button>
              <p className="settings-help">
                Use the full path to the installed MCP executable. Add
                --read-only for a read-only connection. Cloud-only harnesses
                need an authenticated bridge; this release uses local stdio.
              </p>
            </>
          )}
        </div>
        <footer>
          <span>{busy ? "Working…" : "Your notes stay plain Markdown."}</span>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(
                () => call("set_settings", { settings }),
                "Preferences saved.",
              )
            }
          >
            <Check size={15} />
            Save preferences
          </button>
        </footer>
      </section>
    </div>
  );
}
