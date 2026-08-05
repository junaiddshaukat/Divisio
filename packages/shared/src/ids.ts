import { randomUUID } from "node:crypto";

/**
 * Prefixed ids. The prefix is worth the bytes: every id that shows up in a log
 * line, an error, or a WS frame says what it is without a lookup.
 */
export type IdPrefix = "prj" | "thr" | "trn" | "ses" | "apr" | "env" | "msg";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function isId(value: unknown, prefix: IdPrefix): value is string {
  return typeof value === "string" && value.startsWith(`${prefix}_`);
}
