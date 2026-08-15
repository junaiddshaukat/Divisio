import { describe, expect, test, beforeEach } from "bun:test";
import {
  clearAvatar,
  initials,
  loadAvatar,
  loadDisplayName,
  saveAvatar,
  saveDisplayName,
} from "./profileIdentity.ts";

const store = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  },
});

describe("profile identity", () => {
  beforeEach(() => {
    store.clear();
  });

  test("initials from one or two names", () => {
    expect(initials("Junaid")).toBe("JU");
    expect(initials("Junaid Ahmed")).toBe("JA");
    expect(initials("  ")).toBe("?");
  });

  test("name persists locally and falls back to Local", () => {
    expect(loadDisplayName()).toBe("Local");
    expect(saveDisplayName("  Junaid  ")).toBe("Junaid");
    expect(loadDisplayName()).toBe("Junaid");
    expect(saveDisplayName("   ")).toBe("Local");
  });

  test("avatar stays on this machine and rejects non-images", () => {
    expect(loadAvatar()).toBeNull();
    saveAvatar("data:image/jpeg;base64,abc");
    expect(loadAvatar()).toBe("data:image/jpeg;base64,abc");
    store.set("divisio:profile-avatar", "https://example.com/x.png");
    expect(loadAvatar()).toBeNull();
    clearAvatar();
    expect(loadAvatar()).toBeNull();
  });
});
