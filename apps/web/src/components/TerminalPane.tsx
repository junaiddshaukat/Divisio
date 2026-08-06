import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Props {
  dark: boolean;
  open(cols: number, rows: number): Promise<string>;
  input(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  close(sessionId: string): void;
  /** Registers a sink for output belonging to this session. */
  subscribe(sessionId: string, onData: (data: string) => void, onExit: (code: number) => void): () => void;
}

/** Reads a CSS custom property so the terminal matches the rest of the app. */
function token(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function TerminalPane({ dark, open, input, resize, close, subscribe }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!host.current) return;

    const term = new Terminal({
      fontFamily: token("--font-mono", "monospace"),
      fontSize: 12,
      lineHeight: 1.3,
      cursorBlink: true,
      // Scrollback costs memory per terminal; 5000 lines is generous for a
      // build log without holding a session's entire history forever.
      scrollback: 5000,
      theme: {
        background: token("--card", dark ? "#121212" : "#ffffff"),
        foreground: token("--foreground", dark ? "#f1f3f7" : "#27272a"),
        cursor: token("--foreground", dark ? "#f1f3f7" : "#27272a"),
        selectionBackground: token("--accent", "rgba(128,128,128,0.3)"),
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();

    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    void (async () => {
      try {
        const sessionId = await open(term.cols, term.rows);
        if (disposed) {
          // The pane closed while the shell was starting; do not leak it.
          close(sessionId);
          return;
        }
        sessionRef.current = sessionId;
        unsubscribe = subscribe(
          sessionId,
          (data) => term.write(data),
          (code) => term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`),
        );
        term.onData((data) => input(sessionId, data));
      } catch (err) {
        term.write(`\r\n\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`);
      }
    })();

    // The pty must be told the new size, or full-screen programs draw wrongly.
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (sessionRef.current) resize(sessionRef.current, term.cols, term.rows);
    });
    observer.observe(host.current);

    return () => {
      disposed = true;
      observer.disconnect();
      unsubscribe?.();
      if (sessionRef.current) close(sessionRef.current);
      sessionRef.current = null;
      term.dispose();
    };
    // Created once per mount: recreating on theme change would drop scrollback.
  }, []);

  return <div className="terminal-host" ref={host} />;
}
