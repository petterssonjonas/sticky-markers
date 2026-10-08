import { VaultIcon } from "./preferences";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  memo,
  type CSSProperties,
  type ReactNode,
  type MouseEvent,
  type DragEvent,
} from "react";
import {
  Leaf,
  Plus,
  Pin,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  FolderOpen,
  Search,
  Settings,
  X,
  Github,
  Upload,
  RefreshCw,
  ArrowUpRight,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { call, desktop, registerFolder } from "./api";
import {
  mainVault,
  defaultStyle,
  type Config,
  type LibraryEntry,
  type LibraryPage,
  type Document,
  type Vault,
} from "./types";
import { colors } from "./palettes";
const Markdown = lazy(() =>
  import("./markdown").then((m) => ({ default: m.Markdown })),
);
const ignoreWiki = () => {};
const dragType = "application/x-sticky-markers-notes";
const noteKey = (n: { vaultId: string; path: string }) =>
  `${n.vaultId}/${n.path}`;

function useLibrary(
  vaultId: string | undefined,
  enabled: boolean,
  sort: string,
  query: string,
  pinned: boolean,
  pageSize: number,
) {
  const [page, setPage] = useState<LibraryPage>({ notes: [], total: 0 });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0),
    inFlight = useRef(false),
    count = useRef(pageSize);
  const fetchPage = useCallback(
    async (more = false) => {
      if (!vaultId || !enabled || inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      const token = generation.current;
      try {
        const offset = more ? count.current : 0;
        const wanted = more ? pageSize : Math.max(pageSize, count.current);
        let result: LibraryPage = { notes: [], total: 0 };
        do {
          const batch = await call<LibraryPage>("library_page", {
            vaultId,
            offset: offset + result.notes.length,
            limit: Math.min(100, wanted - result.notes.length),
            sort,
            query,
            pinned,
          });
          result = {
            notes: [...result.notes, ...batch.notes],
            total: batch.total,
          };
          if (!batch.notes.length) break;
        } while (
          result.notes.length < wanted &&
          offset + result.notes.length < result.total
        );
        if (token !== generation.current) return;
        setPage((p) => ({
          total: result.total,
          notes: more ? [...p.notes, ...result.notes] : result.notes,
        }));
        count.current = offset + result.notes.length;
        setError("");
      } catch (e) {
        if (token === generation.current) setError(String(e));
      } finally {
        if (token === generation.current) {
          inFlight.current = false;
          setBusy(false);
        }
      }
    },
    [vaultId, enabled, sort, query, pinned, pageSize],
  );
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    count.current = pageSize;
    setPage({ notes: [], total: 0 });
    setBusy(false);
    const timer = setTimeout(() => void fetchPage(), query ? 150 : 0);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [fetchPage, query, pageSize]);
  useEffect(() => {
    if (!enabled) return;
    let debounce: ReturnType<typeof setTimeout>;
    const refresh = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void fetchPage(), 250);
    };
    const event = desktop ? listen("notes-changed", refresh) : null;
    window.addEventListener("demo-notes-changed", refresh);
    const interval = setInterval(() => {
      if (!document.hidden) refresh();
    }, 11000);
    return () => {
      clearTimeout(debounce);
      clearInterval(interval);
      window.removeEventListener("demo-notes-changed", refresh);
      void event?.then((f) => f());
    };
  }, [enabled, fetchPage]);
  return {
    ...page,
    error,
    busy,
    more: () => void fetchPage(true),
    reload: () => void fetchPage(),
  };
}

