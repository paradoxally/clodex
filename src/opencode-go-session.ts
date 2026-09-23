/**
 * Which model a Claude Code session is currently using, as far as clodex can
 * tell from the wire, reduced to where that model's usage readings come from.
 *
 * Claude Code keeps ONE usage-limit manager per process with no model identity:
 * the last successful response wins, and its background calls feed the same
 * manager as the user's own turns (`.claude/docs/claude-code-internals.md`).
 * A session whose selected model is served by OpenCode Go therefore still reads
 * the Claude plan's numbers off the Anthropic passthrough traffic, because
 * those responses carry the real `anthropic-ratelimit-unified-*` headers. The
 * same holds for a model on an OpenAI API key, which has no usage window of its
 * own to show in their place.
 *
 * Suppressing those headers needs the session's selected model, and the only
 * trustworthy sources for it are:
 *
 *   - a request clodex routes to one of those providers (clodex never points
 *     Claude Code's background calls at a routed model; a subagent running on
 *     one does count, and holds the session until the next `main` Claude turn), and
 *   - a Claude-model request marked `x-claude-code-request-class: main`.
 *
 * Anything else — an auxiliary call, or a request whose class clodex cannot
 * read — leaves the recorded state alone rather than guessing.
 */

const MAX_TRACKED_SESSIONS = 512;

/**
 * `opencode-go`: Go reports its own windows. `none`: the provider has no usage
 * window at all (OpenAI API keys only carry per-minute limits).
 */
export type RoutedUsageSource = 'opencode-go' | 'none';

interface SessionModel {
  routedUsage: RoutedUsageSource | undefined;
  lastSeenMs: number;
}

const sessions = new Map<string, SessionModel>();

export interface SessionModelObservation {
  sessionId: string | undefined;
  /** Set when clodex routed this request to a provider whose usage replaces Claude's. */
  routedUsage: RoutedUsageSource | undefined;
  /** `x-claude-code-request-class`: `main` for the user's own turns. */
  requestClass: string | undefined;
}

function pruneSessions(): void {
  while (sessions.size > MAX_TRACKED_SESSIONS) {
    let oldestKey: string | undefined;
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const [key, value] of sessions) {
      if (value.lastSeenMs < oldestMs) {
        oldestMs = value.lastSeenMs;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) return;
    sessions.delete(oldestKey);
  }
}

export function recordSessionModel(observation: SessionModelObservation, now = Date.now()): void {
  const { sessionId } = observation;
  if (!sessionId) return;
  const known = sessions.get(sessionId);
  if (observation.routedUsage) {
    sessions.set(sessionId, { routedUsage: observation.routedUsage, lastSeenMs: now });
    pruneSessions();
    return;
  }
  if (observation.requestClass !== 'main') {
    if (known) known.lastSeenMs = now;
    return;
  }
  if (known?.routedUsage) {
    sessions.set(sessionId, { routedUsage: undefined, lastSeenMs: now });
    return;
  }
  if (known) known.lastSeenMs = now;
}

/** Where the session's selected model gets its usage readings; undefined for Claude. */
export function sessionRoutedUsage(sessionId: string | undefined): RoutedUsageSource | undefined {
  if (!sessionId) return undefined;
  return sessions.get(sessionId)?.routedUsage;
}

export function resetOpenCodeGoSessionStateForTests(): void {
  sessions.clear();
}
