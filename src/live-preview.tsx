import { createRoot, type Root } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import {
  StateField,
  StateEffect,
  EditorSelection,
  Prec,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  type DecorationSet,
} from "@codemirror/view";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";
import { Markdown } from "./markdown";
import { external } from "./api";
import { decodeLink } from "./attachment-loader";
const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkFrontmatter);
type Node = ReturnType<typeof parser.parse>["children"][number] & {
  children?: Node[];
  depth?: number;
  lang?: string;
  url?: string;
  value?: string;
  identifier?: string;
  label?: string;
};
export interface PreviewOptions {
  dark: boolean;
  vaultId: string;
  path: string;
  onWiki: (target: string) => void;
}
const focusEffect = StateEffect.define<boolean>();
const bounds = (n: Node) => ({
  from: n.position!.start.offset!,
  to: n.position!.end.offset!,
});

class Marker extends WidgetType {
  constructor(
    readonly text: string,
    readonly className = "lp-marker",
    readonly checkPosition?: number,
    readonly checked = false,
  ) {
    super();
  }
  eq(other: Marker) {
    return (
      this.text === other.text &&
      this.className === other.className &&
      this.checked === other.checked &&
      this.checkPosition === other.checkPosition
    );
  }
  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = this.className;
    span.textContent = this.text;
    if (this.checkPosition !== undefined) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = this.checked;
      input.tabIndex = -1;
      input.setAttribute("aria-label", "Toggle task");
      input.addEventListener("mousedown", (e) => e.preventDefault());
      input.addEventListener("change", () => {
        if (view.state.readOnly) return;
        view.dispatch({
          changes: {
            from: this.checkPosition!,
            to: this.checkPosition! + 1,
            insert: this.checked ? " " : "x",
          },
        });
      });
      span.replaceChildren(input);
    }
    return span;
  }
  ignoreEvent() {
    return this.checkPosition !== undefined;
  }
}
class Render extends WidgetType {
  private root?: Root;
  constructor(
    readonly source: string,
    readonly options: PreviewOptions,
    readonly className = "lp-inline-render",
  ) {
    super();
  }
  eq(other: Render) {
    return (
      this.source === other.source &&
      this.options.dark === other.options.dark &&
      this.options.path === other.options.path &&
      this.options.vaultId === other.options.vaultId
    );
  }
  toDOM() {
    const host = document.createElement("span");
    host.className = this.className;
    this.root = createRoot(host);
    this.root.render(<Markdown content={this.source} {...this.options} />);
    return host;
  }
  destroy() {
    const root = this.root;
    queueMicrotask(() => root?.unmount());
  }
  ignoreEvent() {
    return true;
  }
}

interface TableModel {
  root: Root;
  node: Node;
  view: EditorView;
  options: PreviewOptions;
}
const tableModels = new WeakMap<HTMLElement, TableModel>();
const cellInputs = new WeakMap<EditorView, Map<HTMLInputElement, () => void>>();

/** Flush the current native input value before Save, Rename, Close or Quit. */
export function commitPendingEditorBuffers(view: EditorView) {
  for (const commit of cellInputs.get(view)?.values() ?? []) commit();
}

function cellRange(model: TableModel, row: number, column: number) {
  const cells = model.node.children?.[row]?.children,
    cell = cells?.[column];
  if (!cell) return null;
  let { from, to } = bounds(cell);
  const all = model.view.state.doc;
  if (all.sliceString(from, from + 1) === "|") from++;
  if (
    column === cells.length - 1 &&
    all.sliceString(to - 1, to) === "|" &&
    all.sliceString(to - 2, to - 1) !== "\\"
  )
    to--;
  return { from, to, source: all.sliceString(from, to) };
}

function cellPadding(source: string) {
  if (!source.trim()) {
    const middle = Math.ceil(source.length / 2);
    return { left: source.slice(0, middle), right: source.slice(middle) };
  }
  return {
    left: source.match(/^\s*/)?.[0] ?? "",
    right: source.match(/\s*$/)?.[0] ?? "",
  };
}

