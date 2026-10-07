import { createRoot, type Root } from "react-dom/client";
import { StateField, StateEffect, EditorSelection, Prec, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";
import { Markdown } from "./markdown";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkFrontmatter);
export interface PreviewOptions { dark: boolean; vaultId: string; path: string; onWiki: (target: string) => void }
const focusEffect = StateEffect.define<boolean>();
class Block extends WidgetType {
  private root?: Root;
  constructor(readonly source: string, readonly from: number, readonly options: PreviewOptions, readonly metadata: boolean) { super(); }
  eq(other: Block) { return this.source === other.source && this.options.dark === other.options.dark && this.options.path === other.options.path && this.options.vaultId === other.options.vaultId; }
  toDOM(view: EditorView) {
    const host = document.createElement("div"); host.className = "live-preview-block";
    host.addEventListener("mousedown", (event) => {
      if ((event.target as HTMLElement).closest("a, button, input, summary")) return;
      event.preventDefault();
      view.dispatch({ selection: { anchor: Math.min(view.posAtDOM(host), view.state.doc.length) }, effects: focusEffect.of(true) });
      view.focus();
    });
    this.root = createRoot(host);
    this.root.render(this.metadata ? <span className="frontmatter-hint">Note metadata · click to edit</span> : <Markdown content={this.source} {...this.options} />);
    return host;
  }
  destroy() { const root = this.root; queueMicrotask(() => root?.unmount()); }
  ignoreEvent() { return true; }
}
function visibleBlocks(tree: ReturnType<typeof parser.parse>, selection: { from: number; to: number }, focused: boolean) {
  return tree.children.filter((node) => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    return start !== undefined && end !== undefined && (!focused || (selection.to < start || selection.from > end));
  });
}
export function previewRanges(source: string, selection: { from: number; to: number }, focused: boolean) { return visibleBlocks(parser.parse(source), selection, focused); }
export function livePreview(options: PreviewOptions): Extension {
  const decorate = (state: EditorState, focused: boolean, tree: ReturnType<typeof parser.parse>): DecorationSet => {
    const source = state.doc.toString();
    // Reference definitions are shared across blocks, preserving Markdown links/footnotes.
    const definitions = tree.children.filter((n) => n.type === "definition" || n.type === "footnoteDefinition").map((n) => source.slice(n.position!.start.offset, n.position!.end.offset)).join("\n\n");
    return Decoration.set(visibleBlocks(tree, state.selection.main, focused).map((node) => {
      const from = node.position!.start.offset!, to = node.position!.end.offset!;
      const content = source.slice(from, to) + (definitions ? `\n\n${definitions}` : "");
      return Decoration.replace({ block: true, widget: new Block(content, from, options, node.type === "yaml" || String(node.type) === "toml") }).range(from, to);
    }), true);
  };
  const field = StateField.define<{ decorations: DecorationSet; focused: boolean; tree: ReturnType<typeof parser.parse> }>({
    create(state) { const tree = parser.parse(state.doc.toString()); return { decorations: decorate(state, true, tree), focused: true, tree }; },
    update(value, transaction) {
      let focused = value.focused;
      for (const effect of transaction.effects) {
        if (effect.is(focusEffect)) focused = effect.value;
      }
      if (transaction.docChanged || transaction.selection || focused !== value.focused) {
        const tree = transaction.docChanged ? parser.parse(transaction.state.doc.toString()) : value.tree;
        return { decorations: decorate(transaction.state, focused, tree), focused, tree };
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
  });
  let preferredColumn: number | null = null;
  let previousHead = -1;
  let previousDoc: EditorState["doc"] | null = null;
  const vertical = (forward: boolean, extend: boolean) => (view: EditorView) => {
    const { state } = view;
    const selection = state.selection.main;
    if (!extend && !selection.empty) return false;
    const node = state.field(field).tree.children.find((n) => selection.head >= n.position!.start.offset! && selection.head <= n.position!.end.offset!);
    const line = state.doc.lineAt(selection.head);
    const predicted = view.moveVertically(selection, forward).head;
    const nearby = Math.abs(state.doc.lineAt(predicted).number - line.number) <= 1;
    // Preserve normal visual movement, including wrapped lines, inside the
    // active source paragraph. Across replaced blocks, move by source row.
    if (node && nearby && (forward ? predicted > selection.head : predicted < selection.head) && predicted >= node.position!.start.offset! && predicted <= node.position!.end.offset!) {
      preferredColumn = null; previousHead = -1;
      return false;
    }
    const number = line.number + (forward ? 1 : -1);
    if (number < 1 || number > state.doc.lines) return false;
    if (previousHead !== selection.head || previousDoc !== state.doc || preferredColumn === null) preferredColumn = selection.head - line.from;
    const target = state.doc.line(number);
    const head = target.from + Math.min(preferredColumn, target.length);
    previousHead = head; previousDoc = state.doc;
    view.dispatch({ selection: extend ? EditorSelection.range(selection.anchor, head) : EditorSelection.cursor(head), scrollIntoView: true, userEvent: "select.keyboard" });
    return true;
  };
  return [field, Prec.highest(keymap.of([
    { key: "ArrowUp", run: vertical(false, false), shift: vertical(false, true) },
    { key: "ArrowDown", run: vertical(true, false), shift: vertical(true, true) },
  ])), EditorView.focusChangeEffect.of((_state, focused) => focusEffect.of(focused))];
}
