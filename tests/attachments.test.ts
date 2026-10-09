import { describe, it, expect, vi } from "vitest";
const nativeCall = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
vi.mock("../src/api", () => ({ call: nativeCall, external: vi.fn() }));
import { attachmentPath, decodeLink, loadAttachment } from "../src/attachment-loader";
import { wikiMarkdown } from "../src/markdown";

describe("attachment and link decoding", () => {
  it("contains malformed escapes and rejects vault escapes", () => {
    for (const source of ["bad%zz.png", "bad%C0%AF.png", "../secret.png", "/etc/image.png", "file:/etc/image.png", "C:\\image.png"]) {
      expect(attachmentPath(source, "Note.md"), source).toBeUndefined();
    }
    expect(decodeLink("bad%zz.md")).toBeUndefined();
    expect(decodeLink("bad%zz", true)).toBeUndefined();
  });
  it("preserves legitimate relative paths, spaces and URI slash semantics", () => {
    expect(attachmentPath("assets/chart%231.png", "Note.md")).toBe("assets/chart#1.png");
    expect(attachmentPath("assets/what%3F.png", "Note.md")).toBe("assets/what?.png");
    expect(attachmentPath("assets/literal%2523.png", "Note.md")).toBe("assets/literal%23.png");
    expect(attachmentPath("../assets/my%20image.png?version=1#preview", "notes/Note.md")).toBe("assets/my image.png");
    expect(attachmentPath("assets/a%2Fb.png", "Note.md")).toBe("assets/a%2Fb.png");
    expect(decodeLink("a%20note.md#Heading")).toBe("a note.md#Heading");
    expect(decodeLink("a%20note%23Heading", true)).toBe("a note#Heading");
  });
  it("wiki embeds encode literal filename delimiters without decoding twice", () => {
    for (const file of ["assets/chart#1.png", "assets/what?.png", "assets/literal%23.png"]) {
      const encoded = wikiMarkdown(`![[${file}]]`).match(/\]\((.*)\)$/)![1];
      expect(attachmentPath(encoded, "Note.md")).toBe(file);
    }
  });
});

describe("bounded attachment IPC queue", () => {
  it("starts at most two calls and cancels queued offscreen work", async () => {
    const pending: ((value: string) => void)[] = [];
    nativeCall.mockClear();
    nativeCall.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const controllers = Array.from({ length: 35 }, () => new AbortController());
    const requests = controllers.map((controller, i) => loadAttachment("vault", `Image${i}.png`, controller.signal));
    const settled = Promise.allSettled(requests);
    expect(nativeCall).toHaveBeenCalledTimes(2);
    // Two active plus 32 queued: the next request is refused without an IPC.
    controllers.slice(2).forEach((controller) => controller.abort());
    pending.forEach((resolve) => resolve("data:image/png;base64,preview"));
    const results = await settled;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(33);
    expect(nativeCall).toHaveBeenCalledTimes(2);
  });
});
