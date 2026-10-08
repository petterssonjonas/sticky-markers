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
  type LibraryPage,
  type NoteStyle,
  type Settings,
  type Vault,
  defaultStyle,
  mainVault,
} from "./types";
import { colors, fonts } from "./palettes";
import {
  ColorSwatches,
  ColorDropdown,
  VaultIcon,
  FontOptions,
} from "./preferences";
import { Collection } from "./collection";
import { UpdateNotice, UpdatePanel } from "./updates";
import { type EditorHandle } from "./editor";
const MarkdownEditor = lazy(() =>
  import("./editor").then((m) => ({ default: m.MarkdownEditor })),
);
const Markdown = lazy(() =>
  import("./markdown").then((m) => ({ default: m.Markdown })),
);

const formattingTools = [
  { id: "bold", label: "Bold", icon: Bold },
  { id: "italic", label: "Italic", icon: Italic },
  { id: "underline", label: "Underline", icon: Underline },
  { id: "strike", label: "Strikethrough", icon: Strikethrough },
  { id: "bullets", label: "Bullets", icon: List },
  { id: "heading", label: "Insert heading", icon: Heading },
  { id: "code", label: "Inline code", icon: Code2 },
  { id: "codeblock", label: "Code block", icon: Code2 },
  { id: "table", label: "Insert table", icon: FileText },
];

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
  const [settingsTab, setSettingsTab] = useState<string | null>(null);
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
    window.addEventListener("demo-notes-changed", refresh);
    const storage = (event: StorageEvent) => {
      if (event.key === "sticky-markers-browser-demo-v1") void refresh();
    };
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener("popstate", route);
      window.removeEventListener("demo-notes-changed", refresh);
      window.removeEventListener("storage", storage);
    };
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
  return (
    <>
      <UpdateNotice />
      {path && vaultId ? (
        <NoteWindow
          key={`${vaultId}/${path}`}
          vaultId={vaultId}
          path={path}
          config={config}
          dark={dark}
          refresh={refresh}
        />
      ) : (
        <>
          <Collection
            config={config}
            refresh={refresh}
            dark={dark}
            openSettings={setSettingsTab}
            settingsTab={settingsTab}
            settingsContent={
              settingsTab ? (
                <SettingsDialog
                  config={config}
                  onAppearance={(appearance) =>
                    setConfig((c) =>
                      c ? { ...c, settings: { ...c.settings, appearance } } : c,
                    )
                  }
                  refresh={refresh}
                  initialTab={settingsTab}
                />
              ) : null
            }
          />
        </>
      )}
    </>
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
    config.styles[`${vaultId}/${path}`] ??
      defaultStyle(
        config.settings,
        config.vaults.find((v) => v.id === vaultId),
      ),
  );
  const [menu, setMenu] = useState(false);
  const [headings, setHeadings] = useState(false);

  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [status, setStatus] = useState(
    path.startsWith("draft-") ? "Empty draft" : "Saved locally",
  );
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
  const [heading, setHeading] = useState(
    new URLSearchParams(location.search).get("heading") ?? "",
  );
  const journalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vault = config.vaults.find((v) => v.id === vaultId);
  const c = colors(style.palette, style.color, dark);
  const actualPath = document?.path ?? path;
  const plain =
    !path.startsWith("draft-") && !/\.(md|markdown|mdown)$/i.test(actualPath);
  const noteMode = plain ? "edit" : config.settings.mode;
  const destinationVault = mainVault(config)?.id;
  const toolbarPins = config.settings.toolbarPins ?? [];
  useEffect(() => {
    if (menu && !systemFonts.length)
      void call<string[]>("system_fonts")
        .then(setSystemFonts)
        .catch((e) => setError(String(e)));
  }, [menu]);
  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (journalTimer.current) {
      clearTimeout(journalTimer.current);
      journalTimer.current = null;
    }
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
      .then(async (d) => {
        const freshConfig = await call<Config>("bootstrap");
        if (live) {
          saved.current = d;
          current.current = d.content;
          setDocument(d);
          setText(d.content);
          const persistedStyle = freshConfig.styles[`${vaultId}/${d.path}`];
          if (persistedStyle) setStyle(persistedStyle);
          else if (
            !/\.(md|markdown|mdown)$/i.test(d.path) &&
            !d.path.startsWith("draft-")
          )
            setStyle((s) => ({ ...s, mode: "edit", font: "mono" }));
          setStatus(
            d.path.startsWith("draft-") ? "Empty draft" : "Saved locally",
          );
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
        .then(() => call("cleanup_new_note", { vaultId, path }))
        .then(() =>
          call("quit_ready", { label: getCurrentWindow().label, ok: true }),
        )
        .catch(() =>
          call("quit_ready", { label: getCurrentWindow().label, ok: false }),
        );
    });
    const moveListener = listen("prepare-move", () => void close());
    const cancelListener = listen("quit-cancelled", () => {
      closing.current = false;
      setFinishing(false);
      editor.current?.setReadOnly(false);
    });
    return () => {
      void closeListener.then((f) => f());
      void quitListener.then((f) => f());
      void cancelListener.then((f) => f());
      void moveListener.then((f) => f());
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
          .then(() => call("new_note", { vaultId: destinationVault }))
          .catch((e) => setError(String(e)));
      } else if (["b", "i", "u"].includes(k)) {
        e.preventDefault();
        editor.current?.format({ b: "bold", i: "italic", u: "underline" }[k]!);
      }
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [flush, vaultId, destinationVault]);
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
    const next = { ...styleRef.current, ...patch, palette: "classic" };
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
      await call("editor_preferences", { mode: next });
      await refresh();
      setMenu(false);
    } catch {}
  };
  useEffect(() => {
    if (heading && noteMode !== "view" && document) void mode("view");
  }, [heading, document?.path]);
  useEffect(() => {
    if (!desktop) return;
    const un = listen<string>("navigate-heading", (e) => {
      setHeading(e.payload);
      void mode("view");
    });
    return () => {
      void un.then((f) => f());
    };
  }, [vaultId, path]);
  const format = (kind: string) => {
    if (closing.current) return;
    editor.current?.format(kind);
  };
  const newNote = async () => {
    if (closing.current) return;
    try {
      await flush();
      await call("new_note", { vaultId: destinationVault });
    } catch (e) {
      setError(String(e));
    }
  };
  const wiki = async (target: string) => {
    try {
      const [name, anchor] = target.split("#");
      if (!name && anchor) {
        setHeading(anchor);
        await mode("view");
        return;
      }
      const filename = name.endsWith(".md") ? name : `${name}.md`;
      const relative = [...path.split("/").slice(0, -1)];
      for (const part of filename.split("/")) {
        if (part === "..") relative.pop();
        else if (part !== ".") relative.push(part);
      }
      // Exact paths avoid both a content scan and ambiguity from incoming links.
      for (const candidate of new Set([relative.join("/"), filename])) {
        let exists = false;
        try {
          await call<Document>("read_note", { vaultId, path: candidate });
          exists = true;
        } catch {}
        if (exists) {
          await call("open_note", {
            vaultId,
            path: candidate,
            heading: anchor,
          });
          return;
        }
      }
      for (let offset = 0; ; offset += 100) {
        const result = await call<LibraryPage>("library_page", {
          vaultId,
          query: name,
          offset,
          limit: 100,
        });
        const found = result.notes.find(
          (n) => n.path.split("/").pop() === filename,
        );
        if (found) {
          await call("open_note", {
            vaultId,
            path: found.path,
            heading: anchor,
          });
          return;
        }
        if (
          offset + result.notes.length >= result.total ||
          !result.notes.length
        )
          break;
      }
      throw new Error(`No note named “${name}” in this vault.`);
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
          "--note-font":
            fonts[style.font] ??
            `${JSON.stringify(style.font)}, system-ui, sans-serif`,
          "--note-font-size": `${style.fontSize}px`,
        } as CSSProperties
      }
    >
      <header className="note-header">
        <Button label="New note" onClick={() => void newNote()}>
          <Plus size={19} />
        </Button>
        <Button
          label={style.pinned ? "Unpin note" : "Pin note"}
          pressed={!!style.pinned}
          onClick={() =>
            void updateStyle({
              pinned: !style.pinned,
              pinnedAt: !style.pinned ? Date.now() : 0,
            })
          }
        >
          <Pin size={17} />
        </Button>
        <div
          className="note-drag"
          data-tauri-drag-region
          title={`${vault?.name} / ${actualPath}`}
        >
          {actualPath.startsWith("draft-") ||
          (style.provisional && !document?.content.trim())
            ? "New note"
            : actualPath
                .split("/")
                .pop()
                ?.replace(/\.(md|markdown|mdown)$/i, "")}
        </div>
        <div className="format-buttons">
          {formattingTools
            .filter((tool) => toolbarPins.includes(tool.id))
            .map(({ id, label, icon: Icon }) => (
              <div className="heading-control" key={id}>
                <Button
                  label={label}
                  onClick={() =>
                    id === "heading" ? setHeadings(!headings) : format(id)
                  }
                >
                  <Icon size={15} />
                  {id === "heading" && <ChevronDown size={10} />}
                </Button>
                {id === "heading" && headings && !menu && (
                  <div className="heading-menu">
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <button
                        key={n}
                        onClick={() => {
                          format(`heading${n}`);
                          setHeadings(false);
                        }}
                      >
                        Heading {n}
                        <span>{"#".repeat(n)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          {toolbarPins.includes("delete") && (
            <Button
              label="Delete note"
              className="danger"
              onClick={() => void remove()}
            >
              <Trash2 size={15} />
            </Button>
          )}
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
            <div className="menu-vault">
              <FolderOpen size={13} />
              {vault?.name}
            </div>
            <ColorSwatches
              value={style.color}
              dark={dark}
              onChange={(color) => void updateStyle({ color })}
            />
            <div className="mode-switch">
              <button
                className={noteMode === "edit" ? "active" : ""}
                onClick={() => void mode("edit")}
              >
                <Code2 size={14} />
                Edit
              </button>
              <button
                className={noteMode === "view" ? "active" : ""}
                disabled={plain}
                title={
                  plain
                    ? "Rendered mode is available for Markdown notes"
                    : undefined
                }
                onClick={() => void mode("view")}
              >
                <Eye size={14} />
                Rendered
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
                  <FontOptions current={style.font} system={systemFonts} />
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
            <div className="format-menu">
              {formattingTools.map(({ id, label, icon: Icon }) => (
                <div key={id}>
                  <div className="format-menu-row">
                    <button
                      className="menu-action"
                      onClick={() => {
                        if (id === "heading") setHeadings(!headings);
                        else {
                          format(id);
                          setMenu(false);
                        }
                      }}
                    >
                      <Icon size={15} />
                      {label}
                      {id === "heading" && <ChevronDown size={12} />}
                    </button>
                    <button
                      className="format-pin"
                      aria-label={`${toolbarPins.includes(id) ? "Unpin" : "Pin"} ${label} to toolbar`}
                      aria-pressed={toolbarPins.includes(id)}
                      onClick={() =>
                        void call("editor_preferences", {
                          toolbarPins: toolbarPins.includes(id)
                            ? toolbarPins.filter((p) => p !== id)
                            : [...toolbarPins, id],
                        })
                          .then(refresh)
                          .catch((e) => setError(String(e)))
                      }
                    >
                      <Pin size={13} />
                    </button>
                  </div>
                  {id === "heading" && headings && (
                    <div className="heading-menu">
                      {[1, 2, 3, 4, 5, 6].map((n) => (
                        <button
                          key={n}
                          onClick={() => {
                            format(`heading${n}`);
                            setHeadings(false);
                            setMenu(false);
                          }}
                        >
                          Heading {n}
                          <span>{"#".repeat(n)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
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
            {config.vaults.length > 1 && (
              <details className="vault-destination">
                <summary className="menu-action">
                  <FolderOpen size={15} />
                  Save to another vault…
                  <ChevronDown size={14} />
                </summary>
                {config.vaults
                  .filter((v) => v.id !== vaultId)
                  .map((v) => (
                    <button
                      key={v.id}
                      className="menu-action"
                      onClick={() => {
                        closing.current = true;
                        setFinishing(true);
                        editor.current?.setReadOnly(true);
                        void flush()
                          .then(() =>
                            call("save_to_vault", {
                              vaultId,
                              path,
                              destination: v.id,
                              expected: saved.current?.revision,
                            }),
                          )
                          .catch((e) => {
                            closing.current = false;
                            setFinishing(false);
                            editor.current?.setReadOnly(false);
                            setError(String(e));
                          });
                      }}
                    >
                      <VaultIcon vault={v} />
                      {v.name}
                    </button>
                  ))}
              </details>
            )}
            <div className="format-menu-row">
              <button
                className="menu-action danger"
                onClick={() => void remove()}
              >
                <Trash2 size={15} />
                Delete note
              </button>
              <button
                className="format-pin"
                aria-label={`${toolbarPins.includes("delete") ? "Unpin" : "Pin"} Delete note to toolbar`}
                aria-pressed={toolbarPins.includes("delete")}
                onClick={() =>
                  void call("editor_preferences", {
                    toolbarPins: toolbarPins.includes("delete")
                      ? toolbarPins.filter((p) => p !== "delete")
                      : [...toolbarPins, "delete"],
                  })
                    .then(refresh)
                    .catch((e) => setError(String(e)))
                }
              >
                <Pin size={13} />
              </button>
            </div>
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
            <MarkdownEditor
              readOnly={finishing}
              ref={editor}
              value={text}
              onChange={change}
              dark={dark}
              onLink={(u) => void external(u)}
              rendered={noteMode === "view" && !plain}
              plain={plain}
              preview={{
                dark,
                vaultId,
                path: actualPath,
                onWiki: (t) => void wiki(t),
              }}
              heading={heading}
            />
          ) : (
            <div className="loading">Opening your note…</div>
          )}
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
  onAppearance,
  refresh,
  initialTab = "general",
}: {
  config: Config;
  onAppearance: (appearance: Settings["appearance"]) => void;
  refresh: () => Promise<void>;
  initialTab?: string;
}) {
  const [settings, setSettings] = useState<Settings>(config.settings);
  const dark = useDark(settings.appearance);
  const [tab, setTab] = useState(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
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
  useEffect(() => {
    void call<string[]>("system_fonts")
      .then(setSystemFonts)
      .catch((e) => setError(String(e)));
  }, []);
  const appearanceQueue = useRef(Promise.resolve());
  const changeAppearance = (appearance: Settings["appearance"]) => {
    field({ appearance });
    onAppearance(appearance);
    appearanceQueue.current = appearanceQueue.current.then(async () => {
      try {
        await call("set_appearance", { appearance });
      } catch (e) {
        setError(String(e));
        await refresh();
      }
    });
  };
  const field = (patch: Partial<Settings>) =>
    setSettings((s) => ({ ...s, ...patch }));
  return (
    <section
      className="settings-dialog settings-pane"
      role="region"
      aria-label="Settings"
    >
      <header>
        <h2>Settings</h2>
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
        {tab === "updates" && (
          <>
            <UpdatePanel />
            <label className="setting-row">
              <span>
                <strong>Automatic update checks</strong>
                <small>Check shortly after launch and every six hours.</small>
              </span>
              <input
                type="checkbox"
                checked={settings.checkUpdates ?? true}
                onChange={(e) => field({ checkUpdates: e.target.checked })}
              />
            </label>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(
                  () => call("set_settings", { settings }),
                  "Update preferences saved.",
                )
              }
            >
              Save update preferences
            </button>
          </>
        )}
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
                  changeAppearance(e.target.value as Settings["appearance"])
                }
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <label className="setting-row">
              <span>
                <strong>Editor mode (all Markdown notes)</strong>
                <small>
                  Changing this updates every Markdown note window. Other text
                  formats stay in source mode.
                </small>
              </span>
              <select
                value={settings.mode}
                onChange={(e) =>
                  field({ mode: e.target.value as Settings["mode"] })
                }
              >
                <option value="edit">Edit</option>
                <option value="view">Rendered</option>
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
            <div className="setting-color">
              <strong>Default note color</strong>
              <ColorSwatches
                label="Default note color"
                value={settings.color}
                dark={dark}
                onChange={(color) => field({ color })}
              />
            </div>
            <label className="setting-row">
              <strong>Default Note font</strong>
              <select
                value={settings.font}
                onChange={(e) => field({ font: e.target.value })}
              >
                <FontOptions current={settings.font} system={systemFonts} />
              </select>
            </label>
            <label className="setting-row">
              <strong>Default Note size</strong>
              <input
                type="number"
                min="10"
                max="48"
                value={settings.fontSize}
                onChange={(e) => field({ fontSize: Number(e.target.value) })}
              />
            </label>
            <p className="settings-help">
              Font and size defaults apply to new notes. Editor mode and pinned
              formatting tools apply to every note.
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
                <VaultIcon vault={v} size={18} />
                <div className="vault-identity">
                  <div className="vault-title-row">
                    <strong>{v.name}</strong>
                    <button
                      className="text-button"
                      aria-pressed={mainVault(config)?.id === v.id}
                      onClick={() =>
                        void run(() =>
                          call("set_main_vault", { vaultId: v.id }),
                        )
                      }
                    >
                      <Pin size={13} />
                      {mainVault(config)?.id === v.id
                        ? "Main vault"
                        : "Set as main vault"}
                    </button>
                  </div>
                  <small>{v.path}</small>
                  {v.github && (
                    <small>GitHub synced · {v.github.repository}</small>
                  )}
                </div>
                <div className="vault-default-color">
                  <div className="vault-color-label">
                    <strong>Default note color</strong>
                    <button
                      className="text-button"
                      aria-pressed={v.defaultColor == null}
                      onClick={() =>
                        void run(() =>
                          call("set_vault_defaults", {
                            vaultId: v.id,
                            color: null,
                          }),
                        )
                      }
                    >
                      Use app default
                    </button>
                  </div>
                  <ColorDropdown
                    label={`Default color for ${v.name}`}
                    value={v.defaultColor ?? config.settings.color}
                    dark={dark}
                    onChange={(color) =>
                      void run(() =>
                        call("set_vault_defaults", { vaultId: v.id, color }),
                      )
                    }
                  />
                </div>
              </div>
            ))}
            <div className="action-row">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void run(registerFolder)}
              >
                <FolderOpen size={15} />
                Open a vault…
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const parent = await pickFolder(
                      "Choose where to create the vault",
                    );
                    if (!parent) return;
                    const name = prompt(
                      "Name of the new vault folder",
                      "Notes",
                    );
                    if (name) await call("create_vault", { parent, name });
                  })
                }
              >
                <Plus size={15} />
                Create a vault…
              </button>
            </div>
            <hr />
            <h3>Private GitHub vault</h3>
            <p className="settings-help">
              A separate private repository, managed by Sticky Markers. Existing
              repositories remain managed by their owners.
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
                    onChange={(e) => field({ githubClientId: e.target.value })}
                  />
                </label>
                <p className="settings-help">
                  Development builds need a registered GitHub OAuth app with
                  device flow enabled. This is a public identifier, not a token.
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
            <div className="action-row">
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
            </div>
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
                      Both versions are in recovery. Choose which file should be
                      kept, then sync again.
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
              Use the full path to the installed MCP executable. Add --read-only
              for a read-only connection. Cloud-only harnesses need an
              authenticated bridge; this release uses local stdio.
            </p>
          </>
        )}
      </div>
      <footer>
        <span>{busy ? "Working…" : ""}</span>
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
  );
}
