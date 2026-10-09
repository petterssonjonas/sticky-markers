import { call } from "./api";

// IPC invocations wait for the native decoder permit. Bound that queue on the
// renderer side too, and discard offscreen work before invoking native code.
const concurrency = 2;
const queueLimit = 32;
let active = 0;
type Task = { vaultId: string; path: string; signal: AbortSignal; resolve: (url: string) => void; reject: (error: Error) => void; onAbort: () => void };
const queue: Task[] = [];
function pump() {
  while (active < concurrency && queue.length) {
    const task = queue.shift()!;
    if (task.signal.aborted) { task.signal.removeEventListener("abort", task.onAbort); task.reject(new Error("Attachment is no longer visible")); continue; }
    active++;
    void call<string>("read_asset", { vaultId: task.vaultId, path: task.path })
      .then((url) => {
        if (task.signal.aborted) task.reject(new Error("Attachment is no longer visible"));
        else task.resolve(url);
      }, (error: unknown) => task.reject(error instanceof Error ? error : new Error(String(error))))
      .finally(() => { task.signal.removeEventListener("abort", task.onAbort); active--; pump(); });
  }
}
export function loadAttachment(vaultId: string, path: string, signal: AbortSignal): Promise<string> {
  if (queue.length >= queueLimit) return Promise.reject(new Error("Too many pending attachments"));
  return new Promise((resolve, reject) => {
    const task: Task = { vaultId, path, signal, resolve, reject, onAbort: () => {
      const index = queue.indexOf(task);
      if (index >= 0) { queue.splice(index, 1); reject(new Error("Attachment is no longer visible")); }
    } };
    queue.push(task);
    signal.addEventListener("abort", task.onAbort, { once: true });
    pump();
  });
}

/** Decode only vault-relative paths; malformed percent escapes are an ordinary
 * missing attachment, never an uncaught React effect exception. */
export function attachmentPath(source: string, notePath: string): string | undefined {
  let decoded: string;
  try {
    const uriPath = source.split(/[?#]/, 1)[0];
    // Wiki embeds encode filename delimiters. Decode these before decodeURI
    // so an actual "%23" filename (encoded as %2523) is decoded only once.
    decoded = decodeURI(uriPath.replace(/%23/gi, "#").replace(/%3f/gi, "?"));
  } catch { return undefined; }
  if (!decoded || decoded.startsWith("/") || decoded.includes("\\") || /^[a-z][a-z\d+.-]*:/i.test(decoded)) return undefined;
  const parts = notePath.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (part === "..") { if (!parts.length) return undefined; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/") || undefined;
}

export function decodeLink(source: string, component = false): string | undefined {
  try { return component ? decodeURIComponent(source) : decodeURI(source); }
  catch { return undefined; }
}
