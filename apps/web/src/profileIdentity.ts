/**
 * Local profile identity. Name and avatar never leave this machine —
 * they live in localStorage, not the daemon.
 */

export const PROFILE_NAME_KEY = "divisio:profile-name";
export const PROFILE_AVATAR_KEY = "divisio:profile-avatar";

const AVATAR_PX = 256;
const AVATAR_MAX_CHARS = 350_000;

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

export function loadDisplayName(): string {
  const saved = localStorage.getItem(PROFILE_NAME_KEY)?.trim();
  return saved || "Local";
}

export function saveDisplayName(name: string): string {
  const trimmed = name.trim() || "Local";
  localStorage.setItem(PROFILE_NAME_KEY, trimmed);
  return trimmed;
}

export function loadAvatar(): string | null {
  const saved = localStorage.getItem(PROFILE_AVATAR_KEY);
  return saved && saved.startsWith("data:image/") ? saved : null;
}

export function saveAvatar(dataUrl: string): void {
  try {
    localStorage.setItem(PROFILE_AVATAR_KEY, dataUrl);
  } catch {
    throw new Error("Could not save that photo on this machine.");
  }
}

export function clearAvatar(): void {
  localStorage.removeItem(PROFILE_AVATAR_KEY);
}

/** Square JPEG data URL, cover-cropped, small enough for localStorage. */
export async function encodeAvatarFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose an image file.");
  }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_PX;
    canvas.height = AVATAR_PX;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not read that image.");
    const scale = Math.max(AVATAR_PX / bitmap.width, AVATAR_PX / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    ctx.drawImage(bitmap, (AVATAR_PX - w) / 2, (AVATAR_PX - h) / 2, w, h);
    let url = canvas.toDataURL("image/jpeg", 0.84);
    if (url.length > AVATAR_MAX_CHARS) {
      url = canvas.toDataURL("image/jpeg", 0.68);
    }
    if (url.length > AVATAR_MAX_CHARS) {
      throw new Error("That photo is too large. Try a smaller image.");
    }
    return url;
  } finally {
    bitmap.close();
  }
}
