import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  anthropicBodyForUpstream,
  isAnthropicFirstPartyUpstream,
  stripToolAdditions,
} from '../src/third-party-anthropic-body.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { translateRequest } from '../src/sdk-adapter.js';

const DOCS_BATCH = 'mcp__docs__batch';
const DOCS_UPDATE = 'mcp__docs__update';
const DOCS_GUIDE = 'mcp__docs__guide';
const schema = { type: 'object', properties: {} };
const hourCache = { type: 'ephemeral', ttl: '1h' };

/** The shape Claude Code 2.1.273 sends once deferred MCP tools connect mid-conversation. */
function lateToolAdditionBody(): Record<string, any> {
  return {
    model: 'deepseek-v4.1-flash',
    max_tokens: 64,
    stream: false,
    tools: [
      { name: 'Bash', input_schema: schema },
      { name: 'ToolSearch', input_schema: schema },
      { name: DOCS_BATCH, input_schema: schema, defer_loading: true },
      { name: DOCS_UPDATE, input_schema: schema, defer_loading: true },
      { name: DOCS_GUIDE, input_schema: schema, defer_loading: true },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Docs server connected.' },
          { type: 'tool_addition', tool: { type: 'tool_reference', name: DOCS_BATCH } },
          {
            type: 'tool_addition',
            tool: { type: 'tool_reference', name: DOCS_UPDATE },
            cache_control: hourCache,
          },
        ],
      },
    ],
  };
}

/** The shape Claude Code's ToolSearch tool returns when it finds deferred tools. */
function toolSearchResultBody(): Record<string, any> {
  return {
    model: 'deepseek-v4.1-flash',
    max_tokens: 64,
    tools: [
      { name: 'ToolSearch', input_schema: schema },
      { name: DOCS_BATCH, input_schema: schema, defer_loading: true },
      { name: DOCS_GUIDE, input_schema: schema, defer_loading: true },
    ],
    messages: [
      { role: 'user', content: 'find the docs tool' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'ToolSearch', input: { query: 'docs' } }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'tool_reference', tool_name: DOCS_BATCH }],
        }],
      },
    ],
  };
}

function wireText(body: unknown): string {
  return JSON.stringify(body);
}

