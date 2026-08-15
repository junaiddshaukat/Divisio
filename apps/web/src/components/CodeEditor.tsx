import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
// The package's exports map already prefixes `esm/vs/`, so these subpaths must
// not repeat it — "monaco-editor/esm/vs/..." resolves to esm/vs/esm/vs/... .
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";

/**
 * Monaco, themed to match Divisio surfaces.
 *
 * Workers are wired explicitly: without them Monaco falls back to running
 * language services on the main thread, which stutters the whole UI while a
 * turn is streaming.
 *
 * Theme colors must be opaque `#RRGGBB`. Dark-mode CSS tokens are often
 * `rgba(...)` for glass — feeding those into `defineTheme` crashes Monaco's
 * `resolveParsedTokenThemeRules`.
 */
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

/** Solid hex surfaces — mirrors light/dark tokens without rgba/glass values. */
const THEMES = {
  "divisio-light": {
    base: "vs" as const,
    colors: {
      "editor.background": "#ffffff",
      "editorGutter.background": "#ffffff",
      "editor.lineHighlightBackground": "#f4f4f5",
      "editorLineNumber.foreground": "#71717a",
    },
  },
  "divisio-dark": {
    base: "vs-dark" as const,
    colors: {
      "editor.background": "#121212",
      "editorGutter.background": "#121212",
      "editor.lineHighlightBackground": "#1a1a1a",
      "editorLineNumber.foreground": "#a3a3a3",
    },
  },
};

let themesDefined = false;
function defineThemes() {
  if (themesDefined) return;
  themesDefined = true;
  for (const [name, theme] of Object.entries(THEMES)) {
    monaco.editor.defineTheme(name, {
      base: theme.base,
      inherit: true,
      rules: [],
      colors: theme.colors,
    });
  }
}

function monoFont(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return value || "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  json: "json", css: "css", scss: "scss", html: "html", md: "markdown",
  py: "python", rs: "rust", go: "go", java: "java", rb: "ruby", php: "php",
  sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml", toml: "ini",
  sql: "sql", c: "c", h: "c", cpp: "cpp", hpp: "cpp", swift: "swift", kt: "kotlin",
};

export function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[ext] ?? "plaintext";
}

interface Props {
  path: string;
  value: string;
  readOnly?: boolean;
  dark: boolean;
  onChange(value: string): void;
  onSave(): void;
}

export function CodeEditor({ path, value, readOnly, dark, onChange, onSave }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // Kept in a ref so the save command always calls the current handler without
  // needing to re-register the keybinding on every render.
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  useEffect(() => {
    if (!host.current) return;
    defineThemes();

    const instance = monaco.editor.create(host.current, {
      value,
      language: languageForPath(path),
      theme: dark ? "divisio-dark" : "divisio-light",
      readOnly: readOnly ?? false,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 20,
      fontFamily: monoFont(),
      scrollBeyondLastLine: false,
      renderLineHighlight: "line",
      smoothScrolling: false, // Animation on a high-frequency path; see ADR 0007.
      padding: { top: 12, bottom: 12 },
    });
    editor.current = instance;

    const changed = instance.onDidChangeModelContent(() => onChange(instance.getValue()));
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());

    return () => {
      changed.dispose();
      instance.getModel()?.dispose();
      instance.dispose();
      editor.current = null;
    };
    // Recreated per file: a fresh model per path keeps undo history from
    // bleeding between files.
  }, [path]);

  // External changes (a different file, or a reload) replace the buffer without
  // destroying the editor.
  useEffect(() => {
    const instance = editor.current;
    if (instance && instance.getValue() !== value) instance.setValue(value);
  }, [value]);

  useEffect(() => {
    defineThemes();
    monaco.editor.setTheme(dark ? "divisio-dark" : "divisio-light");
  }, [dark]);

  return <div className="code-editor" ref={host} />;
}
