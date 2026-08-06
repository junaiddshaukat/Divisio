import { describe, expect, test } from "bun:test";

// Imported for its side effect, and before markdown.ts: DOMPurify binds to
// whatever DOM exists at import time and binds to nothing if one arrives later.
// Done here rather than through a preload so the result does not depend on
// which directory `bun test` was run from.
import "../test/dom-setup.ts";
const { renderMarkdown } = await import("./markdown.ts");

/**
 * Agent output is shaped by repository contents, tool output, and pages the
 * agent read — any of which an attacker may control. This app holds a daemon
 * token that grants shell execution, so injected markup would be a real
 * cross-site scripting hole, not a cosmetic bug.
 */

describe("sanitisation", () => {
  test("strips script tags", () => {
    const html = renderMarkdown("Hello\n\n<script>alert(document.cookie)</script>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(");
  });

  test("strips inline event handlers", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html.toLowerCase()).not.toContain("onerror");
  });

  test("drops javascript: links", () => {
    const html = renderMarkdown("[click me](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  test("drops iframes and objects", () => {
    const html = renderMarkdown("<iframe src=//evil.example></iframe><object data=x></object>");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<object");
  });

  test("keeps ordinary formatting intact", () => {
    const html = renderMarkdown("**bold** and `code` and [link](https://example.com)");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('href="https://example.com"');
  });

  test("agent-supplied links cannot reach back into this window", () => {
    const html = renderMarkdown("[x](https://example.com)");
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('target="_blank"');
  });
});

describe("code blocks", () => {
  test("highlights a fenced block and records its language", () => {
    const html = renderMarkdown("```ts\nconst x: number = 1;\n```");
    expect(html).toContain("code-block");
    expect(html).toContain("language-ts");
    expect(html).toContain("hljs-keyword");
  });

  test("the code text survives highlighting, so Copy can read it back", () => {
    const html = renderMarkdown("```js\nconst a = 1;\n```");
    // Copy reads textContent from the <code> element; stripping the markup
    // must yield exactly what the agent wrote.
    const text = html.replace(/<[^>]*>/g, "");
    expect(text).toContain("const a = 1;");
  });

  test("an unlabelled block renders plainly rather than being guessed", () => {
    // highlightAuto used to label this CSS and colour it accordingly.
    const html = renderMarkdown("```\nplain text\n```");
    expect(html).toContain("code-block");
    expect(html).toContain("plain text");
    expect(html).not.toContain("hljs-selector-tag");
  });

  test("a code block containing markup does not escape into HTML", () => {
    const html = renderMarkdown("```html\n<script>alert(1)</script>\n```");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("code-block");
  });
});

describe("streaming", () => {
  test("partial markdown mid-stream does not throw", () => {
    // The transcript renders every delta, so half-written syntax is normal.
    for (const partial of ["```ts", "```ts\ncons", "**bo", "| a | b", "- item\n- ", "[link"]) {
      expect(() => renderMarkdown(partial)).not.toThrow();
    }
  });
});
