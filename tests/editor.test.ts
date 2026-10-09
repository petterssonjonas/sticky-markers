import { describe, it, expect } from "vitest";
import { formatEdit } from "../src/editor";
import { wikiMarkdown } from "../src/markdown";
describe("source formatting", () => {
  it("wraps only the selected text", () => {
    const e = formatEdit("one two three", 4, 7, "bold");
    expect(
      "one two three".slice(0, e.from) + e.insert + "one two three".slice(e.to),
    ).toBe("one **two** three");
  });
  it("places an empty selection inside literal markers", () => {
    const e = formatEdit("", 0, 0, "bold");
    expect(e.insert).toBe("****");
    expect(e.anchor).toBe(2);
    expect(formatEdit("text", 4, 4, "italic")).toMatchObject({
      insert: "**",
      anchor: 5,
    });
  });
  it("inserts underline that survives Markdown export", () => {
    expect(formatEdit("word", 0, 4, "underline").insert).toBe("<u>word</u>");
  });
  it("formats selected list lines and creates a valid table", () => {
    expect(formatEdit("one\ntwo", 0, 7, "bullets").insert).toBe("- one\n- two");
    expect(formatEdit("", 0, 0, "table").insert).toContain("| --- | --- |");
  });
});
describe("vault links", () => {
  it("preserves aliases and attachment syntax", () => {
    expect(wikiMarkdown("[[Weekend|Plans]] ![[photo.png]]")).toBe(
      "[Plans](#wiki:Weekend) ![photo.png](photo.png)",
    );
  });
});

describe("heading insertion", () => {
  it("replaces an existing heading level and preserves surrounding lines", () => {
    const text = "before\n## Heading\nafter";
    const e = formatEdit(text, 10, 10, "heading4");
    expect(text.slice(0, e.from) + e.insert + text.slice(e.to)).toBe(
      "before\n#### Heading\nafter",
    );
  });
});

describe("literal code insertion", () => {
  it("places the cursor inside inline and fenced code", () => {
    expect(formatEdit("", 0, 0, "code")).toMatchObject({
      insert: "``",
      anchor: 1,
    });
    expect(formatEdit("", 0, 0, "codeblock")).toMatchObject({
      insert: "```\n\n```",
      anchor: 4,
    });
    expect(formatEdit("word", 0, 4, "italic").insert).toBe("*word*");
  });
  it("keeps selected code intact and uses a safe fence", () => {
    const code = "one\n```embedded\ntwo";
    const edit = formatEdit(code, 0, code.length, "codeblock");
    expect(edit.insert).toBe("````\n" + code + "\n````");
  });
});

import { activeLines, livePreview } from "../src/live-preview";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
describe("line-level preview", () => {
  it("reveals one selected list row, not its whole AST section", () => {
    const source = "- first\n- second\n- third";
    expect(activeLines(source, { from: 10, to: 10 }, true)).toEqual([2]);
    expect(activeLines(source, { from: 2, to: 12 }, true)).toEqual([1, 2]);
    expect(activeLines(source, { from: 10, to: 10 }, false)).toEqual([]);
    expect(activeLines(source, { from: 0, to: 8 }, true)).toEqual([1]);
    expect(activeLines(source, { from: 8, to: 8 }, true)).toEqual([2]);
  });
  it("restores only rows entering or leaving the active selection", () => {
    const doc = "- first **bold**\n- second *italic*\n- third";
    const options = { dark: false, vaultId: "test", path: "note.md", onWiki() {} };
    const decorations = (state: EditorState) =>
      state.facet(EditorView.decorations)[0] as DecorationSet;
    const syntaxOn = (state: EditorState, row: number) => {
      const line = state.doc.line(row), found: unknown[] = [];
      decorations(state).between(line.from, line.to, (from, _to, decoration) => {
        if (from >= line.from && decoration.spec.lpSyntax) found.push(decoration);
      });
      return found;
    };
    let state = EditorState.create({ doc, extensions: livePreview(options) });
    const untouched = syntaxOn(state, 3);
    expect(syntaxOn(state, 1)).toHaveLength(0);
    expect(syntaxOn(state, 2)).toHaveLength(3);
    state = state.update({ selection: { anchor: state.doc.line(2).from + 2 } }).state;
    expect(syntaxOn(state, 1)).toHaveLength(3);
    expect(syntaxOn(state, 2)).toHaveLength(0);
    expect(syntaxOn(state, 3)).toEqual(untouched);
    expect(syntaxOn(state, 3)[0]).toBe(untouched[0]);
    state = state.update({ selection: { anchor: 0, head: state.doc.line(2).to } }).state;
    expect(syntaxOn(state, 1)).toHaveLength(0);
    expect(syntaxOn(state, 2)).toHaveLength(0);
    expect(syntaxOn(state, 3)[0]).toBe(untouched[0]);
  });
  it("moves the cursor through a valid dense 72 KiB note without full redecorating", () => {
    const doc = "**item**\n".repeat(8000);
    let state = EditorState.create({
      doc,
      extensions: livePreview({ dark: false, vaultId: "test", path: "dense.md", onWiki() {} }),
    });
    const start = performance.now();
    for (let row = 1; row <= 30; row++)
      state = state.update({ selection: EditorSelection.cursor(row * 9 + 2) }).state;
    const elapsed = performance.now() - start;
    expect(state.doc.toString()).toBe(doc);
    // The old whole-document algorithm took ~268 ms per move (over 8 s for
    // this loop). Keep ample CI headroom without accepting that regression.
    expect(elapsed).toBeLessThan(1000);
    console.log(`Dense rendered note: 30 cursor moves in ${elapsed.toFixed(1)} ms`);
  });
});
