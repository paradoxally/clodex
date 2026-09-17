import { createHash } from 'node:crypto';
import { OPENCODE_GO_COMPLETIONS_BASE_URL } from './data/opencode-go-models.js';

export const OPENCODE_GO_USAGE_URL = `${OPENCODE_GO_COMPLETIONS_BASE_URL}/usage`;

const USAGE_CACHE_TTL_MS = 60_000;
const USAGE_FETCH_TIMEOUT_MS = 5_000;
const USAGE_FAILURE_BACKOFF_MS = 30_000;
const WARNING_THRESHOLD = 0.75;
const ALLOWED_HEADERS = {
  'anthropic-ratelimit-unified-status': 'allowed',
};

type UsageStatus = 'ok' | 'rate-limited';

interface UsageWindow {
  status: UsageStatus;
  percent: number;
  reset: string;
}

interface UsageCacheEntry {
  fetchedAtMs: number;
  headers: Record<string, string>;
  failed: boolean;
}

const usageCache = new Map<string, UsageCacheEntry>();
const usageRefreshes = new Map<string, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseWindow(value: unknown): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.status;
  const percent = value.percent;
  const resetsAt = value.resetsAt;
  if (status !== 'ok' && status !== 'rate-limited') return undefined;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined;
  if (typeof resetsAt !== 'string') return undefined;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return undefined;
  return {
    status,
    percent: Math.max(0, Math.min(100, percent)),
    reset: String(Math.floor(resetMs / 1000)),
  };
}

function parseUsage(payload: unknown): {
  rolling?: UsageWindow;
  weekly?: UsageWindow;
  monthly?: UsageWindow;
} {
  if (!isRecord(payload) || !isRecord(payload.usage)) return {};
  return {
    rolling: parseWindow(payload.usage.rolling),
    weekly: parseWindow(payload.usage.weekly),
    monthly: parseWindow(payload.usage.monthly),
  };
}

/**
 * Go's own refusal is a real HTTP 429 ("5-hour usage limit reached. Resets in
 * Nmin") paired with `{status:"rate-limited", percent:100}` on the affected
 * window, so the window is surfaced as a full-strength warning instead of a
 * synthesized rejection: Claude Code's rejection state would replace the
 * provider's message and offer Claude-only recovery actions.
 */
function warningThreshold(window: UsageWindow | undefined): string | undefined {
  if (!window) return undefined;
  if (window.status === 'rate-limited') {
    return String(Math.max(window.percent / 100, WARNING_THRESHOLD));
  }
  return window.percent / 100 >= WARNING_THRESHOLD ? String(WARNING_THRESHOLD) : undefined;
}

function addWindowHeaders(
  headers: Record<string, string>,
  window: UsageWindow | undefined,
  prefix: '5h' | '7d',
): boolean {
  if (!window) return false;
  headers[`anthropic-ratelimit-unified-${prefix}-utilization`] = String(window.percent / 100);
  headers[`anthropic-ratelimit-unified-${prefix}-reset`] = window.reset;
  const threshold = warningThreshold(window);
  if (threshold) headers[`anthropic-ratelimit-unified-${prefix}-surpassed-threshold`] = threshold;
  return threshold !== undefined;
}

export function buildOpenCodeGoLimitHeaders(payload: unknown): Record<string, string> {
  const { rolling, weekly, monthly } = parseUsage(payload);
  const headers: Record<string, string> = { ...ALLOWED_HEADERS };
  const rollingWarning = addWindowHeaders(headers, rolling, '5h');
  const weeklyWarning = addWindowHeaders(headers, weekly, '7d');
  const monthlyWarning = warningThreshold(monthly) !== undefined;

  if (monthly && monthlyWarning && !rollingWarning && !weeklyWarning) {
    headers['anthropic-ratelimit-unified-representative-claim'] = 'overage';
    headers['anthropic-ratelimit-unified-overage-status'] = 'allowed_warning';
    headers['anthropic-ratelimit-unified-overage-utilization'] = String(monthly.percent / 100);
    headers['anthropic-ratelimit-unified-overage-reset'] = monthly.reset;
    headers['anthropic-ratelimit-unified-overage-surpassed-threshold'] = warningThreshold(monthly)!;
  }

  // Claude Code 2.1.273 normalizes allowed_warning to allowed; the per-window
  // surpassed-threshold headers carry the warning signal. Keep the status for
  // clients that preserve the distinction.
  if (rollingWarning || weeklyWarning || (monthly && monthlyWarning && !rollingWarning && !weeklyWarning)) {
    headers['anthropic-ratelimit-unified-status'] = 'allowed_warning';
  }
  return headers;
}

function cacheKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

function testOverride(): Record<string, string> | undefined {
  const raw = process.env.CLODEX_TEST_OPENCODE_GO_USAGE;
  if (!raw) return undefined;
  try {
    return buildOpenCodeGoLimitHeaders(JSON.parse(raw));
  } catch {
    return { ...ALLOWED_HEADERS };
  }
}

export function getOpenCodeGoLimitHeaders(
  apiKey: string,
  log?: (message: string) => void,
): Record<string, string> {
  const override = testOverride();
  if (override) return override;
  if (!apiKey.trim()) return { ...ALLOWED_HEADERS };

  const key = cacheKey(apiKey);
  const entry = usageCache.get(key);
  const ttl = entry?.failed ? USAGE_FAILURE_BACKOFF_MS : USAGE_CACHE_TTL_MS;
  if (!entry || Date.now() - entry.fetchedAtMs >= ttl) {
    void refreshOpenCodeGoUsage(apiKey, log);
  }
  return entry?.headers ?? { ...ALLOWED_HEADERS };
}

export async function refreshOpenCodeGoUsage(
  apiKey: string,
  log?: (message: string) => void,
): Promise<void> {
  if (!apiKey.trim() || testOverride()) return;
  const key = cacheKey(apiKey);
  const pending = usageRefreshes.get(key);
  if (pending) return pending;
  const existing = usageCache.get(key);
  if (existing?.failed && Date.now() - existing.fetchedAtMs < USAGE_FAILURE_BACKOFF_MS) return;

  const refresh = (async () => {
    try {
      const response = await fetch(OPENCODE_GO_USAGE_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        // An unconsumed body holds its socket open in the undici pool, so a
        // failing usage endpoint would leak a connection per refresh.
        try {
          await response.body?.cancel();
        } catch { /* the failure is already recorded */ }
        recordUsageFailure(key, existing, `HTTP ${response.status}`, log);
        return;
      }
      const headers = buildOpenCodeGoLimitHeaders(await response.json());
      usageCache.set(key, { fetchedAtMs: Date.now(), headers, failed: false });
      if (existing?.failed) log?.('OpenCode Go usage refresh recovered');
    } catch (error) {
      recordUsageFailure(
        key,
        existing,
        error instanceof Error ? error.name : 'unknown error',
        log,
      );
    } finally {
      usageRefreshes.delete(key);
    }
  })();
  usageRefreshes.set(key, refresh);
  return refresh;
}


function recordUsageFailure(
  key: string,
  existing: UsageCacheEntry | undefined,
  reason: string,
  log?: (message: string) => void,
): void {
  usageCache.set(key, {
    fetchedAtMs: Date.now(),
    headers: existing?.headers ?? { ...ALLOWED_HEADERS },
    failed: true,
  });
  if (!existing?.failed) log?.(`OpenCode Go usage refresh failed (${reason})`);
}

export function resetOpenCodeGoUsageCacheForTests(): void {
  usageCache.clear();
  usageRefreshes.clear();
}
