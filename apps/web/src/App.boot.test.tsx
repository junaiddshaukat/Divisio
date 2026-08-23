/**
 * Boots the real `App` through the transition that used to crash it: the first
 * paint has no token and returns early, then a token arrives and the full tree
 * renders. Hooks declared after those early returns make the two renders
 * disagree on hook count, and React throws from inside its own bookkeeping.
 *
 * This is a smoke test, not a UI test — it asserts the component mounts and
 * survives the transition, nothing about what it draws.
 */
// Shared jsdom install, and before anything that binds to a DOM at import time.
import "../test/dom-setup.ts";
import { describe, expect, test } from "bun:test";

/** The app opens a socket on mount; stand in for one that never connects. */
class SilentWebSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor(readonly url: string) {}
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

describe("App boot", () => {
  test("mounts, and survives a token arriving after the first paint", async () => {
    const { createElement } = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { App } = await import("./App.tsx");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    // Scoped, and restored below: these are process-wide globals, and leaving
    // either in place breaks every later test that wants a real socket.
    const previousSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
    const previousActFlag = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
    (globalThis as { WebSocket?: unknown }).WebSocket = SilentWebSocket;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args[0]);
    };

    try {
      // First paint: no token, App takes an early return.
      await act(async () => {
        root.render(createElement(App));
      });
      expect(container.innerHTML.length).toBeGreaterThan(0);

      // Drive the real transition: type a token into the gate and connect. The
      // first render took an early return; this one renders the whole tree, and
      // that mismatch is exactly what used to throw.
      const input = container.querySelector<HTMLInputElement>('input[placeholder="auth token"]');
      expect(input).not.toBeNull();

      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(input, "test-token");
        input!.dispatchEvent(new window.Event("input", { bubbles: true }));
      });

      await act(async () => {
        const connect = [...container.querySelectorAll("button")].find((b) =>
          /connect/i.test(b.textContent ?? ""),
        );
        expect(connect).toBeDefined();
        connect!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });

      // The gate is gone, so the full tree really did render.
      expect(container.querySelector('input[placeholder="auth token"]')).toBeNull();

      const hookErrors = errors
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .filter((m) => /hook|Rendered (more|fewer)/i.test(m));
      expect(hookErrors).toEqual([]);

      await act(async () => {
        root.unmount();
      });
    } finally {
      console.error = originalError;
      container.remove();
      (globalThis as { WebSocket?: unknown }).WebSocket = previousSocket;
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
        previousActFlag;
    }
  });
});
