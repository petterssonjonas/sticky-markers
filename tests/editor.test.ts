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
  it("places an empty selection inside markers and exits on toggle", () => {
    const e = formatEdit("", 0, 0, "bold");
    expect(e.insert).toBe("****");
    expect(e.anchor).toBe(2);
    expect(formatEdit("**hello**", 7, 7, "bold").anchor).toBe(9);
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
    expect(text.slice(0, e.from) + e.insert + text.slice(e.to)).toBe("before\n#### Heading\nafter");
  });
});