describe('stripToolAdditions', () => {
  it('removes tool_addition blocks and keeps the message text with its cache breakpoint', () => {
    const out = stripToolAdditions(lateToolAdditionBody());

    expect(out.messages[1]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'Docs server connected.', cache_control: hourCache }],
    });
    expect(wireText(out)).not.toContain('tool_addition');
  });

  it('drops a system message that held nothing but tool_addition blocks', () => {
    const body = lateToolAdditionBody();
    body.messages[1].content = body.messages[1].content.slice(1);

    const out = stripToolAdditions(body);

    expect(out.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('sends only the tools a tool_addition announced as no longer deferred', () => {
    const body = lateToolAdditionBody();
    body.messages.push(toolSearchResultBody().messages[2]);

    expect(stripToolAdditions(body).tools).toEqual([
      { name: 'Bash', input_schema: schema },
      { name: 'ToolSearch', input_schema: schema },
      { name: DOCS_BATCH, input_schema: schema },
      { name: DOCS_UPDATE, input_schema: schema },
      { name: DOCS_GUIDE, input_schema: schema, defer_loading: true },
    ]);
  });

  it('leaves ToolSearch tool_reference results, which OpenCode Go accepts, as they are', () => {
    const body = toolSearchResultBody();
    expect(stripToolAdditions(body)).toBe(body);

    const mixed = lateToolAdditionBody();
    const searchResult = toolSearchResultBody().messages[2];
    mixed.messages.push(searchResult);
    expect(stripToolAdditions(mixed).messages[2]).toBe(searchResult);
  });

  it('never overwrites a cache breakpoint the preceding block already carries', () => {
    const body = lateToolAdditionBody();
    const ownCache = { type: 'ephemeral' };
    body.messages[1].content[0].cache_control = ownCache;

    const out = stripToolAdditions(body);

    expect(out.messages[1].content).toEqual([
      { type: 'text', text: 'Docs server connected.', cache_control: ownCache },
    ]);
  });

  it('returns the very same body when it carries no tool_addition block', () => {
    const body = lateToolAdditionBody();
    body.messages = [
      { role: 'user', content: 'plain string content' },
      { role: 'system', content: [{ type: 'text', text: 'a text-only system message' }] },
    ];

    expect(stripToolAdditions(body)).toBe(body);
  });

  it('leaves the request it was given untouched', () => {
    const body = lateToolAdditionBody();
    const before = structuredClone(body);

    stripToolAdditions(body);

    expect(body).toEqual(before);
  });
});

describe('anthropicBodyForUpstream', () => {
  it('leaves requests to Anthropic itself byte-for-byte alone', () => {
    const body = lateToolAdditionBody();
    expect(isAnthropicFirstPartyUpstream({ baseUrl: 'https://api.anthropic.com' })).toBe(true);
    expect(anthropicBodyForUpstream(body, { providerId: 'anthropic', baseUrl: 'https://api.anthropic.com' })).toBe(body);
    expect(anthropicBodyForUpstream(body, { providerId: 'claude-code', baseUrl: 'https://gateway.example' })).toBe(body);
  });

  it('cleans requests bound for any other Anthropic-format upstream', () => {
    const body = lateToolAdditionBody();
    expect(isAnthropicFirstPartyUpstream({ baseUrl: 'https://opencode.ai/zen/go' })).toBe(false);
    expect(isAnthropicFirstPartyUpstream({ baseUrl: 'https://api.anthropic.com.evil.example' })).toBe(false);
    expect(wireText(anthropicBodyForUpstream(body, { providerId: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go' })))
      .not.toContain('tool_addition');
    expect(wireText(anthropicBodyForUpstream(body, { providerId: 'custom', baseUrl: 'not a url' })))
      .not.toContain('tool_addition');
  });
});

function postToProxy(port: number, token: string, body: unknown, path = '/v1/messages'): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const upstreamMessage = {
  id: 'msg_upstream',
  type: 'message',
  role: 'assistant',
  model: 'deepseek-v4.1-flash',
  content: [{ type: 'text', text: 'ok' }],
  usage: { input_tokens: 1, output_tokens: 1 },
};

/**
 * Answers every non-loopback fetch with a canned Anthropic reply and records what was sent;
 * loopback calls (the test's own requests to a gateway under test) reach the real network stack.
 */
function captureUpstreamFetch(): Array<{ url: string; body: any }> {
  const sent: Array<{ url: string; body: any }> = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
    sent.push({ url, body: JSON.parse(String(init?.body)) });
    const reply = url.endsWith('/count_tokens') ? { input_tokens: 9 } : upstreamMessage;
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return sent;
}

describe('proxy-mode passthrough', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const goRoute: ProxyRoute = {
    aliasId: 'clodex:opencode-go:deepseek-v4.1-flash',
    realModelId: 'deepseek-v4.1-flash',
    displayName: 'DeepSeek V4.1 Flash',
    upstreamUrl: 'https://opencode.ai/zen/go',
    apiKey: 'go-key',
    modelFormat: 'anthropic',
    providerId: 'opencode-go',
  };

  it('sends OpenCode Go messages and token counts without tool_addition blocks', async () => {
    const sent = captureUpstreamFetch();
    const handle = await startProxyCatalog([goRoute], goRoute.aliasId, false);
    try {
      expect(await postToProxy(handle.port, handle.token, { ...lateToolAdditionBody(), model: goRoute.aliasId })).toBe(200);
      expect(await postToProxy(handle.port, handle.token, { ...toolSearchResultBody(), model: goRoute.aliasId })).toBe(200);
      expect(await postToProxy(
        handle.port,
        handle.token,
        { ...lateToolAdditionBody(), model: goRoute.aliasId },
        '/v1/messages/count_tokens',
      )).toBe(200);

      expect(sent.map(call => call.url)).toEqual([
        'https://opencode.ai/zen/go/v1/messages',
        'https://opencode.ai/zen/go/v1/messages',
        'https://opencode.ai/zen/go/v1/messages/count_tokens',
      ]);
      for (const call of sent) {
        expect(call.body.model).toBe('deepseek-v4.1-flash');
        expect(wireText(call.body)).not.toContain('tool_addition');
      }
      expect(sent[0]!.body.messages[1].content).toEqual([
        { type: 'text', text: 'Docs server connected.', cache_control: hourCache },
      ]);
      expect(sent[1]!.body).toEqual({ ...toolSearchResultBody(), model: 'deepseek-v4.1-flash' });
    } finally {
      handle.close();
    }
  });

  it('forwards the same blocks untouched to api.anthropic.com', async () => {
    const sent = captureUpstreamFetch();
    const route: ProxyRoute = {
      ...goRoute,
      aliasId: 'clodex:anthropic:sonnet',
      realModelId: 'claude-sonnet-4-6',
      upstreamUrl: 'https://api.anthropic.com',
      providerId: 'anthropic',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const body = { ...lateToolAdditionBody(), model: route.aliasId };
      expect(await postToProxy(handle.port, handle.token, body)).toBe(200);

      expect(sent).toHaveLength(1);
      expect(sent[0]!.body).toEqual({ ...body, model: 'claude-sonnet-4-6' });
    } finally {
      handle.close();
    }
  });
});

describe('API server /anthropic/v1/messages passthrough', () => {
  const handles: ServerHandle[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(handles.splice(0).map(handle => handle.close()));
  });

  async function startGateway(providerId: string, baseUrl: string): Promise<ServerHandle> {
    const handle = await startServer({
      host: '127.0.0.1',
      port: 0,
      apiKey: 'server-key',
      serverPassword: null,
      catalog: createGatewayModelCatalog([{
        id: 'passthrough-model',
        name: 'Passthrough Model',
        isFree: false,
        brand: 'Other',
        providerId,
        sourceBackend: 'go',
        modelFormat: 'anthropic',
        upstreamModelId: 'deepseek-v4.1-flash',
        baseUrl,
        apiKey: 'model-key',
      }]),
    });
    handles.push(handle);
    return handle;
  }

  async function post(handle: ServerHandle, path: string, body: Record<string, unknown>): Promise<number> {
    const response = await fetch(`${handle.url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, model: 'passthrough-model' }),
    });
    await response.text();
    return response.status;
  }

  it('sends OpenCode Go messages and token counts without tool_addition blocks', async () => {
    const sent = captureUpstreamFetch();
    const handle = await startGateway('opencode-go', 'https://opencode.ai/zen/go');

    expect(await post(handle, '/anthropic/v1/messages', lateToolAdditionBody())).toBe(200);
    expect(await post(handle, '/anthropic/v1/messages', toolSearchResultBody())).toBe(200);
    expect(await post(handle, '/anthropic/v1/messages/count_tokens', lateToolAdditionBody())).toBe(200);

    expect(sent.map(call => call.url)).toEqual([
      'https://opencode.ai/zen/go/v1/messages',
      'https://opencode.ai/zen/go/v1/messages',
      'https://opencode.ai/zen/go/v1/messages/count_tokens',
    ]);
    for (const call of sent) {
      expect(wireText(call.body)).not.toContain('tool_addition');
    }
    expect(sent[0]!.body.tools).toContainEqual({ name: DOCS_BATCH, input_schema: schema });
    expect(sent[1]!.body).toEqual({ ...toolSearchResultBody(), model: 'deepseek-v4.1-flash' });
  });

  it('forwards the same blocks untouched to api.anthropic.com', async () => {
    const sent = captureUpstreamFetch();
    const handle = await startGateway('anthropic', 'https://api.anthropic.com');
    const body = lateToolAdditionBody();

    expect(await post(handle, '/anthropic/v1/messages', body)).toBe(200);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ ...body, model: 'deepseek-v4.1-flash' });
  });
});

describe('translated (SDK) routes', () => {
  it('forwards late-announced tools and keeps tool_addition blocks out of the prompt', () => {
    const params = translateRequest(lateToolAdditionBody() as any, '@ai-sdk/openai');

    expect(Object.keys(params.tools ?? {})).toEqual(['Bash', 'ToolSearch', DOCS_BATCH, DOCS_UPDATE]);
    expect(params.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'system', content: 'Docs server connected.' },
    ]);
    expect(wireText(params.messages)).not.toContain('tool_addition');
  });
});
