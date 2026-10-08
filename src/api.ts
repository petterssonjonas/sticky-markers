import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  defaults,
  defaultStyle,
  type Config,
  type Document,
  type Note,
  type NoteStyle,
  type Settings,
  type Vault,
  type LibraryEntry,
} from "./types";

export const desktop = isTauri();
const key = "sticky-markers-browser-demo-v1";
const samples: Record<string, string> = {
  "A little room for ideas.md":
    "# A little room for ideas\n\nSome thoughts need a little space of their own.\n\n- [x] Find a quiet corner\n- [ ] Make something worth keeping\n- [ ] Leave room for the unexpected\n\n**One little note at a time.**",
  "Weekend things.md":
    "# Weekend things\n\nFresh bread. A long walk. Absolutely no alarms.\n\n- Visit the flower market\n- Start that book\n- Call someone you miss\n\n> A small plan for a slow day.",
  "Garden notes.md":
    "# Garden notes\n\nThe rosemary is doing well. The basil needs more sun.\n\n| Plant | Next step |\n| --- | --- |\n| Basil | Move to the window |\n| Rosemary | Water on Friday |\n\nRemember: growth takes its own time.",
  "Something to make.md":
    "# Something to make\n\nA place for fleeting ideas to become real things.\n\n```mermaid\nflowchart LR\n  Idea --> Sketch --> Make\n  Make --> Learn --> Idea\n```\n\nStart small. Keep going.",
  "A good reminder.md":
    "# A good reminder\n\nYou don’t have to hold everything in your head.\n\nWrite it down. Close the note. Come back when you need it.\n\nSee [[Weekend things]].",
};
interface Demo {
  config: Config;
  files: Record<string, string>;
  vaultFiles?: Record<string, Record<string, string>>;
}
function load(): Demo {
  const saved = localStorage.getItem(key);
  if (saved) {
    const d = JSON.parse(saved) as Demo;
    d.config.settings = { ...defaults, ...d.config.settings };
    if (!d.config.fontDefaultsMigrated) {
      if (d.config.settings.font === "libron")
        d.config.settings.font = "barlow";
      d.config.fontDefaultsMigrated = true;
    }
    return d;
  }
  const config: Config = {
    fontDefaultsMigrated: true,
    vaults: [
      {
        id: "demo",
        name: "Everyday notes",
        path: "Browser demo · not a disk vault",
        github: null,
      },
    ],
    activeVault: "demo",
    settings: defaults,
    styles: {},
    recent: [],
  };
  Object.keys(samples).forEach((p, i) => {
    config.styles[`demo/${p}`] = {
      ...defaults,
      color: [0, 3, 5, 1, 8][i],
      mode: "view",
      open: false,
      pinned: false,
      pinnedAt: 0,
      x: null,
      y: null,
    };
  });
  return { config, files: { ...samples } };
}
function persist(d: Demo) {
  localStorage.setItem(key, JSON.stringify(d));
}
async function hash(s: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function navigate(vaultId?: string, path?: string) {
  const q = path
    ? `?vault=${encodeURIComponent(vaultId!)}&note=${encodeURIComponent(path)}`
    : "";
  history.pushState(null, "", `/${q}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
const drafts = new Map<string, { path?: string; style?: NoteStyle }>();
function autoName(content: string, files: Record<string, string>) {
  const stem =
    (content.split("\n").find((line) => line.trim()) ?? "Note")
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .join("_")
      .slice(0, 20)
      .replace(/_+$/, "") || "Note";
  let path = `${stem}.md`,
    i = 2;
  while (path in files) {
    const suffix = `_${i++}`;
    path = `${stem.slice(0, 20 - suffix.length)}${suffix}.md`;
  }
  return path;
}
async function demoCall<T>(
  operation: string,
  args: Record<string, unknown>,
): Promise<T> {
  const d = load();
  const id = String(
    args.vaultId ?? d.config.mainVault ?? d.config.activeVault ?? "demo",
  );
  const files = id === "demo" ? d.files : ((d.vaultFiles ??= {})[id] ??= {});
  let path = String(args.path ?? "");
  const draft = drafts.get(path);
  if (draft?.path) path = draft.path;
  let out: unknown = null;
  const doc = async (p: string): Promise<Document> => {
    if (!(p in files)) {
      if (drafts.has(p))
        return { vaultId: id, path: p, content: "", revision: await hash("") };
      throw new Error("Note no longer exists");
    }
    return {
      vaultId: id,
      path: p,
      content: files[p],
      revision: await hash(files[p]),
    };
  };
  switch (operation) {
    case "bootstrap":
      out = d.config;
      break;
    case "library_page": {
      const q = String(args.query ?? "").toLowerCase();
      const vaults =
        id === "*"
          ? d.config.vaults
          : d.config.vaults.filter((v) => v.id === id);
      const entries = vaults.flatMap((v) => {
        const source = v.id === "demo" ? d.files : (d.vaultFiles?.[v.id] ?? {});
        return Object.entries(source)
          .map(
            ([path, content], i): LibraryEntry => ({
              vaultId: v.id,
              path,
              title: path.split("/").pop()!,
              modified: 1700000000 - i * 3600,
              size: new TextEncoder().encode(content).length,
              kind: path.split(".").pop()?.toLowerCase() ?? "",
            }),
          )
          .filter(
            (n) =>
              (n.path.toLowerCase().includes(q) ||
                source[n.path].toLowerCase().includes(q)) &&
              (!args.pinned || d.config.styles[`${v.id}/${n.path}`]?.pinned),
          );
      });
      entries.sort((a, b) =>
        args.sort === "name"
          ? a.title.localeCompare(b.title)
          : args.sort === "size"
            ? b.size - a.size
            : args.sort === "type"
              ? a.kind.localeCompare(b.kind)
              : args.sort === "oldest"
                ? a.modified - b.modified
                : b.modified - a.modified,
      );
      const offset = Number(args.offset ?? 0),
        limit = Number(args.limit ?? 24);
      out = {
        total: entries.length,
        notes: entries.slice(offset, offset + limit),
      };
      break;
    }
    case "main_panel":
      break;
    case "set_vault_defaults":
      d.config.vaults.find((v) => v.id === id)!.defaultColor =
        args.color == null ? null : Number(args.color);
      break;
    case "set_main_vault":
      d.config.mainVault = id;
      break;
    case "editor_preferences":
      if (args.mode) d.config.settings.mode = args.mode as Settings["mode"];
      if (args.toolbarPins)
        d.config.settings.toolbarPins = args.toolbarPins as string[];
      break;
    case "move_notes": {
      const destination = String(args.destination),
        refs = args.notes as { vaultId: string; path: string }[];
      const target =
        destination === "demo"
          ? d.files
          : ((d.vaultFiles ??= {})[destination] ??= {});
      const names = new Set<string>();
      for (const n of refs) {
        if (n.vaultId === destination) continue;
        if (n.path in target || names.has(n.path))
          throw new Error("A note already exists at the target path");
        names.add(n.path);
      }
      for (const n of refs) {
        if (n.vaultId === destination) continue;
        const source =
          n.vaultId === "demo" ? d.files : d.vaultFiles![n.vaultId];
        target[n.path] = source[n.path];
        delete source[n.path];
        const old = `${n.vaultId}/${n.path}`,
          next = `${destination}/${n.path}`;
        if (d.config.styles[old]) {
          d.config.styles[next] = d.config.styles[old];
          delete d.config.styles[old];
        }
      }
      break;
    }
    case "list_notes":
      out = Object.entries(files).map(
        ([p, s], i): Note => ({
          vaultId: id,
          path: p,
          title:
            s
              .split("\n")
              .find((l) => l.trim())
              ?.replace(/^#+\s*/, "") ?? p,
          preview: s.slice(0, 4096),
          modified: Date.now() / 1000 - i * 3600,
        }),
      );
      break;
    case "search_notes":
      out = Object.entries(files)
        .filter(([p, s]) =>
          (p + s).toLowerCase().includes(String(args.query).toLowerCase()),
        )
        .map(
          ([p, s], i): Note => ({
            vaultId: id,
            path: p,
            title:
              s
                .split("\n")
                .find((l) => l.trim())
                ?.replace(/^#+\s*/, "") ?? p,
            preview: s.slice(0, 4096),
            modified: Date.now() / 1000 - i * 3600,
          }),
        );
      break;
    case "read_note":
      out = await doc(path);
      break;
    case "save_note": {
      if (new TextEncoder().encode(String(args.content)).length > 100 * 1024)
        throw new Error("Note exceeds the 100 KiB editing limit");
      const n = await doc(path);
      if (n.revision !== args.expected)
        throw new Error(
          "Conflict: note changed. Your unsaved text is still in this window.",
        );
      files[path] = String(args.content);
      const style = d.config.styles[`${id}/${path}`];
      if (style?.provisional && files[path].trim()) {
        const target = autoName(
          files[path],
          Object.fromEntries(Object.entries(files).filter(([p]) => p !== path)),
        );
        if (target !== path) {
          files[target] = files[path];
          delete files[path];
          d.config.styles[`${id}/${target}`] = style;
          delete d.config.styles[`${id}/${path}`];
          for (const alias of drafts.values())
            if (alias.path === path) alias.path = target;
          path = target;
        }
        style.provisional = false;
      }
      out = await doc(path);
      break;
    }
    case "new_note": {
      const p = `draft-${crypto.randomUUID()}`;
      const target = autoName("", files);
      files[target] = "";
      d.config.styles[`${id}/${target}`] = {
        ...defaultStyle(
          d.config.settings,
          d.config.vaults.find((v) => v.id === id),
        ),
        provisional: true,
        open: true,
      };
      drafts.set(p, { path: target });
      out = await doc(target);
      persist(d);
      window.dispatchEvent(new Event("demo-notes-changed"));
      navigate(id, p);
      return out as T;
    }
    case "open_note":
      d.config.styles[`${id}/${path}`] ??= defaultStyle(
        d.config.settings,
        d.config.vaults.find((v) => v.id === id),
      );
      persist(d);
      window.dispatchEvent(new Event("demo-notes-changed"));
      navigate(id, path);
      if (args.heading) {
        const q = new URL(location.href);
        q.searchParams.set("heading", String(args.heading));
        history.replaceState(null, "", q);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
      return null as T;
    case "show_main":
      navigate();
      return null as T;
    case "tuck_note":
      if (
        d.config.styles[`${id}/${path}`]?.provisional &&
        !files[path]?.trim()
      ) {
        delete files[path];
        delete d.config.styles[`${id}/${path}`];
      } else
        d.config.styles[`${id}/${path}`] = {
          ...d.config.styles[`${id}/${path}`],
          open: false,
        };
      persist(d);
      window.dispatchEvent(new Event("demo-notes-changed"));
      navigate();
      return null as T;
    case "delete_note":
      delete files[path];
      persist(d);
      window.dispatchEvent(new Event("demo-notes-changed"));
      navigate();
      return null as T;
    case "rename_note": {
      const target = String(args.newPath);
      if (target in files)
        throw new Error("A note already exists at that path");
      files[target] = files[path];
      delete files[path];
      d.config.styles[`${id}/${target}`] = d.config.styles[`${id}/${path}`];
      delete d.config.styles[`${id}/${path}`];
      persist(d);
      window.dispatchEvent(new Event("demo-notes-changed"));
      navigate(id, target);
      return (await doc(target)) as T;
    }
    case "set_style":
      if (draft && !draft.path) draft.style = args.style as NoteStyle;
      else
        d.config.styles[`${id}/${path}`] = {
          ...(args.style as NoteStyle),
          provisional: d.config.styles[`${id}/${path}`]?.provisional,
        };
      break;
    case "set_appearance":
      d.config.settings.appearance = args.appearance as Settings["appearance"];
      break;
    case "save_to_vault": {
      if ((await doc(path)).revision !== args.expected)
        throw new Error("Conflict: note changed.");
      const destination = String(args.destination);
      const target =
        destination === "demo"
          ? d.files
          : ((d.vaultFiles ??= {})[destination] ??= {});
      if (path in target)
        throw new Error("A note already exists at the target path");
      target[path] = files[path];
      delete files[path];
      d.config.styles[`${destination}/${path}`] = {
        ...d.config.styles[`${id}/${path}`],
        provisional: false,
        open: true,
      };
      delete d.config.styles[`${id}/${path}`];
      persist(d);
      window.dispatchEvent(new Event("demo-notes-changed"));
      navigate(destination, path);
      return null as T;
    }
    case "set_settings":
      d.config.settings = args.settings as Settings;
      break;
    case "select_vault":
      d.config.activeVault = id;
      break;
    case "system_fonts":
      out = ["Arial", "DejaVu Sans", "Liberation Serif"];
      break;
    case "journal":
      break;
    case "recovery_path":
      out = "Desktop recovery is available in the installed app.";
      break;
    default:
      throw new Error(
        "This feature needs the installed desktop app. The browser is a UI demo.",
      );
  }
  if (
    ![
      "bootstrap",
      "library_page",
      "list_notes",
      "search_notes",
      "read_note",
      "system_fonts",
      "recovery_path",
      "main_panel",
    ].includes(operation)
  ) {
    persist(d);
    window.dispatchEvent(new Event("demo-notes-changed"));
  }
  return out as T;
}
export function call<T>(
  operation: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return desktop
    ? invoke<T>("dispatch", { operation, args })
    : demoCall<T>(operation, args);
}
export async function pickFolder(
  title = "Choose a vault folder",
): Promise<string | null> {
  if (!desktop)
    throw new Error("Open the installed desktop app to choose a real folder.");
  const p = await open({
    directory: true,
    multiple: false,
    title,
  });
  return typeof p === "string" ? p : null;
}
export async function external(url: string) {
  if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) return;
  if (desktop) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
export async function registerFolder() {
  const path = await pickFolder();
  return path ? call<Vault>("register_vault", { path }) : null;
}
