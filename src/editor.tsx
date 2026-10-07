import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  drawSelection,
  highlightSpecialChars,
} from "@codemirror/view";
import {
  history,
  historyKeymap,
  defaultKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { livePreview, type PreviewOptions } from "./live-preview";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
export interface EditorHandle {
  format: (kind: string) => void;
  focus: () => void;
  setReadOnly: (locked: boolean) => void;
}
export function formatEdit(
  text: string,
  from: number,
  to: number,
  kind: string,
) {
  const tokens: Record<string, [string, string]> = {
    bold: ["**", "**"],
    italic: ["_", "_"],
    underline: ["<u>", "</u>"],
    strike: ["~~", "~~"],
  };
  if (/^heading[1-6]$/.test(kind)) {
    const start = text.lastIndexOf("\n", from - 1) + 1;
    const end = text.indexOf("\n", to);
    const stop = end < 0 ? text.length : end;
    const insert = text.slice(start, stop).split("\n").map((line) => `${"#".repeat(Number(kind.slice(-1)))} ${line.replace(/^#{1,6}\s+/, "")}`).join("\n");
    return { from: start, to: stop, insert, anchor: start + insert.length };
  }
  if (kind === "bullets") {
    const start = text.lastIndexOf("\n", from - 1) + 1;
    const selected = text.slice(start, to);
    const insert = selected
      .split("\n")
      .map((l) => (l.startsWith("- ") ? l.slice(2) : `- ${l}`))
      .join("\n");
    return { from: start, to, insert, anchor: start + insert.length };
  }
  if (kind === "table") {
    const insert = "\n\n| Heading | Heading |\n| --- | --- |\n|  |  |\n";
    return { from, to, insert, anchor: from + insert.indexOf("Heading") };
  }
  const [left, right] = tokens[kind] ?? ["", ""];
  if (from === to && text.slice(to, to + right.length) === right) {
    return { from, to, insert: "", anchor: to + right.length };
  }
  const selected = text.slice(from, to);
  if (
    selected.startsWith(left) &&
    selected.endsWith(right) &&
    selected.length >= left.length + right.length
  ) {
    return {
      from,
      to,
      insert: selected.slice(left.length, -right.length),
      anchor: from + selected.length - left.length - right.length,
    };
  }
  return {
    from,
    to,
    insert: left + selected + right,
    anchor: from + left.length + (from === to ? 0 : selected.length),
  };
}
export const MarkdownEditor = forwardRef<
  EditorHandle,
  {
    value: string;
    onChange: (s: string) => void;
    dark: boolean;
    onLink?: (s: string) => void;
    readOnly?: boolean;
    rendered?: boolean;
    plain?: boolean;
    preview?: PreviewOptions;
    heading?: string;
  }
>(function Editor({ value, onChange, dark, onLink, readOnly = false, rendered = false, plain = false, preview, heading }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  callback.current = onChange;
  const theme = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const presentation = useRef(new Compartment());
  const syntax = useRef(new Compartment());
  const externalChange = useRef(false);
  const lineEnding=useRef(value.includes('\r\n')?'\r\n':'\n');
  lineEnding.current=value.includes('\r\n')?'\r\n':'\n';
  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    setReadOnly: (locked) => view.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(locked), EditorView.editable.of(!locked)]) }),
    format: (kind) => {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      const edit = formatEdit(v.state.doc.toString(), from, to, kind);
      v.dispatch({
        changes: { from: edit.from, to: edit.to, insert: edit.insert },
        selection: { anchor: edit.anchor },
        scrollIntoView: true,
      });
      v.focus();
    },
  }));
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          presentation.current.of(rendered && preview ? livePreview(preview) : [lineNumbers(), highlightActiveLineGutter()]),
          drawSelection(),
          highlightSpecialChars(),
          history(),
          editable.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          syntax.current.of(plain ? [] : markdown()),
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.lineWrapping,
          keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !externalChange.current)
              callback.current(u.state.doc.toString().replace(/\n/g,lineEnding.current));
          }),
          theme.current.of(EditorView.theme({}, { dark })),
          EditorView.contentAttributes.of({
            "aria-label": "Markdown note editor",
            spellcheck: "true",
          }),
          EditorView.domEventHandlers({
            click: (e, v) => {
              if (!(e.ctrlKey || e.metaKey) || !onLink) return false;
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos === null) return false;
              const line = v.state.doc.lineAt(pos).text;
              const match = line.match(/\]\((https?:\/\/[^)]+)\)/);
              if (match) {
                onLink(match[1]);
                return true;
              }
              return false;
            },
          }),
        ],
      }),
    });
    view.current = v;
    v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value.replace(/\r\n/g,'\n')) {
      externalChange.current = true;
      try {
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: value },
        });
      } finally {
        externalChange.current = false;
      }
    }
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({
      effects: theme.current.reconfigure(EditorView.theme({}, { dark })),
    });
  }, [dark]);
  useEffect(() => {
    view.current?.dispatch({ effects: [presentation.current.reconfigure(rendered && preview ? livePreview(preview) : [lineNumbers(), highlightActiveLineGutter()]), syntax.current.reconfigure(plain ? [] : markdown())] });
  }, [rendered, plain, dark, preview?.vaultId, preview?.path]);
  useEffect(() => {
    if (!heading || !view.current) return;
    const v = view.current;
    const target = heading.toLowerCase().replace(/[-_]/g, " ");
    for (let i = 1; i <= v.state.doc.lines; i++) {
      const line = v.state.doc.line(i);
      if (line.text.replace(/^#+\s*/, "").toLowerCase() === target) {
        v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "start" }) }); break;
      }
    }
  }, [heading]);
  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);
  return <div className="markdown-editor" ref={host} />;
});
