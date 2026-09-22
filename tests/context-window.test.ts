import { describe, it, expect, vi } from 'vitest';
import {
  resolveContextWindow,
  contextWindowFromHeuristics,
  buildContextWindowIndex,
  lookupContextWindow,
  lookupKnownContextWindow,
  DEFAULT_CONTEXT_WINDOW,
} from '../src/context-window.js';
import { OPENCODE_CACHE_PATH } from '../src/constants.js';

// The tier-1 leg reads this file once per process. Serving it here is the only way
// to prove the curated leg still answers, and to prove it answers FIRST: the fixture
// window deliberately contradicts the heuristic rule that also claims the id.
vi.mock('node:fs', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: (path: unknown, ...rest: unknown[]) => {
    if (String(path) === OPENCODE_CACHE_PATH) {
      return JSON.stringify({
        opencode: {
          models: {
            // Heuristics would call this 131,072. Curated data says otherwise.
            'qwen-fixture-7b': { limit: { context: 40_960 } },
          },
        },
      });
    }
    return (importOriginalFs as typeof import('node:fs')).readFileSync(
      path as string,
      ...(rest as []),
    );
  },
}));
const importOriginalFs = await vi.importActual<typeof import('node:fs')>('node:fs');

describe('contextWindowFromHeuristics', () => {
  it.each([
    ['gemini-3.5-flash', 1_000_000],
    ['gemini-2.5-pro', 2_000_000],
    ['claude-sonnet-4-6', 1_000_000],
    ['claude-opus-4-6', 1_000_000],
    ['claude-haiku-4-5', 200_000],
    ['claude-3-5-sonnet', 200_000],
    ['deepseek-v4-flash', 1_000_000],
    ['deepseek-chat', 64_000],
    ['gpt-5.4', 1_000_000],
    ['gpt-5.6-luna', 1_000_000],
    ['gpt-6-luna', 922_000],
    ['gpt-6-sol', 922_000],
    ['gpt-6-astra', 922_000],
    ['openai/gpt-6-luna', 922_000],
    ['gpt-60-mini', DEFAULT_CONTEXT_WINDOW],
    ['gpt-4o-mini', 128_000],
    ['qwen3.6-plus-free', 262_144],
    ['kimi-k2.6', 262_144],
    ['minimax-m2.7', 204_800],
    ['mistral-large', 262_144],
    ['llama-3.3-70b', 131_072],
    ['grok-4.20-0309-reasoning', 1_000_000],
    ['grok-4.5', 500_000],
    ['grok-4.5-latest', 500_000],
    ['grok-4', 131_072],
    ['grok-3-mini', 131_072],
    ['solar-mini', 32_768],
    ['totally-unknown-model-xyz', DEFAULT_CONTEXT_WINDOW],
  ])('%s → %i', (id, expected) => {
    expect(contextWindowFromHeuristics(id)).toBe(expected);
  });
});

