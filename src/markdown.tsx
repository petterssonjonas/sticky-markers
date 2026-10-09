import { Component, useEffect, useId, useState, useRef, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { external } from "./api";
import { attachmentPath, decodeLink, loadAttachment } from "./attachment-loader";
const schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "u"],
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ["className", /^language-/, "math-inline", "math-display"],
    ],
  },
};
export function headingSlug(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s+/g, "-");
}
interface MarkdownNode { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: MarkdownNode[] }
function headingIds() {
  return (tree: MarkdownNode) => {
    const seen = new Map<string, number>();
    const text = (n: MarkdownNode): string => n.value ?? (n.children ?? []).map(text).join("");
    const visit = (n: MarkdownNode) => {
      if (/^h[1-6]$/.test(n.tagName ?? "")) {
        const slug = headingSlug(text(n)); const count = seen.get(slug) ?? 0; seen.set(slug, count + 1);
        n.properties = { ...n.properties, id: slug + (count ? `-${count}` : "") };
      }
      n.children?.forEach(visit);
    };
    visit(tree);
  };
}
export function wikiMarkdown(s: string) {
  return s.replace(/(!?)\[\[([^\]]+)\]\]/g, (_, embed: string, raw: string) => {
    const [target, alias] = raw.split("|");
    if (embed && /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(target))
      return `![${alias ?? target}](${encodeURI(target).replace(/#/g, "%23").replace(/\?/g, "%3F")})`;
    return `[${alias ?? target}](#wiki:${encodeURIComponent(target)})`;
  });
}
function Diagram({ source, dark }: { source: string; dark: boolean }) {
  const id = useId().replace(/[^a-z0-9]/gi, "");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setError("");
    (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "neutral",
          fontFamily: "system-ui",
          suppressErrorRendering: true,
        });
        const result = await mermaid.render(`diagram${id}`, source);
        if (live) setSvg(result.svg);
      } catch (e) {
        if (live) setError(String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [source, dark, id]);
  return error ? (
    <details className="render-error">
      <summary>Diagram needs a correction</summary>
      <pre>{source}</pre>
      <small>{error}</small>
    </details>
  ) : (
    <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
  );
}
function Image({
  src,
  alt,
  vaultId,
  path,
}: {
  src?: string;
  alt?: string;
  vaultId: string;
  path: string;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [size, setSize] = useState<{ width: number; height: number }>();
  useEffect(() => {
    if (!host.current) return;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "100px" },
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setUrl("");
    setError("");
    if (!src || !near) return;
    if (/^https?:\/\//i.test(src)) {
      if (decodeLink(src)) setUrl(src);
      else setError("Invalid image URL");
      return;
    }
    const relative = attachmentPath(src, path);
    if (!relative) { setError("Invalid attachment path"); return; }
    loadAttachment(vaultId, relative, controller.signal)
      .then((u) => {
        if (!controller.signal.aborted) setUrl(u);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(String(error));
      });
    return () => controller.abort();
  }, [src, vaultId, path, near]);
  // Release offscreen data URLs/decoded image buffers, retaining their last
  // layout box so scrolling cannot collapse the document or cause jumping.
  return <span ref={host} style={{ display: "inline-block", maxWidth: "100%", ...(size && !url ? size : {}) }}>
    {url ? <img src={url} alt={alt ?? ""} loading="lazy" onLoad={(event) => {
      const box = event.currentTarget.getBoundingClientRect();
      setSize({ width: box.width, height: box.height });
    }} onError={() => { setUrl(""); setError("Could not display image"); }} />
      : (!size || error) && <span className="missing-image" title={error || undefined}>Attachment: {alt ?? src}</span>}
  </span>;
}

class MarkdownBoundary extends Component<{ content: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: Readonly<{ content: string; children: ReactNode }>) {
    if (previous.content !== this.props.content && this.state.failed) this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? <div className="render-error" role="status">
      Preview unavailable. Open the note in Edit mode to view its source.
      <pre>{this.props.content.slice(0, 4096)}</pre>
    </div> : this.props.children;
  }
}
type MarkdownProps = {
  content: string;
  dark: boolean;
  vaultId: string;
  path: string;
  onWiki: (target: string) => void;
  heading?: string;
  preview?: boolean;
};
export const Markdown = memo(function Markdown(props: MarkdownProps) {
  return <MarkdownBoundary content={props.content}><MarkdownContent {...props} /></MarkdownBoundary>;
});
function MarkdownContent({
  content,
  dark,
  vaultId,
  path,
  onWiki,
  heading,
  preview = false,
}: MarkdownProps) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (heading) root.current?.querySelector(`#${CSS.escape(headingSlug(heading))}`)?.scrollIntoView({ block: "start" });
  }, [heading, content]);
  return (
    <div className="markdown-body" ref={root}>
      <ReactMarkdown
        remarkPlugins={[remarkFrontmatter, remarkGfm, remarkMath]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, schema],
          rehypeKatex,
          rehypeHighlight,
          headingIds,
        ]}
        components={{
          code: ({ className, children, node: _node, ...props }) =>
            className?.split(" ").includes("language-mermaid") ? (
              <Diagram
                source={String(children).replace(/\n$/, "")}
                dark={dark}
              />
            ) : (
              <code className={className} {...props}>
                {children}
              </code>
            ),
          a: ({ href, children }) => preview ? <span>{children}</span> : (
            <a
              href={href}
              onClick={(e) => {
                if (href?.startsWith("#wiki:")) {
                  e.preventDefault();
                  const target = decodeLink(href.slice(6), true);
                  if (target !== undefined) onWiki(target);
                } else if (href && !href.startsWith("#")) {
                  e.preventDefault();
                  if (/\.md(?:#.*)?$/i.test(href)) {
                    const target = decodeLink(href);
                    if (target !== undefined) onWiki(target);
                  }
                  else void external(href);
                }
              }}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <Image
              src={typeof src === "string" ? src : undefined}
              alt={alt}
              vaultId={vaultId}
              path={path}
            />
          ),
        }}
      >
        {wikiMarkdown(content)}
      </ReactMarkdown>
    </div>
  );
}
