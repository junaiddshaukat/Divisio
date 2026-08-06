import { memo, useCallback, useMemo } from "react";
import { renderMarkdown } from "../markdown.ts";

/**
 * Renders one markdown message.
 *
 * Memoised on the text: the transcript re-renders on every streamed delta, and
 * re-parsing every completed message each time would make a long thread slower
 * the longer it ran. Only the message whose text actually changed is reparsed.
 */
export const Markdown = memo(function Markdown({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);

  // Copy is delegated from the container rather than bound per block, so a
  // message with forty code blocks still has one listener.
  const onClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
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
      className="markdown"
      onClick={onClick}
      // Sanitised in renderMarkdown; agent output is untrusted and this app
      // holds a token that grants shell execution.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