function TableCell({
  model,
  row,
  column,
}: {
  model: TableModel;
  row: number;
  column: number;
}) {
  const { view, options } = model,
    source = cellRange(model, row, column)?.source ?? "";
  const [editing, setEditing] = useState(false),
    [value, setValue] = useState(source.trim());
  const input = useRef<HTMLInputElement>(null);
  const padding = useRef(cellPadding(source));
  const commitValue = (value: string) => {
    if (view.state.readOnly) return;
    // The model is updated synchronously when CodeMirror changes. Resolve the
    // current offsets here, rather than retaining positions from a React render.
    const cell = cellRange(model, row, column);
    if (!cell) return;
    if (value === cell.source.trim()) return;
    // Keep the pipe syntax and spacing around the cell; edit only its value.
    const { left, right } = padding.current;
    const insert =
      left + value.replace(/(?<!\\)\|/g, "\\|").replace(/[\r\n]/g, " ") + right;
    if (insert !== cell.source)
      view.dispatch({ changes: { from: cell.from, to: cell.to, insert } });
  };
  const commitRef = useRef(commitValue);
  commitRef.current = commitValue;
  useEffect(() => {
    if (!editing || !input.current) return;
    const element = input.current;
    let inputs = cellInputs.get(view);
    if (!inputs) cellInputs.set(view, (inputs = new Map()));
    inputs.set(element, () => commitRef.current(element.value));
    element.readOnly = view.state.readOnly;
    return () => {
      inputs.delete(element);
      if (!inputs.size) cellInputs.delete(view);
    };
  }, [editing, view]);
  const finish = () => {
    commitValue(input.current?.value ?? value);
    setEditing(false);
  };
  return editing ? (
    <input
      ref={input}
      aria-label="Edit table cell"
      autoFocus
      value={value}
      readOnly={view.state.readOnly}
      onChange={(e) => {
        setValue(e.target.value);
        // A table input is part of the document immediately. Autosave and the
        // recovery journal therefore include it even while it still has focus.
        commitValue(e.target.value);
      }}
      onBlur={finish}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" || e.key === "Escape") finish();
      }}
    />
  ) : (
    <div
      tabIndex={0}
      className="lp-table-cell"
      onClick={() => {
        if (!view.state.readOnly) {
          padding.current = cellPadding(source);
          setValue(source.trim());
          setEditing(true);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !view.state.readOnly) {
          padding.current = cellPadding(source);
          setValue(source.trim());
          setEditing(true);
        }
      }}
    >
      <Markdown content={source.trim()} {...options} />
    </div>
  );
}
class Table extends WidgetType {
  constructor(
    readonly source: string,
    readonly node: Node,
    readonly options: PreviewOptions,
  ) {
    super();
  }
  eq(other: Table) {
    return (
      this.source === other.source &&
      bounds(this.node).from === bounds(other.node).from &&
      this.options.dark === other.options.dark &&
      this.options.path === other.options.path &&
      this.options.vaultId === other.options.vaultId
    );
  }
  toDOM(view: EditorView) {
    const host = document.createElement("div");
    host.className = "live-preview-block lp-table";
    const model = {
      root: createRoot(host),
      node: this.node,
      view,
      options: this.options,
    };
    tableModels.set(host, model);
    this.render(model);
    return host;
  }
  updateDOM(host: HTMLElement, view: EditorView) {
    const model = tableModels.get(host);
    if (!model) return false;
    model.node = this.node;
    model.view = view;
    model.options = this.options;
    this.render(model);
    return true;
  }
  private render(model: TableModel) {
    model.root.render(
      <div className="markdown-body">
        <table>
          <tbody>
            {model.node.children?.map((row, i) => (
              <tr key={i}>
                {row.children?.map((_cell, j) => {
                  const props = { model, row: i, column: j };
                  return i === 0 ? (
                    <th key={j}>
                      <TableCell {...props} />
                    </th>
                  ) : (
                    <td key={j}>
                      <TableCell {...props} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
  }
  destroy(host: HTMLElement) {
    const model = tableModels.get(host);
    tableModels.delete(host);
    queueMicrotask(() => model?.root.unmount());
  }
  ignoreEvent() {
    return true;
  }
}

/** Rows, rather than AST sections, reveal their source when selected. */
export function activeLines(
  source: string,
  selection: { from: number; to: number },
  focused: boolean,
) {
  if (!focused) return [];
  const lines = source.split("\n");
  let offset = 0;
  const active: number[] = [];
  lines.forEach((line, i) => {
    const end = offset + line.length;
    if (
      (selection.from === selection.to
        ? selection.to >= offset
        : selection.to > offset) &&
      selection.from <= end
    )
      active.push(i + 1);
    offset = end + 1;
  });
  return active;
}
/** Triple-click selects source text on this logical row, excluding its newline. */
export const rowMouseSelection: Extension = Prec.highest(
  EditorView.mouseSelectionStyle.of((view, event) => {
    if (
      event.detail !== 3 ||
      (event.target as HTMLElement).closest(".lp-table")
    )
      return null;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return null;
    const line = view.state.doc.lineAt(pos);
    let start = line.from,
      end = line.to;
    const original = view.state.selection;
    return {
      get(current, extend, multiple) {
        const pos =
          current === event
            ? start
            : view.posAtCoords({ x: current.clientX, y: current.clientY });
        const target = view.state.doc.lineAt(pos ?? start);
        const range =
          target.from < start
            ? EditorSelection.range(end, target.from)
            : EditorSelection.range(start, target.to);
        if (extend)
          return EditorSelection.single(original.main.anchor, range.head);
        return multiple
          ? EditorSelection.create(
              [...original.ranges, range],
              original.ranges.length,
            )
          : EditorSelection.create([range]);
      },
      update(update) {
        if (update.docChanged) {
          start = update.changes.mapPos(start);
          end = update.changes.mapPos(end);
        }
      },
    };
  }),
);

interface HiddenRange {
  from: number;
  to: number;
  height: number;
  left?: HiddenRange;
  right?: HiddenRange;
}
/** Non-overlapping intervals in an AVL tree: insertion stays O(log n), even
 * when nested syntax or the HTML/wiki pass visits offsets out of order. */
class HiddenRanges {
  private root?: HiddenRange;
  add(from: number, to: number) {
    let current = this.root;
    while (current) {
      if (to <= current.from) current = current.left;
      else if (from >= current.to) current = current.right;
      else return false;
    }
    const height = (node?: HiddenRange) => node?.height ?? 0;
    const refresh = (node: HiddenRange) => {
      node.height = 1 + Math.max(height(node.left), height(node.right));
      return node;
    };
    const left = (node: HiddenRange) => {
      const next = node.right!;
      node.right = next.left;
      next.left = refresh(node);
      return refresh(next);
    };
    const right = (node: HiddenRange) => {
      const next = node.left!;
      node.left = next.right;
      next.right = refresh(node);
      return refresh(next);
    };
    const insert = (node?: HiddenRange): HiddenRange => {
      if (!node) return { from, to, height: 1 };
      if (from < node.from) node.left = insert(node.left);
      else node.right = insert(node.right);
      refresh(node);
      const balance = height(node.left) - height(node.right);
      if (balance > 1) {
        if (from > node.left!.from) node.left = left(node.left!);
        return right(node);
      }
      if (balance < -1) {
        if (from < node.right!.from) node.right = right(node.right!);
        return left(node);
      }
      return node;
    };
    this.root = insert(this.root);
    return true;
  }
}

function selectedLines(state: EditorState, focused: boolean) {
  const lines = new Set<number>();
  if (!focused) return lines;
  const selection = state.selection.main;
  const first = state.doc.lineAt(selection.from).number,
    last = state.doc.lineAt(
      selection.empty
        ? selection.to
        : Math.max(selection.from, selection.to - 1),
    ).number;
  for (let line = first; line <= last; line++) lines.add(line);
  return lines;
}

/** Restore/reveal only rows whose active state changed. The parsed Markdown,
 * static marks, tables and untouched decorations are reused on cursor moves. */
function revealSelectedLines(
  state: EditorState,
  base: DecorationSet,
  current: DecorationSet,
  previous: Set<number>,
  active: Set<number>,
) {
  const changed = [...new Set([...previous, ...active])]
    .filter((number) => previous.has(number) !== active.has(number))
    .sort((a, b) => a - b);
  for (let index = 0; index < changed.length;) {
    const first = changed[index++];
    let last = first;
    while (changed[index] === last + 1) last = changed[index++];
    const from = state.doc.line(first).from,
      to = Math.min(state.doc.length + 1, state.doc.line(last).to + 1);
    const add: Range<Decoration>[] = [];
    base.between(from, Math.min(to, state.doc.length), (start, end, value) => {
      if (
        start >= from &&
        start < to &&
        value.spec.lpSyntax &&
        !active.has(state.doc.lineAt(start).number)
      )
        add.push(value.range(start, end));
    });
    for (let number = first; number <= last; number++)
      if (active.has(number))
        add.push(
          Decoration.line({ class: "lp-source-line", lpActive: true }).range(
            state.doc.line(number).from,
          ),
        );
    current = current.update({
      filterFrom: from,
      filterTo: Math.min(to, state.doc.length),
      filter: (start, _end, value) =>
        start < from ||
        start >= to ||
        !(value.spec.lpSyntax || value.spec.lpActive),
      add,
      sort: true,
    });
  }
  return current;
}

export function livePreview(options: PreviewOptions): Extension {
  const decorate = (
    state: EditorState,
    tree: ReturnType<typeof parser.parse>,
  ) => {
    const decorations: Range<Decoration>[] = [];
    const atomics: Range<Decoration>[] = [];
    const source = state.doc.toString();
    const definitionNodes = tree.children.filter(
      (n) => n.type === "definition",
    ) as Node[];
    const definitionSource = definitionNodes
      .map((n) => source.slice(bounds(n).from, bounds(n).to))
      .join("\n\n");
    const definitions = new Map(
      definitionNodes.map((n) => [
        (n.identifier ?? n.label ?? "").toLowerCase(),
        n.url ?? "",
      ]),
    );
    const lineClasses = new Map<number, Set<string>>();
    const hidden = new HiddenRanges();
    const styleLine = (number: number, className: string) => {
      const classes = lineClasses.get(number) ?? new Set();
      classes.add(className);
      lineClasses.set(number, classes);
    };
    const replace = (from: number, to: number, widget?: WidgetType) => {
      if (to <= from || from < 0 || to > state.doc.length) return;
      const first = state.doc.lineAt(from),
        last = state.doc.lineAt(Math.max(from, to - 1));
      // Split syntax spanning rows so selecting one row never reveals its siblings.
      for (let n = first.number; n <= last.number; n++) {
        const line = state.doc.line(n),
          a = Math.max(from, line.from),
          b = Math.min(to, line.to);
        if (b > a && hidden.add(a, b)) {
          decorations.push(
            Decoration.replace({ widget, lpSyntax: true }).range(a, b),
          );
        }
      }
    };
    const mark = (
      from: number,
      to: number,
      className: string,
      attributes?: Record<string, string>,
    ) => {
      if (to > from)
        decorations.push(
          Decoration.mark({ class: className, attributes }).range(from, to),
        );
    };
    const visit = (node: Node, inCode = false) => {
      if (!node.position) return;
      const { from, to } = bounds(node);
      const first = state.doc.lineAt(from),
        last = state.doc.lineAt(Math.max(from, to - 1));
      if (node.type === "table") {
        const d = Decoration.replace({
          block: true,
          widget: new Table(source.slice(from, to), node, options),
        }).range(from, to);
        decorations.push(d);
        atomics.push(d);
        return;
      }
      if (node.type === "code") {
        for (let n = first.number; n <= last.number; n++)
          styleLine(n, "lp-code-line");
        const fenced = /^\s*(`{3,}|~{3,})/.test(first.text);
        if (fenced) {
          replace(first.from, first.to);
          if (/^\s*(`{3,}|~{3,})\s*$/.test(last.text))
            replace(last.from, last.to);
        }
        if (node.lang === "mermaid")
          decorations.push(
            Decoration.widget({
              block: true,
              side: 1,
              widget: new Render(
                source.slice(from, to),
                options,
                "live-preview-block lp-diagram",
              ),
            }).range(last.to),
          );
        return;
      }
      if (node.type === "heading") {
        styleLine(first.number, `lp-heading lp-h${node.depth}`);
        const prefix = first.text.match(/^\s{0,3}#{1,6}\s+/);
        if (prefix) replace(first.from, first.from + prefix[0].length);
        if (last.number > first.number && /^\s*(=+|-+)\s*$/.test(last.text))
          replace(last.from, last.to);
      }
      if (node.type === "listItem") {
        for (let n = first.number; n <= last.number; n++)
          styleLine(n, "lp-list-line");
        const prefix = first.text.match(/^(\s*)([-+*]|\d+[.)])\s+/);
        if (prefix) {
          const at = first.from + prefix[1].length;
          if (/^[-+*]$/.test(prefix[2]))
            replace(at, at + 1, new Marker("•", "lp-bullet"));
          const task = first.text.slice(prefix[0].length).match(/^\[([ xX])\]/);
          if (task) {
            const at = first.from + prefix[0].length;
            replace(
              at,
              at + 3,
              new Marker("", "lp-task", at + 1, task[1].toLowerCase() === "x"),
            );
          }
        }
      }
      if (node.type === "blockquote")
        for (let n = first.number; n <= last.number; n++) {
          const line = state.doc.line(n),
            m = line.text.match(/^\s*>/);
          if (m)
            replace(
              line.from + m[0].length - 1,
              line.from + m[0].length,
              new Marker("│", "lp-quote"),
            );
        }
      if (["strong", "emphasis", "delete"].includes(node.type)) {
        const children = node.children ?? [];
        if (children.length) {
          const a = bounds(children[0]).from,
            b = bounds(children[children.length - 1]).to;
          replace(from, a);
          replace(b, to);
          mark(
            a,
            b,
            (
              {
                strong: "lp-strong",
                emphasis: "lp-emphasis",
                delete: "lp-strike",
              } as Record<string, string>
            )[node.type],
          );
        }
      }
      if (node.type === "inlineCode") {
        const raw = source.slice(from, to),
          prefix = raw.match(/^`+/)?.[0].length ?? 1;
        replace(from, from + prefix);
        replace(to - prefix, to);
        mark(from + prefix, to - prefix, "lp-code");
      }
      if (node.type === "link" || node.type === "linkReference") {
        const children = node.children ?? [];
        if (children.length) {
          const a = bounds(children[0]).from,
            b = bounds(children[children.length - 1]).to;
          replace(from, a);
          replace(b, to);
          mark(a, b, "lp-link", {
            "data-href":
              node.url ??
              definitions.get(
                (node.identifier ?? node.label ?? "").toLowerCase(),
              ) ??
              "",
          });
        }
      }
      if (node.type === "image" || node.type === "imageReference") {
        // Keep the image in place while its one source row is being edited.
        replace(from, to);
        decorations.push(
          Decoration.widget({
            side: 1,
            widget: new Render(
              source.slice(from, to) +
                (definitionSource ? `\n\n${definitionSource}` : ""),
              options,
              "lp-image",
            ),
          }).range(last.to),
        );
        return;
      }
      if (node.type === "footnoteReference")
        replace(
          from,
          to,
          new Marker(node.label ?? node.identifier ?? "*", "lp-footnote"),
        );
      if (
        node.type === "html" &&
        /^<(script|style|iframe)\b/i.test(source.slice(from, to))
      )
        replace(from, to);
      if (node.type === "inlineMath")
        replace(from, to, new Render(source.slice(from, to), options));
      if (node.type === "math") {
        decorations.push(
          Decoration.widget({
            block: true,
            side: 1,
            widget: new Render(
              source.slice(from, to),
              options,
              "live-preview-block",
            ),
          }).range(last.to),
        );
        replace(from, to);
        return;
      }
      if (node.type === "thematicBreak")
        replace(from, to, new Marker("", "lp-rule"));
      if (
        node.type === "yaml" ||
        String(node.type) === "toml" ||
        node.type === "definition"
      )
        replace(from, to);
      if (node.type === "footnoteDefinition") {
        const prefix = first.text.match(/^\s{0,3}\[\^[^\]]+\]:\s*/);
        if (prefix)
          replace(
            first.from,
            first.from + prefix[0].length,
            new Marker(
              `${node.label ?? node.identifier}: `,
              "lp-footnote-label",
            ),
          );
      }
      node.children?.forEach((child) => visit(child, inCode));
    };
    tree.children.forEach((n) => visit(n as Node));
    // Obsidian links and safe underline tags are inline syntax too.
    for (let number = 1; number <= state.doc.lines; number++) {
      const line = state.doc.line(number);
      if (
        lineClasses.get(number)?.has("lp-code-line") ||
        atomics.some((r) => line.from >= r.from && line.from < r.to)
      )
        continue;
      for (const m of line.text.matchAll(
        /<(u|b|strong|em|i|del|s)>(.*?)<\/\1>/g,
      )) {
        const at = line.from + m.index!,
          left = m[1].length + 2,
          right = m[1].length + 3;
        replace(at, at + left);
        replace(at + m[0].length - right, at + m[0].length);
        mark(
          at + left,
          at + m[0].length - right,
          ["u"].includes(m[1])
            ? "lp-underline"
            : ["b", "strong"].includes(m[1])
              ? "lp-strong"
              : ["em", "i"].includes(m[1])
                ? "lp-emphasis"
                : "lp-strike",
        );
      }
      for (const m of line.text.matchAll(
        /!\[\[([^\]]+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\|[^\]]+)?)\]\]/gi,
      )) {
        const at = line.from + m.index!;
        replace(at, at + m[0].length);
        decorations.push(
          Decoration.widget({
            side: 1,
            widget: new Render(m[0], options, "lp-image"),
          }).range(line.to),
        );
      }
      for (const m of line.text.matchAll(
        /(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      )) {
        const at = line.from + m.index!,
          alias = m[2];
        const a = at + (alias ? m[0].indexOf("|") + 1 : 2),
          b = at + m[0].length - 2;
        replace(at, a);
        replace(b, at + m[0].length);
        mark(a, b, "lp-link", { "data-wiki": m[1] });
      }
    }
    for (let number = 1; number <= state.doc.lines; number++) {
      const classes = lineClasses.get(number) ?? new Set<string>();
      if (classes.size)
        decorations.push(
          Decoration.line({ class: [...classes].join(" ") }).range(
            state.doc.line(number).from,
          ),
        );
    }
    return {
      decorations: Decoration.set(decorations, true),
      atomics: Decoration.set(atomics, true),
    };
  };
  const field = StateField.define<{
    decorations: DecorationSet;
    atomics: DecorationSet;
    base: DecorationSet;
    active: Set<number>;
    focused: boolean;
    tree: ReturnType<typeof parser.parse>;
  }>({
    create(state) {
      const tree = parser.parse(state.doc.toString());
      const rendered = decorate(state, tree),
        active = selectedLines(state, true);
      return {
        ...rendered,
        base: rendered.decorations,
        decorations: revealSelectedLines(
          state,
          rendered.decorations,
          rendered.decorations,
          new Set(),
          active,
        ),
        active,
        focused: true,
        tree,
      };
    },
    update(value, tr) {
      let focused = value.focused;
      for (const e of tr.effects) if (e.is(focusEffect)) focused = e.value;
      if (tr.docChanged) {
        const tree = parser.parse(tr.state.doc.toString()),
          rendered = decorate(tr.state, tree),
          active = selectedLines(tr.state, focused);
        return {
          ...rendered,
          base: rendered.decorations,
          decorations: revealSelectedLines(
            tr.state,
            rendered.decorations,
            rendered.decorations,
            new Set(),
            active,
          ),
          active,
          focused,
          tree,
        };
      }
      if (tr.selection || focused !== value.focused) {
        const active = selectedLines(tr.state, focused);
        return {
          ...value,
          decorations: revealSelectedLines(
            tr.state,
            value.base,
            value.decorations,
            value.active,
            active,
          ),
          active,
          focused,
        };
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
  });
  const vertical =
    (forward: boolean, extend: boolean) => (view: EditorView) => {
      const { state } = view,
        selection = state.selection.main;
      if (!extend && !selection.empty) return false;
      const predicted = view.moveVertically(selection, forward).head,
        line = state.doc.lineAt(selection.head);
      if (
        (forward ? predicted > selection.head : predicted < selection.head) &&
        Math.abs(state.doc.lineAt(predicted).number - line.number) <= 1
      )
        return false;
      let number = line.number + (forward ? 1 : -1);
      if (number < 1 || number > state.doc.lines) return false;
      let target = state.doc.line(number),
        head =
          target.from + Math.min(selection.head - line.from, target.length);
      state.field(field).atomics.between(head, head, (from, to) => {
        head = forward
          ? Math.min(state.doc.length, to + 1)
          : Math.max(0, from - 1);
      });
      view.dispatch({
        selection: extend
          ? EditorSelection.range(selection.anchor, head)
          : EditorSelection.cursor(head),
        scrollIntoView: true,
        userEvent: "select.keyboard",
      });
      return true;
    };
  return [
    field,
    EditorView.editorAttributes.of({ class: "line-live-preview" }),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomics),
    Prec.highest(
      keymap.of([
        {
          key: "ArrowUp",
          run: vertical(false, false),
          shift: vertical(false, true),
        },
        {
          key: "ArrowDown",
          run: vertical(true, false),
          shift: vertical(true, true),
        },
      ]),
    ),
    EditorView.focusChangeEffect.of((_state, focused) =>
      focusEffect.of(focused),
    ),
    EditorView.updateListener.of((update) => {
      if (update.startState.readOnly === update.state.readOnly) return;
      for (const input of cellInputs.get(update.view)?.keys() ?? [])
        input.readOnly = update.state.readOnly;
    }),
    EditorView.domEventHandlers({
      click: (event) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-href],[data-wiki]",
        );
        if (!target) return false;
        if (target.dataset.wiki) {
          options.onWiki(target.dataset.wiki);
          event.preventDefault();
          return true;
        }
        const href = target.dataset.href;
        if (href) {
          event.preventDefault();
          if (href.startsWith("#")) {
            options.onWiki(href);
            return true;
          }
          if (/\.md(?:#.*)?$/i.test(href)) {
            const decoded = decodeLink(href);
            if (decoded !== undefined) options.onWiki(decoded);
          } else void external(href);
          return true;
        }
        return false;
      },
    }),
  ];
}