const PreviewCard = memo(function PreviewCard({
  note,
  config,
  dark,
  onOpen,
}: {
  note: LibraryEntry;
  config: Config;
  dark: boolean;
  onOpen: () => void;
}) {
  const host = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(false);
  const [content, setContent] = useState("");
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setNear(entries.some((e) => e.isIntersecting));
      },
      { rootMargin: "150px" },
    );
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!near) return;
    let live = true;
    void call<Document>("read_note", { vaultId: note.vaultId, path: note.path })
      .then((d) => {
        if (live) setContent(d.content.slice(0, 4096));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [near, note.vaultId, note.path, note.modified, note.size]);
  const s =
    config.styles[noteKey(note)] ??
    defaultStyle(
      config.settings,
      config.vaults.find((v) => v.id === note.vaultId),
    );
  const c = colors("classic", s.color, dark);
  return (
    <button
      ref={host}
      className="note-card"
      style={
        {
          "--paper": c.body,
          "--ink": c.ink,
          "--rotation": "0deg",
        } as CSSProperties
      }
      onClick={onOpen}
    >
      <div className="card-top">
        <ArrowUpRight size={17} />
        {s.pinned && <Pin size={13} />}
      </div>
      <h2>{note.title.replace(/\.(md|markdown|mdown)$/i, "")}</h2>
      <div className="card-preview">
        <Suspense fallback={null}>
          {near &&
            (/\.(md|markdown|mdown)$/i.test(note.path) ? (
              <Markdown
                content={content}
                dark={dark}
                vaultId={note.vaultId}
                path={note.path}
                onWiki={ignoreWiki}
                preview
              />
            ) : (
              <pre>{content}</pre>
            ))}
        </Suspense>
      </div>
    </button>
  );
});

