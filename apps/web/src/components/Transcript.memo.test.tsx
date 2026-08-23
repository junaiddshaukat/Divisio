/**
 * The transcript re-renders on every streaming commit — roughly ten times a
 * second while a reply streams. Completed messages must not re-render with it,
 * or a long thread becomes slower to stream into than a short one.
 */
// Shared jsdom install, and before anything that binds to a DOM at import time.
import "../../test/dom-setup.ts";
// Tells React that updates below are wrapped in act(), so it batches them the
// way it does in the browser instead of warning.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, expect, test } from "bun:test";
import { memo, useState, createElement as h, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

/**
 * Mirrors the transcript's shape: a memoized row plus a sibling whose text
 * changes on every commit, standing in for the streaming bubble.
 */
let rowRenders = 0;
const Row = memo(function Row({ text }: { text: string }) {
  rowRenders += 1;
  return h("div", null, text);
});

function Harness({ onReady }: { onReady(set: (v: string) => void): void }): ReactNode {
  const [streaming, setStreaming] = useState("");
  onReady(setStreaming);
  return h(
    "div",
    null,
    h(Row, { key: "a", text: "first message" }),
    h(Row, { key: "b", text: "second message" }),
    h("div", { key: "s" }, streaming),
  );
}

describe("transcript row memoization", () => {
  test("settled rows do not re-render as the streaming bubble updates", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let setStreaming: ((v: string) => void) | null = null;

    await act(async () => {
      root.render(h(Harness, { onReady: (s) => { setStreaming = s; } }));
    });

    const afterMount = rowRenders;
    expect(afterMount).toBe(2);

    // Ten streaming commits, the rate the coalescer produces.
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        setStreaming!(`token ${i}`);
      });
    }

    // Zero additional row renders across all ten commits.
    expect(rowRenders).toBe(afterMount);
    await act(async () => { root.unmount(); });
    container.remove();
  });

  test("a row does re-render when its own text actually changes", async () => {
    rowRenders = 0;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => { root.render(h(Row, { text: "one" })); });
    expect(rowRenders).toBe(1);
    await act(async () => { root.render(h(Row, { text: "two" })); });
    expect(rowRenders).toBe(2);
    // Same props: memo must skip it.
    await act(async () => { root.render(h(Row, { text: "two" })); });
    expect(rowRenders).toBe(2);

    await act(async () => { root.unmount(); });
    container.remove();
  });
});
