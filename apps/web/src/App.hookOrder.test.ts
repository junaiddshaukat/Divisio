/**
 * React matches hooks by call order across renders. A hook declared after a
 * conditional `return` runs on some renders and not others, and the counts stop
 * lining up — which surfaces as a crash deep inside React's own hook
 * bookkeeping, pointing at whatever unrelated hook happened to be at that
 * index. `App` has several early returns (pairing, no token, onboarding), so
 * this is easy to reintroduce and expensive to debug by hand.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOOK = /\buse(State|Memo|Callback|Effect|LayoutEffect|Ref|DeferredValue|Transition)\s*\(/;

describe("App hook ordering", () => {
  test("no hook is declared after an early return in App", () => {
    const source = readFileSync(join(import.meta.dir, "App.tsx"), "utf8").split("\n");

    const appStart = source.findIndex((l) => /^export function App\(\)/.test(l));
    expect(appStart).toBeGreaterThan(-1);

    // App's own body is indented two spaces; the next top-level declaration ends it.
    let appEnd = source.length;
    for (let i = appStart + 1; i < source.length; i += 1) {
      if (/^(export )?(function|const|class) /.test(source[i]!)) {
        appEnd = i;
        break;
      }
    }

    // First conditional return at App's own indentation level.
    let firstEarlyReturn = -1;
    for (let i = appStart; i < appEnd; i += 1) {
      if (!/^ {2}if \(.*\{\s*$/.test(source[i]!)) continue;
      for (let j = i; j < Math.min(i + 12, appEnd); j += 1) {
        if (/^ {4}return[ (]/.test(source[j]!)) {
          firstEarlyReturn = i;
          break;
        }
      }
      if (firstEarlyReturn !== -1) break;
    }

    if (firstEarlyReturn === -1) return; // no early return: nothing to guard

    const offenders: string[] = [];
    for (let i = firstEarlyReturn; i < appEnd; i += 1) {
      const line = source[i]!;
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      if (HOOK.test(line)) offenders.push(`App.tsx:${i + 1}: ${line.trim()}`);
    }

    expect(offenders).toEqual([]);
  });
});
