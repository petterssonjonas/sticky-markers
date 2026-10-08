import { useEffect, useRef, useState } from "react";
import { call, desktop } from "./api";
import { noteFilename } from "./rename-name";
export function RenameWindow({ request }: { request: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    document.title = "Rename note...";
    let vaultId = "";
    void call<{ path: string; vaultId: string }>("rename_context", { request })
      .then((context) => {
        vaultId = context.vaultId;
        setName(context.path);
        setReady(true);
      })
      .catch((e) => setError(String(e)));
    const cancel = () => {
      if (!desktop)
        window.opener?.postMessage(
          { type: "rename-cancelled", vaultId },
          location.origin,
        );
    };
    window.addEventListener("pagehide", cancel);
    return () => window.removeEventListener("pagehide", cancel);
  }, [request]);
  useEffect(() => {
    if (ready) {
      input.current?.focus();
      input.current?.select();
    }
  }, [ready]);
  const cancel = () => void call("rename_cancel", { request });
  return (
    <form
      className="rename-window"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        void call("rename_submit", { request, newPath: name }).catch((e) => {
          setBusy(false);
          setError(String(e));
        });
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) cancel();
      }}
    >
      <h1>Rename note...</h1>
      <label>
        Note name
        <input
          ref={input}
          aria-label="Note name"
          autoFocus
          value={name}
          disabled={!ready || busy}
          onChange={(event) => setName(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
      <small>
        {name.trim() ? `Filename: ${noteFilename(name)}` : "Enter a note name."}
      </small>
      <small>Links in other notes keep their existing filenames.</small>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="action-row">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={cancel}
        >
          Cancel
        </button>
        <button className="primary" disabled={!ready || busy || !name.trim()}>
          Rename
        </button>
      </div>
    </form>
  );
}