describe('buildContextWindowIndex', () => {
  it('prefers opencode provider entries over other providers', () => {
    const index = buildContextWindowIndex({
      'github-copilot': { models: { 'claude-sonnet-4-6': { limit: { context: 200_000 } } } },
      opencode: { models: { 'claude-sonnet-4-6': { limit: { context: 1_000_000 } } } },
    });
    expect(index.get('claude-sonnet-4-6')).toBe(1_000_000);
  });

  it('keeps the opencode entry even when another provider lists a larger window', () => {
    const index = buildContextWindowIndex({
      opencode: { models: { 'glm-5.1': { limit: { context: 204_800 } } } },
      crof: { models: { 'glm-5.1': { limit: { context: 1_000_000 } } } },
    });
    expect(index.get('glm-5.1')).toBe(204_800);
  });

  it('uses max across providers when opencode keys are absent', () => {
    const index = buildContextWindowIndex({
      frogbot: { models: { 'gemini-2.5-flash': { limit: { context: 200_000 } } } },
      google: { models: { 'gemini-2.5-flash': { limit: { context: 1_048_576 } } } },
    });
    expect(index.get('gemini-2.5-flash')).toBe(1_048_576);
  });

  // OpenAI caps INPUT at 922,000 on a 1,050,000 window. Claude Code compacts about
  // 33,000 below what it is told, so reporting the total let a session grow past the
  // input cap and die with context_length_exceeded before it ever compacted.
  it("lowers the cross-provider window to OpenAI's own input cap", () => {
    const index = buildContextWindowIndex({
      llmgateway: { models: { 'gpt-6-luna': { limit: { context: 1_050_000, output: 1_050_000 } } } },
      openai: { models: { 'gpt-6-luna': { limit: { context: 1_050_000, input: 922_000 } } } },
    });
    expect(index.get('gpt-6-luna')).toBe(922_000);
  });

  // Shape taken from the real cache: OpenCode lists gpt-5.3-codex-spark at a flat
  // 128,000 while OpenAI caps its input at 100,000.
  it("lowers a priority opencode entry to OpenAI's own input cap", () => {
    const index = buildContextWindowIndex({
      opencode: { models: { 'gpt-5.3-codex-spark': { limit: { context: 128_000, input: 128_000 } } } },
      openai: { models: { 'gpt-5.3-codex-spark': { limit: { context: 128_000, input: 100_000 } } } },
    });
    expect(index.get('gpt-5.3-codex-spark')).toBe(100_000);
  });

  it("never raises a smaller window to OpenAI's input cap", () => {
    const index = buildContextWindowIndex({
      opencode: { models: { 'some-gpt': { limit: { context: 200_000 } } } },
      openai: { models: { 'some-gpt': { limit: { context: 1_050_000, input: 922_000 } } } },
    });
    expect(index.get('some-gpt')).toBe(200_000);
  });

  it("leaves a window larger than OpenAI's own listed total alone", () => {
    const index = buildContextWindowIndex({
      opencode: { models: { 'zen-model': { limit: { context: 1_000_000 } } } },
      openai: { models: { 'zen-model': { limit: { context: 128_000, input: 100_000 } } } },
    });
    expect(index.get('zen-model')).toBe(1_000_000);
  });

  it('ignores an OpenAI input that is not below its total', () => {
    const index = buildContextWindowIndex({
      openai: {
        models: {
          'flat-model': { limit: { context: 128_000, input: 128_000 } },
          'odd-model': { limit: { context: 128_000, input: 400_000 } },
        },
      },
      reseller: {
        models: {
          'flat-model': { limit: { context: 1_000_000 } },
          'odd-model': { limit: { context: 1_000_000 } },
        },
      },
    });
    expect(index.get('flat-model')).toBe(1_000_000);
    expect(index.get('odd-model')).toBe(1_000_000);
  });

  // Many entries derive `input` as total minus output rather than stating an
  // enforced limit, so nobody but OpenAI's own entry may lower a window with it.
  it('ignores input limits from every provider but openai', () => {
    const index = buildContextWindowIndex({
      opencode: { models: { 'gpt-5.5': { limit: { context: 1_050_000, input: 922_000 } } } },
      'opencode-go': { models: { hy3: { limit: { context: 256_000, input: 192_000 } } } },
      vercel: { models: { 'openai/o3-pro': { limit: { context: 200_000, input: 100_000 } } } },
      openrouter: { models: { 'openai/o3-pro': { limit: { context: 200_000 } } } },
    });
    expect(index.get('gpt-5.5')).toBe(1_050_000);
    expect(index.get('hy3')).toBe(256_000);
    expect(index.get('openai/o3-pro')).toBe(200_000);
  });

  it('ignores entries without limit.context', () => {
    const index = buildContextWindowIndex({
      opencode: { models: { 'no-limit-model': { limit: {} } } },
    });
    expect(index.has('no-limit-model')).toBe(false);
  });
});

describe('resolveContextWindow', () => {
  it('falls back to heuristics for unknown models not in cache', () => {
    expect(resolveContextWindow('zzzz-nonexistent-model-id-99999')).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('uses cache index values when present in fixture', () => {
    const index = buildContextWindowIndex({
      opencode: { models: { 'gemini-3.5-flash': { limit: { context: 1_048_576 } } } },
    });
    expect(index.get('gemini-3.5-flash')).toBe(1_048_576);
  });
});

describe('lookupKnownContextWindow', () => {
  it('reports the curated window for a model in the cache (tier 1)', () => {
    expect(lookupKnownContextWindow('qwen-fixture-7b')).toBe(40_960);
  });

  it('prefers curated data over the heuristic rule that also claims the id', () => {
    // `qwen` maps to 131,072; the cache entry must win, or tier 1 has been skipped.
    expect(contextWindowFromHeuristics('qwen-fixture-7b')).toBe(131_072);
    expect(lookupKnownContextWindow('qwen-fixture-7b')).toBe(40_960);
  });

  it('reports 922,000 for a gpt-6 id the cache does not list', () => {
    expect(lookupKnownContextWindow('gpt-6-luna')).toBe(922_000);
  });

  it('reports the heuristic window for a model a rule claims (tier 2)', () => {
    expect(lookupKnownContextWindow('grok-4.5')).toBe(500_000);
    expect(lookupKnownContextWindow('deepseek-chat')).toBe(64_000);
  });

  // The whole point of the sibling: a miss is reported as a miss, so a caller that
  // persists the answer, or uses it as a ceiling, never bakes in a clodex invention.
  it('reports nothing for a model neither tier claims (tier 3)', () => {
    expect(lookupKnownContextWindow('totally-unknown-model-xyz')).toBeUndefined();
  });

  it('answers a repeated miss the same way, so the memo cannot turn it into 200k', () => {
    expect(lookupKnownContextWindow('repeat-miss-model-abc')).toBeUndefined();
    expect(lookupKnownContextWindow('repeat-miss-model-abc')).toBeUndefined();
  });

  it('leaves lookupContextWindow answering exactly as it did', () => {
    expect(lookupContextWindow('totally-unknown-model-xyz')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(lookupContextWindow('grok-4.5')).toBe(500_000);
    expect(lookupContextWindow('qwen-fixture-7b')).toBe(40_960);
    expect(resolveContextWindow('totally-unknown-model-xyz')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextWindow('totally-unknown-model-xyz', 1_048_576)).toBe(1_048_576);
  });
});
