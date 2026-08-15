import { memo, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { renderMarkdown } from "../markdown.ts";

const COLLAPSE_AT = 280;

/**
 * Renders one markdown message.
 *
 * Memoised on the text: the transcript re-renders on every streamed delta, and
 * re-parsing every completed message each time would make a long thread slower
 * the longer it ran. Only the message whose text actually changed is reparsed.
 */
export const Markdown = memo(function Markdown({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const block of root.querySelectorAll(".code-block")) {
      const pre = block.querySelector("pre");
      if (pre && pre.scrollHeight > COLLAPSE_AT) {
        block.classList.add("is-collapsible", "is-collapsed");
      }
    }
  }, [html]);

  // Copy / expand are delegated from the container rather than bound per block,
  // so a message with forty code blocks still has one listener.
  const onClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains("code-expand")) {
      const block = target.closest(".code-block");
      if (!block) return;
      const collapsed = block.classList.toggle("is-collapsed");
      target.textContent = collapsed ? "Expand" : "Collapse";
      return;
    }
    if (!target.classList.contains("code-copy")) return;
    const source = target.closest(".code-block")?.querySelector("code")?.textContent;
    if (!source) return;
    void navigator.clipboard.writeText(source).then(() => {
      const previous = target.textContent;
      target.textContent = "Copied";
      setTimeout(() => {
        target.textContent = previous;
      }, 1200);
    });
  }, []);

  return (
    <div
      ref={rootRef}
      className="markdown"
      onClick={onClick}
      // Sanitised in renderMarkdown; agent output is untrusted and this app
      // holds a token that grants shell execution.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
