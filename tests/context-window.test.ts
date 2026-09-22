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
  it('reports the input limit, not the total, when an entry declares one', () => {
    const index = buildContextWindowIndex({
      opencode: {
        models: { 'gpt-5.5': { limit: { context: 1_050_000, input: 922_000, output: 128_000 } } },
      },
    });
    expect(index.get('gpt-5.5')).toBe(922_000);
  });

  it('keeps the total when an entry declares no input limit', () => {
    const index = buildContextWindowIndex({
      opencode: { models: { 'kimi-k2.6': { limit: { context: 262_144, output: 32_768 } } } },
    });
    expect(index.get('kimi-k2.6')).toBe(262_144);
  });

  // nano-gpt restates its own smaller total as `input`. That is its offer, not a cap
  // on the model, and must not shrink the 1,000,000 every other provider lists.
  it('does not let a smaller reseller restating its total as input shrink the window', () => {
    const index = buildContextWindowIndex({
      'nano-gpt': { models: { 'qwen/qwen3-coder-plus': { limit: { context: 128_000, input: 128_000 } } } },
      openrouter: { models: { 'qwen/qwen3-coder-plus': { limit: { context: 1_000_000 } } } },
    });
    expect(index.get('qwen/qwen3-coder-plus')).toBe(1_000_000);
  });

  it('does not let a smaller provider split shrink a larger total', () => {
    const index = buildContextWindowIndex({
      small: { models: { 'some-model': { limit: { context: 200_000, input: 160_000 } } } },
      smaller: { models: { 'some-model': { limit: { context: 128_000, input: 96_000 } } } },
      vendor: { models: { 'some-model': { limit: { context: 1_000_000 } } } },
    });
    expect(index.get('some-model')).toBe(1_000_000);
  });

  // Shape taken from the real cache: seven providers list openai/o3-pro at 200,000
  // with no input limit; one derives input as total minus output. One provider is
  // not evidence of a cap.
  it('ignores an input limit only a minority of same-total providers declare', () => {
    const index = buildContextWindowIndex({
      vercel: { models: { 'openai/o3-pro': { limit: { context: 200_000, input: 100_000 } } } },
      openrouter: { models: { 'openai/o3-pro': { limit: { context: 200_000 } } } },
      kilo: { models: { 'openai/o3-pro': { limit: { context: 200_000 } } } },
    });
    expect(index.get('openai/o3-pro')).toBe(200_000);
  });

  it('leaves the total when same-total resellers split evenly on a cap', () => {
    const index = buildContextWindowIndex({
      a: { models: { 'tie-model': { limit: { context: 400_000, input: 272_000 } } } },
      b: { models: { 'tie-model': { limit: { context: 400_000 } } } },
    });
    expect(index.get('tie-model')).toBe(400_000);
  });

  // Shape taken from the real cache: gpt-5-pro splits 3-3 between providers stating
  // 272,000 and providers stating none. OpenAI's own entry is one of the three, and
  // OpenAI enforces the cap it states, so it must not be outvoted.
  it("honours OpenAI's own input cap even when resellers outnumber it", () => {
    const index = buildContextWindowIndex({
      openai: { models: { 'gpt-5-pro': { limit: { context: 400_000, input: 272_000 } } } },
      azure: { models: { 'gpt-5-pro': { limit: { context: 400_000 } } } },
      jiekou: { models: { 'gpt-5-pro': { limit: { context: 400_000 } } } },
    });
    expect(index.get('gpt-5-pro')).toBe(272_000);
  });

  // Shape taken from the real cache: OpenCode's own entry for gpt-5.3-codex-spark
  // states no cap, while OpenAI caps input at 100,000 on the same 128,000 total.
  it("applies OpenAI's own cap to a priority entry that states none", () => {
    const index = buildContextWindowIndex({
      opencode: { models: { 'gpt-5.3-codex-spark': { limit: { context: 128_000, input: 128_000 } } } },
      openai: { models: { 'gpt-5.3-codex-spark': { limit: { context: 128_000, input: 100_000 } } } },
    });
    expect(index.get('gpt-5.3-codex-spark')).toBe(100_000);
  });

  it("does not let OpenAI's cap at another total override a priority entry", () => {
    const index = buildContextWindowIndex({
      opencode: { models: { 'zen-model': { limit: { context: 1_000_000 } } } },
      openai: { models: { 'zen-model': { limit: { context: 400_000, input: 272_000 } } } },
    });
    expect(index.get('zen-model')).toBe(1_000_000);
  });

  // Shape taken from the real cache: requesty alone lists gpt-5.5@eu, passing
  // OpenAI's real 922,000 cap through. With no other provider to disagree, it holds.
  it("keeps a lone provider's input cap", () => {
    const index = buildContextWindowIndex({
      requesty: { models: { 'gpt-5.5@eu': { limit: { context: 1_050_000, input: 922_000 } } } },
    });
    expect(index.get('gpt-5.5@eu')).toBe(922_000);
  });

  it("does not let OpenAI's cap at a smaller total shrink a larger one", () => {
    const index = buildContextWindowIndex({
      openai: { models: { 'bigger-elsewhere': { limit: { context: 128_000, input: 100_000 } } } },
      vendor: { models: { 'bigger-elsewhere': { limit: { context: 1_000_000 } } } },
    });
    expect(index.get('bigger-elsewhere')).toBe(1_000_000);
  });

  it('takes the most generous cap when same-total providers disagree on it', () => {
    const index = buildContextWindowIndex({
      a: { models: { 'split-model': { limit: { context: 1_000_000, input: 800_000 } } } },
      b: { models: { 'split-model': { limit: { context: 1_000_000, input: 900_000 } } } },
    });
    expect(index.get('split-model')).toBe(900_000);
  });

  it('never reports an input limit larger than the total', () => {
    const index = buildContextWindowIndex({
      opencode: { models: { 'odd-model': { limit: { context: 128_000, input: 400_000 } } } },
    });
    expect(index.get('odd-model')).toBe(128_000);
  });

  it('uses the input limit from a prioritised opencode-go entry too', () => {
    const index = buildContextWindowIndex({
      'opencode-go': { models: { hy3: { limit: { context: 256_000, input: 192_000 } } } },
    });
    expect(index.get('hy3')).toBe(192_000);
  });

  // Shape taken from the real cache: every provider that lists gpt-6-astra declares
  // input 922,000 except one that states only the 1,050,000 total. Taking the plain
  // max would let that one entry restore the window that kills the session.
  it('lets declared input limits outrank a total-only entry across providers', () => {
    const index = buildContextWindowIndex({
      llmgateway: { models: { 'gpt-6-luna': { limit: { context: 1_050_000, output: 1_050_000 } } } },
      vivgrid: { models: { 'gpt-6-luna': { limit: { context: 1_050_000, input: 922_000 } } } },
      azure: { models: { 'gpt-6-luna': { limit: { context: 1_050_000, input: 922_000 } } } },
      requesty: { models: { 'gpt-6-luna': { limit: { context: 1_050_000, input: 922_000 } } } },
    });
    expect(index.get('gpt-6-luna')).toBe(922_000);
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
