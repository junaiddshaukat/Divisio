/**
 * Installs a DOM for tests that need one.
 *
 * jsdom rather than happy-dom, deliberately. DOMPurify is developed and tested
 * against jsdom; under happy-dom it reported isSupported: true while stripping
 * <p> and *keeping* <script>. A sanitiser test that runs on a DOM the sanitiser
 * does not fully support proves nothing, and would have signed off an XSS hole.
 */
import { JSDOM } from "jsdom";

if (typeof globalThis.document === "undefined") {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.Node = win.Node;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.DocumentFragment = win.DocumentFragment;
  globalThis.navigator ??= win.navigator;
  // Component code reads persisted preferences during its first render, so a
  // DOM without storage is not a usable DOM for anything that mounts.
  globalThis.localStorage ??= win.localStorage;
  globalThis.sessionStorage ??= win.sessionStorage;
  globalThis.HTMLInputElement ??= win.HTMLInputElement;
  // Event constructors are deliberately NOT copied onto globalThis: the runtime
  // already defines its own, and jsdom rejects events built from a foreign
  // class. Tests that dispatch should construct from `window`.

  // jsdom does not implement matchMedia, and theme code queries it on mount.
  // Report "no preference" rather than throwing; tests that care about a
  // specific preference should stub it themselves.
  if (typeof win.matchMedia !== "function") {
    win.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof win.matchMedia;
  }
}