function VaultList({
  vault,
  open,
  config,
  sort,
  query,
  selected,
  toggle,
  onSelect,
  onOpen,
  onDrag,
  onDrop,
  onMain,
  pinned = false,
}: {
  vault: Vault;
  open: boolean;
  config: Config;
  sort: string;
  query: string;
  selected: Set<string>;
  toggle: () => void;
  onSelect: (
    note: LibraryEntry,
    event: MouseEvent,
    rows: LibraryEntry[],
  ) => void;
  onOpen: (note: LibraryEntry) => void;
  onDrag: (note: LibraryEntry, event: DragEvent) => void;
  onDrop: (event: DragEvent, id: string) => void;
  onMain: () => void;
  pinned?: boolean;
}) {
  const page = useLibrary(vault.id, open, sort, query, pinned, 80);
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [over, setOver] = useState(false);
  const clear = () => {
    if (hover.current) clearTimeout(hover.current);
    hover.current = null;
  };
  useEffect(() => () => clear(), []);
  return (
    <section
      className={`vault-group ${over ? "drop-target" : ""}`}
      onDragOver={(e) => {
        if (pinned || !e.dataTransfer.types.includes(dragType)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
        if (!open && !hover.current)
          hover.current = setTimeout(() => {
            toggle();
            hover.current = null;
          }, 550);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setOver(false);
          clear();
        }
      }}
      onDrop={(e) => {
        clear();
        setOver(false);
        if (!pinned) onDrop(e, vault.id);
      }}
    >
      <div className="vault-row">
        <button
          className="vault-toggle"
          aria-label={`${open ? "Collapse" : "Expand"} ${vault.name}`}
          aria-expanded={open}
          onClick={toggle}
        >
          <ChevronRight size={15} className={open ? "expanded" : ""} />
          {pinned ? <Pin size={16} /> : <VaultIcon vault={vault} />}
          <span>{vault.name}</span>
          {open && <small>{page.total}</small>}
        </button>
        {!pinned && (
          <button
            className="vault-main-pin"
            aria-label={`Set ${vault.name} as main vault`}
            title="Use for new notes and imports"
            aria-pressed={mainVault(config)?.id === vault.id}
            onClick={onMain}
          >
            <Pin size={14} />
          </button>
        )}
      </div>
      {open && (
        <div
          className="vault-notes"
          role="listbox"
          aria-label={`Notes in ${vault.name}`}
          aria-multiselectable="true"
        >
          {page.notes.map((n) => (
            <button
              key={noteKey(n)}
              role="option"
              aria-selected={selected.has(noteKey(n))}
              title={
                pinned
                  ? `${config.vaults.find((v) => v.id === n.vaultId)?.name} / ${n.path}`
                  : n.path
              }
              className="sidebar-note-card"
              draggable
              onDragStart={(e) => onDrag(n, e)}
              onClick={(e) => onSelect(n, e, page.notes)}
              onDoubleClick={() => onOpen(n)}
            >
              {n.path.split("/").pop()}
            </button>
          ))}
          {page.busy && (
            <div className="list-status" role="status">
              Loading…
            </div>
          )}
          {!page.busy && !page.total && !page.error && (
            <div className="list-status">No notes</div>
          )}
          {page.error && (
            <div className="list-status" role="alert">
              {page.error}
            </div>
          )}
          {page.notes.length < page.total && (
            <button
              className="load-more"
              disabled={page.busy}
              onClick={page.more}
            >
              Load more notes
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function Collection({
  config,
  refresh,
  dark,
  openSettings,
  settingsTab,
  settingsContent,
}: {
  config: Config;
  refresh: () => Promise<void>;
  dark: boolean;
  openSettings: (tab: string) => void;
  settingsTab: string | null;
  settingsContent: ReactNode;
}) {
  const main = mainVault(config);
  const [expanded, setExpanded] = useState(false),
    [open, setOpen] = useState<Set<string>>(new Set()),
    [menu, setMenu] = useState(false),
    [filter, setFilter] = useState("all"),
    [sort, setSort] = useState("date"),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null),
    refs = useRef<Map<string, LibraryEntry>>(new Map());
  const gridVault = filter.startsWith("vault:") ? filter.slice(6) : "*";
  const grid = useLibrary(
    gridVault,
    expanded && filter !== "settings",
    sort,
    query,
    filter === "pinned",
    24,
  );
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded || grid.busy || grid.notes.length >= grid.total) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) grid.more();
      },
      { rootMargin: "200px" },
    );
    if (sentinel.current) observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [expanded, grid.busy, grid.notes.length, grid.total, grid.more]);
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        await refresh();
        setError("");
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh],
  );
  const panel = () => {
    const next = !expanded;
    setExpanded(next);
    void run(() => call("main_panel", { expanded: next }));
  };
  const showSettings = (tab: string) => {
    openSettings(tab);
    setFilter("settings");
    if (!expanded) {
      setExpanded(true);
      void run(() => call("main_panel", { expanded: true }));
    }
  };
  useEffect(() => {
    if (settingsTab === null && filter === "settings") setFilter("all");
  }, [settingsTab, filter]);
  const newNote = useCallback(
    () => void run(() => call("new_note", { vaultId: main?.id })),
    [run, main?.id],
  );
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newNote();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "q" && desktop) {
        e.preventDefault();
        void call("quit");
      }
      if (
        e.key === "/" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement) &&
        !(e.target as HTMLElement).isContentEditable
      ) {
        e.preventDefault();
        document
          .querySelector<HTMLInputElement>(".sidebar-search input")
          ?.focus();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [newNote]);
  const toggle = (id: string) => {
    setOpen((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const openNote = (n: LibraryEntry) =>
    void run(() => call("open_note", { vaultId: n.vaultId, path: n.path }));
  const select = (n: LibraryEntry, event: MouseEvent, rows: LibraryEntry[]) => {
    rows.forEach((r) => refs.current.set(noteKey(r), r));
    const key = noteKey(n);
    setSelected((old) => {
      const next = new Set(
        event.ctrlKey || event.metaKey || event.shiftKey ? old : [],
      );
      if (event.shiftKey && anchor.current) {
        const a = rows.findIndex((r) => noteKey(r) === anchor.current),
          b = rows.findIndex((r) => noteKey(r) === key);
        if (a >= 0)
          rows
            .slice(Math.min(a, b), Math.max(a, b) + 1)
            .forEach((r) => next.add(noteKey(r)));
        else next.add(key);
      } else if (event.ctrlKey || event.metaKey) {
        if (next.has(key)) next.delete(key);
        else next.add(key);
      } else next.add(key);
      return next;
    });
    if (!event.shiftKey) anchor.current = key;
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) openNote(n);
  };
  const drag = (n: LibraryEntry, event: DragEvent) => {
    refs.current.set(noteKey(n), n);
    const keys = selected.has(noteKey(n)) ? selected : new Set([noteKey(n)]);
    setSelected(keys);
    const notes = [...keys]
      .map((k) => refs.current.get(k))
      .filter((r): r is LibraryEntry => !!r)
      .map(({ vaultId, path }) => ({ vaultId, path }));
    event.dataTransfer.setData(dragType, JSON.stringify(notes));
    event.dataTransfer.effectAllowed = "move";
  };
  const drop = (event: DragEvent, id: string) => {
    event.preventDefault();
    try {
      const notes = JSON.parse(event.dataTransfer.getData(dragType));
      void run(async () => {
        await call("move_notes", { notes, destination: id });
        setSelected(new Set());
        setOpen((old) => new Set([...old, id]));
        await refresh();
        grid.reload();
      });
    } catch (e) {
      setError(String(e));
    }
  };
  // Browser demo uses navigation rather than native windows, so each library
  // mount reads fresh metadata. Native lists refresh through notes-changed.
  const previewConfig = useMemo(() => config, [config]);
  return (
    <div
      className={`collection ${expanded ? "panel-expanded" : "sidebar-only"}`}
    >
      <aside className="sidebar">
        <div
          className="brand"
          onMouseDown={(event) => {
            if (
              !desktop ||
              event.button !== 0 ||
              (event.target as Element).closest("button, input, select, a")
            )
              return;
            event.preventDefault();
            void getCurrentWindow()
              .startDragging()
              .catch((e) => setError(String(e)));
          }}
        >
          <span className="brand-mark">
            <Leaf size={20} />
          </span>
          <span>
            sticky markers<span className="brand-dot">.</span>
          </span>
          <button
            className="icon-button panel-toggle"
            aria-label={expanded ? "Close notes panel" : "Open notes panel"}
            aria-expanded={expanded}
            onClick={panel}
          >
            {expanded ? (
              <PanelLeftClose size={18} />
            ) : (
              <PanelLeftOpen size={18} />
            )}
          </button>
          {desktop && (
            <button
              className="icon-button main-close"
              aria-label="Close main window"
              onClick={() => void call("hide_main")}
            >
              <X size={15} />
            </button>
          )}
        </div>
        <button
          className="primary sidebar-new-note"
          disabled={!main}
          onClick={newNote}
        >
          <Plus size={18} />
          New note
        </button>
        <label className="search sidebar-search">
          <Search size={15} />
          <input
            aria-label="Search notes"
            placeholder="Search notes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="sidebar-sort">
          Sort by…
          <select
            aria-label="Sort notes"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="date">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="name">Name</option>
            <option value="size">Size</option>
            <option value="type">Type</option>
          </select>
        </label>
        <div className="vault-tree">
          <VaultList
            vault={{ id: "*", name: "Pinned notes", path: "", github: null }}
            pinned
            config={config}
            open={open.has("*")}
            sort={sort}
            query={query}
            selected={selected}
            toggle={() => toggle("*")}
            onSelect={select}
            onOpen={openNote}
            onDrag={drag}
            onDrop={drop}
            onMain={() => {}}
          />
          {config.vaults.map((v) => (
            <VaultList
              key={v.id}
              vault={v}
              config={config}
              open={open.has(v.id)}
              sort={sort}
              query={query}
              selected={selected}
              toggle={() => toggle(v.id)}
              onSelect={select}
              onOpen={openNote}
              onDrag={drag}
              onDrop={drop}
              onMain={() =>
                void run(() => call("set_main_vault", { vaultId: v.id }))
              }
            />
          ))}
        </div>
        {error && (
          <div role="alert" className="error-banner">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={14} />
            </button>
          </div>
        )}
        <div className="sidebar-bottom">
          <div className="add-vault-control">
            <button
              className="nav-item"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <Plus size={17} />
              Add vault
            </button>
            {menu && (
              <>
                <button
                  className="vault-menu-dismiss"
                  aria-label="Close vault menu"
                  onClick={() => setMenu(false)}
                />
                <div className="vault-menu">
                  <button
                    onClick={() => {
                      setMenu(false);
                      void run(registerFolder);
                    }}
                  >
                    <FolderOpen size={15} />
                    Open a vault…
                  </button>
                  <button
                    disabled={!main}
                    onClick={() => {
                      setMenu(false);
                      void run(() =>
                        call("import_note", { vaultId: main?.id }),
                      );
                    }}
                  >
                    <Upload size={15} />
                    Import note(s)
                  </button>
                  <button
                    onClick={() => {
                      setMenu(false);
                      showSettings("vaults");
                    }}
                  >
                    <Github size={15} />
                    Create GitHub synced vault
                  </button>
                </div>
              </>
            )}
          </div>
          {main?.github && (
            <button
              className="nav-item"
              onClick={() =>
                void run(() => call("sync_vault", { vaultId: main.id }))
              }
            >
              <RefreshCw size={16} />
              Sync main vault
            </button>
          )}
          <button className="nav-item" onClick={() => showSettings("general")}>
            <Settings size={17} />
            Settings
          </button>
        </div>
      </aside>
      {expanded && (
        <main className="collection-main">
          <div className="collection-tools">
            <div
              className="tabs"
              role="tablist"
              aria-label="Library tabs"
              data-tauri-drag-region
            >
              {[
                ["all", "All notes"],
                ["pinned", "Pinned notes"],
                ...config.vaults.map((v) => [`vault:${v.id}`, v.name]),
                ["settings", "Settings"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={filter === id}
                  aria-controls="collection-pane"
                  className={filter === id ? "active" : ""}
                  onClick={() =>
                    id === "settings" ? showSettings("general") : setFilter(id)
                  }
                >
                  {id === "pinned" && <Pin size={14} />}
                  {id === "settings" && <Settings size={14} />}
                  {id.startsWith("vault:") && (
                    <VaultIcon
                      vault={config.vaults.find((v) => `vault:${v.id}` === id)!}
                      size={14}
                    />
                  )}
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div
            id="collection-pane"
            role="tabpanel"
            aria-label={filter === "settings" ? "Settings" : "Notes"}
          >
            {filter === "settings" ? (
              settingsContent
            ) : (
              <>
                {!config.vaults.length && (
                  <p className="no-results">
                    Open a folder or create a vault to begin.
                  </p>
                )}
                {grid.error && (
                  <div role="alert" className="error-banner">
                    {grid.error}
                  </div>
                )}
                <div className="notes-grid">
                  {grid.notes.map((n) => (
                    <PreviewCard
                      key={noteKey(n)}
                      note={n}
                      config={previewConfig}
                      dark={dark}
                      onOpen={() => openNote(n)}
                    />
                  ))}
                </div>
                <div ref={sentinel} className="load-sentinel">
                  {grid.busy && <span role="status">Loading notes…</span>}
                  {grid.notes.length < grid.total && (
                    <button
                      className="load-more"
                      disabled={grid.busy}
                      onClick={grid.more}
                    >
                      Load more notes
                    </button>
                  )}
                </div>
                {!!config.vaults.length && !grid.busy && !grid.total && (
                  <p className="no-results">
                    {query
                      ? `No notes match “${query}”.`
                      : "No notes in this tab."}
                  </p>
                )}
              </>
            )}
          </div>
        </main>
      )}
    </div>
  );
}
