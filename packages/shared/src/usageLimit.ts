/**
 * Heuristic for vendor usage / rate-limit failures.
 *
 * CLIs do not give Divisio a trustworthy "92% of quota" signal. What we can
 * see is the error they emit when they refuse a turn. Match those strings
 * honestly — never invent a percentage.
 */

const CODE_HINTS = new Set(["rate_limit", "quota_exceeded", "quota", "resource_exhausted"]);

const MESSAGE_HINT =
  /rate[\s_-]*limit|usage[\s_-]*limit|quota|too many requests|out of extra usage|you've hit your|limit reached|\b429\b/i;

export function looksLikeUsageLimit(input: {
  code?: string | null;
  message?: string | null;
}): boolean {
  const code = (input.code ?? "").trim().toLowerCase();
  if (code && CODE_HINTS.has(code)) return true;
  const message = input.message ?? "";
  return message.length > 0 && MESSAGE_HINT.test(message);
}
