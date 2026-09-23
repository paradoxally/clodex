/**
 * Claude Code's usage-limit banner is driven by `anthropic-ratelimit-unified-*`
 * on successful Messages responses, and the manager behind it has no model
 * identity: one reading per process, last response wins, and a window observed
 * within the last 30 minutes is re-derived from memory rather than left unset
 * (`recordSeenWindows` / `currentWindows` in the 2.1.273 bundle;
 * `.claude/docs/claude-code-internals.md`).
 */

const QUOTA_HEADER_PREFIX = 'anthropic-ratelimit-unified-';

/**
 * Replace the readings on a response with another provider's.
 *
 * Used on a session whose selected model is not Claude's (OpenCode Go, or an
 * OpenAI API key): Claude Code's own background calls are Anthropic passthrough
 * traffic, so their responses would otherwise hand the shared quota manager the
 * Claude plan's numbers. Deleting the headers is not enough — the held window keeps raising
 * the banner from memory for 30 minutes, and the client never reads the
 * response body's model — so the caller substitutes Go's own headers, which
 * both retire the Claude reading and re-assert Go's.
 *
 * Non-quota headers keep their order, values, and any duplicates.
 */
export function replaceClaudeQuotaHeaders(
  rawHeaders: string[],
  replacement: Record<string, string>,
): string[] {
  const kept: string[] = [];
  let sawQuota = false;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!;
    const value = rawHeaders[i + 1]!;
    if (name.toLowerCase().startsWith(QUOTA_HEADER_PREFIX)) {
      sawQuota = true;
      continue;
    }
    kept.push(name, value);
  }
  // Applied even when the response carried no quota headers of its own. The client
  // keeps raising a warning it observed within the last 30 minutes, so a Go
  // session must carry Go's readings on every response that reaches the manager --
  // not only on the ones that happened to arrive with Claude's.
  if (!sawQuota && Object.keys(replacement).length === 0) return rawHeaders;
  for (const [name, value] of Object.entries(replacement)) kept.push(name, value);
  return kept;
}

/**
 * The reading for a provider with no usage window of its own. It carries no
 * window, so it cannot erase a Claude window the client already holds: in
 * 2.1.280 a response with this status alone is processed exactly like one with
 * no quota headers (`.claude/docs/claude-code-internals.md`). What it does is
 * keep the Claude plan's fresh readings from reaching the client.
 */
export const NO_USAGE_WINDOW_HEADERS: Readonly<Record<string, string>> = {
  'anthropic-ratelimit-unified-status': 'allowed',
};

export { QUOTA_HEADER_PREFIX };
