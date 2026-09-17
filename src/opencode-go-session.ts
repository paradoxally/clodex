/**
 * Which model a Claude Code session is currently using, as far as clodex can
 * tell from the wire.
 *
 * Claude Code keeps ONE usage-limit manager per process with no model identity:
 * the last successful response wins, and its background calls feed the same
 * manager as the user's own turns (`.claude/docs/claude-code-internals.md`).
 * A session whose selected model is served by OpenCode Go therefore still reads
 * the Claude plan's numbers off the Anthropic passthrough traffic, because
 * those responses carry the real `anthropic-ratelimit-unified-*` headers.
 *
 * Suppressing those headers needs the session's selected model, and the only
 * trustworthy sources for it are:
 *
 *   - a request clodex routes to OpenCode Go (Go never serves Claude Code's
 *     background calls, so such a request is always a user-selected model), and
 *   - a Claude-model request marked `x-claude-code-request-class: main`.
 *
 * Anything else — an auxiliary call, or a request whose class clodex cannot
 * read — leaves the recorded state alone rather than guessing.
 */

const MAX_TRACKED_SESSIONS = 512;

interface SessionModel {
  routedToOpenCodeGo: boolean;
  lastSeenMs: number;
}

const sessions = new Map<string, SessionModel>();

export interface SessionModelObservation {
  sessionId: string | undefined;
  /** True when clodex routed this request to an OpenCode Go model. */
  routedToOpenCodeGo: boolean;
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
  if (observation.routedToOpenCodeGo) {
    sessions.set(sessionId, { routedToOpenCodeGo: true, lastSeenMs: now });
    pruneSessions();
    return;
  }
  if (observation.requestClass !== 'main') {
    if (known) known.lastSeenMs = now;
    return;
  }
  if (known?.routedToOpenCodeGo) {
    sessions.set(sessionId, { routedToOpenCodeGo: false, lastSeenMs: now });
    return;
  }
  if (known) known.lastSeenMs = now;
}

/** True while the session's selected model is served by OpenCode Go. */
export function sessionUsesOpenCodeGo(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return sessions.get(sessionId)?.routedToOpenCodeGo === true;
}

export function resetOpenCodeGoSessionStateForTests(): void {
  sessions.clear();
}
