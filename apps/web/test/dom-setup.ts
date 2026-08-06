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
}
