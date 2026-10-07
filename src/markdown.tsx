import { useEffect, useId, useState, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { call, external } from "./api";
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
      return `![${alias ?? target}](${encodeURI(target)})`;
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
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true;
    if (!src) return;
    if (/^https?:\/\//i.test(src)) {
      setUrl(src);
      return;
    }
    const parent = path.split("/").slice(0, -1);
    for (const p of decodeURI(src).split("/")) {
      if (p === "..") parent.pop();
      else if (p !== ".") parent.push(p);
    }
    call<string>("read_asset", { vaultId, path: parent.join("/") })
      .then((u) => {
        if (live) setUrl(u);
      })
      .catch(() => {
        if (live) setUrl("");
      });
    return () => {
      live = false;
    };
  }, [src, vaultId, path]);
  return url ? (
    <img src={url} alt={alt ?? ""} loading="lazy" />
  ) : (
    <span className="missing-image">Attachment: {alt ?? src}</span>
  );
}
export function Markdown({
  content,
  dark,
  vaultId,
  path,
  onWiki,
  heading,
}: {
  content: string;
  dark: boolean;
  vaultId: string;
  path: string;
  onWiki: (target: string) => void;
  heading?: string;
}) {
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
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                if (href?.startsWith("#wiki:")) {
                  e.preventDefault();
                  onWiki(decodeURIComponent(href.slice(6)));
                } else if (href && !href.startsWith("#")) {
                  e.preventDefault();
                  if (/\.md(?:#.*)?$/i.test(href)) onWiki(decodeURI(href));
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
