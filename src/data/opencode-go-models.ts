import { randomUUID } from 'node:crypto';
import models from './opencode-go-models.json';
import type { CachedModel } from '../registry/types.js';

export const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
export const OPENCODE_GO_PROVIDER_NAME = 'OpenCode Go';
export const OPENCODE_GO_COMPLETIONS_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const OPENCODE_GO_ANTHROPIC_BASE_URL = 'https://opencode.ai/zen/go';
export const OPENCODE_GO_SOURCE = 'https://models.dev/api.json';
export const OPENCODE_GO_SOURCE_FETCHED_AT = '2026-09-16T21:03:59.152Z';

type OpenCodeGoModel = Pick<CachedModel, 'id' | 'name'>
  & Partial<Omit<CachedModel, 'id' | 'name'>>;

/**
 * Curated OpenCode Go models supported by Clodex.
 *
 * Metadata (name, context, cost, modalities) comes from OpenCode's own
 * catalog (models.dev); per-model wire transport and compatibility behavior
 * are clodex's live-validated knowledge in the updater script. The upstream
 * catalog mixes Anthropic Messages, Chat Completions, and Responses
 * transports. A Responses entry enters the provider allowlist only once its
 * wire behaviour is verified against the live endpoint (gpt-5.6-luna); the
 * rest (currently Grok and mainline GPT) stay out.
 */
export function buildOpenCodeGoModels(): OpenCodeGoModel[] {
  return structuredClone(models) as unknown as OpenCodeGoModel[];
}

/** Used when the client sent no session id; one per process, never per request. */
const OPENCODE_GO_FALLBACK_SESSION_ID = randomUUID();

/**
 * A model counts as Go by provider id or by pointing at the Go base URL. The
 * URL arm is what covers an imported or migrated provider whose id has drifted
 * from the canonical `opencode-go` (a shape `registry/resolve-template.ts`
 * supports): there the URL is the only remaining signal. It therefore has to
 * read every field a Go entry can carry its URL in — `apiBaseUrl` is the one
 * the runtime `ServerModelInfo` actually populates for openai-compatible
 * providers (`server/models.ts`, built in `provider-catalog.ts`), and
 * `baseUrl` is the anthropic-format sibling; `apiUrl` is the cached-registry
 * spelling.
 */
export function isOpenCodeGoModel(
  model: { providerId?: string; apiUrl?: string; baseUrl?: string; apiBaseUrl?: string },
): boolean {
  const url = String(model.apiBaseUrl ?? model.baseUrl ?? model.apiUrl ?? '');
  return model.providerId === OPENCODE_GO_PROVIDER_ID
    || /^https:\/\/opencode\.ai\/zen\/go(\/|$)/.test(url);
}

/**
 * OpenCode Go rejects any request that carries no session id — `/v1/messages`,
 * `/v1/chat/completions` and `/v1/responses` all answer
 * `MissingSessionID: Request is missing x-opencode-session` (measured
 * 2026-09-11, and 2026-09-16 for `/v1/responses`, against the live endpoint).
 * The header lets Go pin a conversation to one backend and keep its prefix
 * cache warm, so forward Claude Code's own session id where one is known and
 * fall back to a stable per-process id.
 */
export function openCodeGoSessionHeaders(
  model: { providerId?: string; apiUrl?: string; baseUrl?: string; apiBaseUrl?: string },
  claudeSessionId: string | undefined,
): Record<string, string> | undefined {
  if (!isOpenCodeGoModel(model)) return undefined;
  return { 'x-opencode-session': claudeSessionId ?? OPENCODE_GO_FALLBACK_SESSION_ID };
}
