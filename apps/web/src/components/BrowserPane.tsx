import { useEffect, useState } from "react";
import { Button, IconButton } from "./ui/Button.tsx";
import { CloseIcon } from "./ui/icons.ts";

interface Props {
  /** Suggested preview URL (lane port or project default). */
  suggestedUrl?: string | null;
  onClose(): void;
}

/**
 * Lightweight preview surface — loads a user-chosen URL in a sandboxed iframe.
 * No Divisio proxy; the page must be reachable from the desktop webview.
 */
export function BrowserPane({ suggestedUrl, onClose }: Props) {
  const [draft, setDraft] = useState(suggestedUrl ?? "http://127.0.0.1:3000");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (suggestedUrl) setDraft(suggestedUrl);
  }, [suggestedUrl]);

  const go = () => {
    setError(null);
    try {
      const parsed = new URL(draft.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        setError("Only http(s) URLs are allowed.");
        return;
      }
      setUrl(parsed.toString());
    } catch {
      setError("Enter a valid URL.");
    }
  };

  return (
    <section className="browser-pane" aria-label="Browser">
      <div className="file-pane-head">
        <span className="section-label">Browser</span>
        <IconButton label="Close" icon={<CloseIcon />} size="sm" onClick={onClose}  aria-label="Close" />
      </div>
      <div className="browser-bar">
        <input
          value={draft}
          placeholder="http://127.0.0.1:3000"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
        <Button variant="primary" size="sm" onClick={go}>
          Go
        </Button>
      </div>
      {error && <div className="banner tight">{error}</div>}
      {url ? (
        <iframe className="browser-frame" title="Preview" src={url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
      ) : (
        <div className="browser-empty">
          <p className="muted">Enter a local preview URL (Vite, Next, Storybook, lane port…).</p>
        </div>
      )}
    </section>
  );
}
