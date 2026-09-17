import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpenCodeGoLimitHeaders,
  getOpenCodeGoLimitHeaders,
  refreshOpenCodeGoUsage,
  resetOpenCodeGoUsageCacheForTests,
} from '../src/opencode-go-usage.js';

const rollingReset = '2026-09-17T04:00:00.000Z';
const weeklyReset = '2026-09-21T00:00:00.000Z';
const monthlyReset = '2026-10-16T19:42:49.000Z';

function usage(overrides: Record<string, unknown> = {}) {
  return {
    usage: {
      rolling: { status: 'ok', percent: 94, resetsAt: rollingReset },
      weekly: { status: 'ok', percent: 62, resetsAt: weeklyReset },
      monthly: { status: 'ok', percent: 18, resetsAt: monthlyReset },
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.CLODEX_TEST_OPENCODE_GO_USAGE;
  resetOpenCodeGoUsageCacheForTests();
});

describe('buildOpenCodeGoLimitHeaders', () => {
  it('maps Go windows to Claude five-hour and seven-day headers', () => {
    expect(buildOpenCodeGoLimitHeaders(usage())).toEqual({
      'anthropic-ratelimit-unified-status': 'allowed_warning',
      'anthropic-ratelimit-unified-5h-utilization': '0.94',
      'anthropic-ratelimit-unified-5h-reset': '1789617600',
      'anthropic-ratelimit-unified-5h-surpassed-threshold': '0.75',
      'anthropic-ratelimit-unified-7d-utilization': '0.62',
      'anthropic-ratelimit-unified-7d-reset': '1789948800',
    });
  });

  it('uses the generic overage slot only when monthly is the binding warning', () => {
    expect(buildOpenCodeGoLimitHeaders(usage({
      usage: {
        rolling: { status: 'ok', percent: 12, resetsAt: rollingReset },
        weekly: { status: 'ok', percent: 20, resetsAt: weeklyReset },
        monthly: { status: 'ok', percent: 94, resetsAt: monthlyReset },
      },
    }))).toEqual({
      'anthropic-ratelimit-unified-status': 'allowed_warning',
      'anthropic-ratelimit-unified-5h-utilization': '0.12',
      'anthropic-ratelimit-unified-5h-reset': '1789617600',
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
      'anthropic-ratelimit-unified-7d-reset': '1789948800',
      'anthropic-ratelimit-unified-representative-claim': 'overage',
      'anthropic-ratelimit-unified-overage-status': 'allowed_warning',
      'anthropic-ratelimit-unified-overage-utilization': '0.94',
      'anthropic-ratelimit-unified-overage-reset': '1792179769',
      'anthropic-ratelimit-unified-overage-surpassed-threshold': '0.75',
    });
  });

  it('emits the weekly warning signal when weekly is the only warning window', () => {
    const headers = buildOpenCodeGoLimitHeaders(usage({
      usage: {
        rolling: { status: 'ok', percent: 12, resetsAt: rollingReset },
        weekly: { status: 'ok', percent: 94, resetsAt: weeklyReset },
        monthly: { status: 'ok', percent: 18, resetsAt: monthlyReset },
      },
    }));

    expect(headers['anthropic-ratelimit-unified-7d-utilization']).toBe('0.94');
    expect(headers['anthropic-ratelimit-unified-7d-surpassed-threshold']).toBe('0.75');
  });

  it('clamps an over-limit percentage instead of dropping its window', () => {
    const headers = buildOpenCodeGoLimitHeaders(usage({
      usage: {
        rolling: { status: 'ok', percent: 105, resetsAt: rollingReset },
        weekly: { status: 'ok', percent: 20, resetsAt: weeklyReset },
        monthly: { status: 'ok', percent: 18, resetsAt: monthlyReset },
      },
    }));

    expect(headers['anthropic-ratelimit-unified-5h-utilization']).toBe('1');
    expect(headers['anthropic-ratelimit-unified-5h-surpassed-threshold']).toBe('0.75');
  });

  it('does not mislabel monthly usage as weekly when another window is warning', () => {
    const headers = buildOpenCodeGoLimitHeaders(usage({
      usage: {
        rolling: { status: 'ok', percent: 82, resetsAt: rollingReset },
        weekly: { status: 'ok', percent: 20, resetsAt: weeklyReset },
        monthly: { status: 'ok', percent: 94, resetsAt: monthlyReset },
      },
    }));

    expect(headers['anthropic-ratelimit-unified-7d-utilization']).toBe('0.2');
    expect(headers['anthropic-ratelimit-unified-overage-utilization']).toBeUndefined();
  });

  it('keeps a rate-limited Go response warning without sending rejected', () => {
    const headers = buildOpenCodeGoLimitHeaders(usage({
      usage: {
        rolling: { status: 'rate-limited', percent: 100, resetsAt: rollingReset },
        weekly: { status: 'ok', percent: 62, resetsAt: weeklyReset },
        monthly: { status: 'ok', percent: 18, resetsAt: monthlyReset },
      },
    }));

    expect(headers['anthropic-ratelimit-unified-status']).toBe('allowed_warning');
    expect(headers['anthropic-ratelimit-unified-5h-utilization']).toBe('1');
    expect(headers['anthropic-ratelimit-unified-5h-surpassed-threshold']).toBe('1');
    expect(headers['anthropic-ratelimit-unified-status']).not.toBe('rejected');
  });

  it('fails closed to an allowed state for malformed usage data', () => {
    expect(buildOpenCodeGoLimitHeaders({ usage: { rolling: { percent: '94' } } })).toEqual({
      'anthropic-ratelimit-unified-status': 'allowed',
    });
  });
});

describe('OpenCode Go usage refresh', () => {
  it('does not fetch when the test override is active', async () => {
    process.env.CLODEX_TEST_OPENCODE_GO_USAGE = JSON.stringify(usage());
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await refreshOpenCodeGoUsage('go-secret');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches the usage endpoint with bearer authentication and caches headers', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(usage()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await refreshOpenCodeGoUsage('go-secret');
    const headers = getOpenCodeGoLimitHeaders('go-secret');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://opencode.ai/zen/go/v1/usage');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer go-secret');
    expect(headers['anthropic-ratelimit-unified-5h-utilization']).toBe('0.94');
  });

  it('shares one in-flight refresh across concurrent sessions for the same key', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    const first = refreshOpenCodeGoUsage('go-secret');
    const second = refreshOpenCodeGoUsage('go-secret');
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveFetch(new Response(JSON.stringify(usage()), { status: 200 }));
    await Promise.all([first, second]);
    expect(getOpenCodeGoLimitHeaders('go-secret')['anthropic-ratelimit-unified-5h-utilization'])
      .toBe('0.94');
  });

  it('keeps one account\'s limits out of another account\'s responses', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('authorization');
      const percent = key === 'Bearer key-a' ? 94 : 12;
      return new Response(JSON.stringify({
        usage: {
          rolling: { status: 'ok', percent, resetsAt: rollingReset },
          weekly: { status: 'ok', percent: 40, resetsAt: weeklyReset },
          monthly: { status: 'ok', percent: 18, resetsAt: monthlyReset },
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await refreshOpenCodeGoUsage('key-a');
    await refreshOpenCodeGoUsage('key-b');

    expect(getOpenCodeGoLimitHeaders('key-a')['anthropic-ratelimit-unified-5h-utilization']).toBe('0.94');
    expect(getOpenCodeGoLimitHeaders('key-b')['anthropic-ratelimit-unified-5h-utilization']).toBe('0.12');
  });

  it('backs off repeated failed refreshes', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => { throw new Error('usage unavailable'); });
    vi.stubGlobal('fetch', fetchMock);

    await refreshOpenCodeGoUsage('go-secret');
    await refreshOpenCodeGoUsage('go-secret');
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(30_001);
    await refreshOpenCodeGoUsage('go-secret');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('releases the body of a rejected usage response instead of holding its socket', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull() { /* the body is never read by clodex */ },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 429 })));

    await refreshOpenCodeGoUsage('go-secret');

    expect(cancelled).toBe(true);
    expect(getOpenCodeGoLimitHeaders('go-secret')).toEqual({
      'anthropic-ratelimit-unified-status': 'allowed',
    });
  });

  it('keeps response delivery independent from a failed usage refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('usage unavailable'); }));

    await expect(refreshOpenCodeGoUsage('go-secret')).resolves.toBeUndefined();
    expect(getOpenCodeGoLimitHeaders('go-secret')).toEqual({
      'anthropic-ratelimit-unified-status': 'allowed',
    });
  });
});
