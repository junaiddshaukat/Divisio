import { describe, expect, test } from "bun:test";
import {
  DAEMON_GENERATION,
  REQUIRED_COMMANDS,
  daemonGenerationOf,
  incompatibilityOf,
  missingRequiredCommands,
} from "./protocol.ts";

describe("daemon generation", () => {
  test("a missing generation is never compatible, even if command names appear", () => {
    expect(
      incompatibilityOf({
        commands: [...REQUIRED_COMMANDS],
      }),
    ).toEqual({
      have: null,
      need: DAEMON_GENERATION,
      missing: [],
    });
  });

  test("current generation with a full command list is compatible", () => {
    expect(
      incompatibilityOf({
        generation: DAEMON_GENERATION,
        commands: [...REQUIRED_COMMANDS, "thread.handoff"],
      }),
    ).toBeNull();
  });

  test("a newer daemon is compatible with this client", () => {
    expect(
      incompatibilityOf({
        generation: DAEMON_GENERATION + 1,
        commands: [...REQUIRED_COMMANDS],
      }),
    ).toBeNull();
  });

  test("an older generation is incompatible", () => {
    const miss = incompatibilityOf({
      generation: 0,
      commands: [...REQUIRED_COMMANDS],
    });
    expect(miss?.have).toBe(0);
    expect(miss?.need).toBe(DAEMON_GENERATION);
  });

  test("generation without commands still lists what this app needs", () => {
    const miss = incompatibilityOf({ generation: DAEMON_GENERATION });
    expect(miss?.missing).toEqual([...REQUIRED_COMMANDS]);
  });

  test("a claimed generation that omits a required command is a miss", () => {
    const miss = incompatibilityOf({
      generation: DAEMON_GENERATION,
      commands: REQUIRED_COMMANDS.filter((c) => c !== "project.remove"),
    });
    expect(miss?.missing).toEqual(["project.remove"]);
  });

  test("non-integer generation is treated as absent", () => {
    expect(daemonGenerationOf({ generation: 1.5 })).toBeNull();
    expect(daemonGenerationOf({ generation: "1" })).toBeNull();
    expect(daemonGenerationOf({})).toBeNull();
  });

  test("missingRequiredCommands does not invent extras", () => {
    expect(missingRequiredCommands([...REQUIRED_COMMANDS])).toEqual([]);
  });
});

describe("desktop shell lock", () => {
  test("lib.rs DAEMON_GENERATION matches contracts", async () => {
    const rust = await Bun.file(new URL("../../../apps/desktop/src-tauri/src/lib.rs", import.meta.url)).text();
    const match = rust.match(/const DAEMON_GENERATION: u32 = (\d+);/);
    expect(match).toBeTruthy();
    expect(Number(match?.[1])).toBe(DAEMON_GENERATION);
  });
});
