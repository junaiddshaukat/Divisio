import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalManager, terminalsAvailable } from "./pty.ts";

describe("availability", () => {
  test("reports whether terminals can run, without throwing", () => {
    // A terminal is a feature, not a dependency: missing PTY support must
    // never take the daemon down.
    expect(typeof terminalsAvailable()).toBe("boolean");
  });

  test("Bun ≥1.3.5 exposes Terminal on this machine", () => {
    expect(terminalsAvailable()).toBe(true);
  });
});

describe("Bun.Terminal session", () => {
  const managers: TerminalManager[] = [];
  afterAll(() => {
    for (const m of managers) m.closeAll();
  });

  test("opens a shell PTY and receives output", async () => {
    if (!terminalsAvailable()) return;

    const cwd = mkdtempSync(join(tmpdir(), "divisio-term-"));
    const chunks: string[] = [];
    let exitCode: number | null = null;

    const manager = new TerminalManager({
      onData: (_id, data) => chunks.push(data),
      onExit: (_id, code) => {
        exitCode = code;
      },
    });
    managers.push(manager);

    manager.open("ses_test", "thr_test", cwd, 80, 24);
    // Drive a one-shot command; login shells vary, so write after a tick.
    await Bun.sleep(200);
    manager.get("ses_test")?.write("printf 'pty-ok\\n'; exit\n");

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (chunks.join("").includes("pty-ok") || exitCode !== null) break;
      await Bun.sleep(50);
    }

    manager.get("ses_test")?.kill();
    rmSync(cwd, { recursive: true, force: true });

    expect(chunks.join("")).toContain("pty-ok");
  }, 10_000);
});
