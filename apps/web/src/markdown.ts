import { Marked } from "marked";
import hljs from "highlight.js/lib/common";
import createDOMPurify, { type Config } from "dompurify";

/**
 * DOMPurify's default export is a ready instance in a browser, but a factory
 * when no window existed at import time. Binding it explicitly means the same
 * code sanitises in the app and under test — and a sanitiser that silently
 * no-ops is worse than none, because it looks safe.
 */
type Purifier = { sanitize(html: string, cfg?: Config): string; isSupported: boolean };

function bindPurifier(): Purifier {
  const candidate = createDOMPurify as unknown as Purifier & ((win: unknown) => Purifier);
  const instance =
    typeof candidate.sanitize === "function" ? candidate : candidate(globalThis.window);

  // DOMPurify returns its input unchanged when it has no DOM to work with.
  // Silently shipping unsanitised agent output would be the worst outcome here,
  // so an unusable sanitiser is a hard failure instead.
  if (!instance || typeof instance.sanitize !== "function" || instance.isSupported === false) {
    throw new Error("DOMPurify has no usable DOM; refusing to render agent markdown unsanitised");
  }
  return instance;
}

/**
 * Agent-supplied links open in a new context and must not be able to reach back
 * into this window through `window.opener` — this page holds a token that
 * grants shell execution.
 */
function installLinkHook(instance: Purifier) {
  (instance as unknown as { addHook(name: string, cb: (node: Element) => void): void }).addHook(
    "afterSanitizeAttributes",
    (node) => {
      if (node.tagName === "A" && node.hasAttribute("href")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noreferrer noopener");
      }
    },
  );
}

let cached: Purifier | null = null;
function purifier(): Purifier {
  if (!cached) {
    cached = bindPurifier();
    installLinkHook(cached);
  }
  return cached;
}

/**
 * Markdown rendering for agent output.
 *
 * Agent text is not trusted input. It is shaped by repository contents, tool
 * output, and web pages the agent read, any of which an attacker may control.
 * This app holds a daemon token that grants shell execution, so injected HTML
 * would be a genuine cross-site scripting hole rather than a cosmetic bug.
 * Everything is therefore sanitised, and raw HTML in the source is escaped
 * rather than passed through.
 */

const marked = new Marked({
  gfm: true,
  breaks: true,
  // Escape embedded HTML instead of rendering it. Agents legitimately print
  // markup while explaining code, and it should read as text.
  async: false,
});

/** Highlighted code, with the language recorded for the block header. */
function highlight(code: string, language: string): { html: string; language: string } {
  // Only highlight when the fence names a language. Auto-detection guesses
  // wrongly on short snippets — it called "plain text" CSS — and confidently
  // wrong colouring is worse than none.
  if (!language || !hljs.getLanguage(language)) {
    return { html: escapeHtml(code), language: "" };
  }
  try {
    return { html: hljs.highlight(code, { language }).value, language };
  } catch {
    return { html: escapeHtml(code), language: "" };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

marked.use({
  renderer: {
    code({ text, lang }) {
      const { html, language } = highlight(text, (lang ?? "").split(/\s+/)[0] ?? "");
      const label = language || "text";
      // Copy reads the <code> element's text rather than a data attribute:
      // multi-line source in an attribute has to survive every parser's
      // whitespace handling, and one of them mangled it.
      //
      // A plain div rather than <figure>: semantically weaker, but it survives
      // every HTML parser identically, which a code block must.
      return `<div class="code-block">` +
        `<div class="code-head"><span class="code-lang">${escapeHtml(label)}</span>` +
        `<span class="code-head-actions">` +
        `<button class="code-expand" type="button">Expand</button>` +
        `<button class="code-copy" type="button">Copy</button></span></div>` +
        `<pre><code class="hljs language-${escapeHtml(label)}">${html}</code></pre></div>`;
    },
    link({ href, title, text }) {
      // target and rel are added after sanitisation instead of here: DOMPurify
      // strips them from author markup, so setting them at render time silently
      // achieved nothing. See the hook below.
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(href ?? "")}"${t}>${text}</a>`;
    },
  },
});

const PURIFY_CONFIG: Config = {
  ALLOWED_TAGS: [
    "p", "br", "hr", "strong", "em", "del", "code", "pre", "div",
    "span", "button", "a", "ul", "ol", "li", "blockquote",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tr", "th", "td",
  ],
  ALLOWED_ATTR: ["href", "title", "class", "target", "rel", "type"],
  ALLOW_DATA_ATTR: false,
  // NOTE: USE_PROFILES must not be set here. It replaces the allow-list above
  // rather than narrowing it, which silently re-admitted <script>, <object>,
  // and javascript: URLs. Caught only because these are tested.
  ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
};

export function renderMarkdown(source: string): string {
  const html = marked.parse(source) as string;
  // Cast because DOMPurify's types return TrustedHTML when Trusted Types are
  // available; the value is a string either way and is about to be assigned to
  // innerHTML, which accepts both.
  return purifier().sanitize(html, PURIFY_CONFIG) as unknown as string;
}
