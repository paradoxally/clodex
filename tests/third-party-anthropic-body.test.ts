import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  anthropicBodyForUpstream,
  isAnthropicFirstPartyUpstream,
  stripAdvisorTool,
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

/** The server-side tool Claude Code 2.1.278 appends once an advisor model resolves. */
const advisorTool = {
  type: 'advisor_20260301',
  name: 'advisor',
  model: 'claude-opus-5',
  defer_loading: true,
};
const advisorCall = {
  type: 'server_tool_use',
  id: 'srvtoolu_01advisor',
  name: 'advisor',
  input: { prompt: 'review this' },
};
const advisorResult = {
  type: 'advisor_tool_result',
  tool_use_id: 'srvtoolu_01advisor',
  content: { type: 'advisor_result', stop_reason: 'end_turn', text: 'looks fine' },
};

/** A turn Claude Code sent to Anthropic before the session switched to a routed model. */
function advisorBody(): Record<string, any> {
  return {
    model: 'deepseek-v4.1-flash',
    max_tokens: 64,
    stream: false,
    tools: [
      { name: 'Bash', input_schema: schema },
      { name: 'Read', input_schema: schema, cache_control: hourCache },
      advisorTool,
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'review my patch' }] },
      { role: 'assistant', content: [advisorCall, advisorResult, { type: 'text', text: 'ship it' }] },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
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

describe('stripAdvisorTool', () => {
  it('removes the advisor tool declaration and leaves every real tool alone', () => {
    const out = stripAdvisorTool(advisorBody());

    expect(out.tools).toEqual([
      { name: 'Bash', input_schema: schema },
      { name: 'Read', input_schema: schema, cache_control: hourCache },
    ]);
  });

  it('removes the advisor call and result the history carries once the advisor has run', () => {
    const out = stripAdvisorTool(advisorBody());

    expect(out.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'ship it' }],
    });
    expect(wireText(out)).not.toContain('advisor');
  });

  it("leaves another provider's server tool and its result in place", () => {
    const body = advisorBody();
    const webSearch = { type: 'server_tool_use', id: 'srvtoolu_02', name: 'web_search', input: { query: 'x' } };
    const webResult = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_02', content: [] };
    body.tools.splice(2, 0, { type: 'web_search_20250305', name: 'web_search' });
    body.messages[1].content = [webSearch, webResult, advisorCall, advisorResult, { type: 'text', text: 'ship it' }];

    const out = stripAdvisorTool(body);

    expect(out.tools).toContainEqual({ type: 'web_search_20250305', name: 'web_search' });
    expect(out.messages[1].content).toEqual([webSearch, webResult, { type: 'text', text: 'ship it' }]);
  });

  it('matches a later dated version of the tool, not just the one shipped in 2.1.278', () => {
    const body = advisorBody();
    body.tools = [{ name: 'Bash', input_schema: schema }, { ...advisorTool, type: 'advisor_20270101' }];

    expect(stripAdvisorTool(body).tools).toEqual([{ name: 'Bash', input_schema: schema }]);
  });

  it('matches a later dated version of the result block too, so a strip can never go half done', () => {
    const body = advisorBody();
    body.messages[1].content = [
      advisorCall,
      { ...advisorResult, type: 'advisor_tool_result_20270101' },
      { type: 'text', text: 'ship it' },
    ];

    expect(stripAdvisorTool(body).messages[1].content).toEqual([{ type: 'text', text: 'ship it' }]);
  });

  it('never invents a turn for a role Claude Code puts no advisor block on', () => {
    const body = advisorBody();
    body.messages = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [advisorCall, advisorResult] },
      { role: 'user', content: [advisorResult, { type: 'text', text: 'thanks' }] },
    ];

    expect(stripAdvisorTool(body).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
    ]);
  });

  it('substitutes a placeholder for a turn the advisor blocks were carrying on their own', () => {
    const body = advisorBody();
    body.messages[1].content = [
      { type: 'thinking', thinking: 'let me ask', signature: 'sig' },
      advisorCall,
      advisorResult,
    ];

    expect(stripAdvisorTool(body).messages[1].content).toEqual([
      { type: 'thinking', thinking: 'let me ask', signature: 'sig' },
      { type: 'text', text: '[Advisor response]' },
    ]);
  });

  it('never leaves an assistant turn with nothing in it at all', () => {
    const body = advisorBody();
    body.messages[1].content = [advisorCall, advisorResult];

    expect(stripAdvisorTool(body).messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '[Advisor response]' }],
    });
  });

  it('keeps a cache breakpoint the removed blocks were carrying', () => {
    const body = advisorBody();
    body.tools = [{ name: 'Bash', input_schema: schema }, { ...advisorTool, cache_control: hourCache }];
    body.messages[1].content = [{ type: 'text', text: 'ship it' }, { ...advisorResult, cache_control: hourCache }];

    const out = stripAdvisorTool(body);

    expect(out.tools).toEqual([{ name: 'Bash', input_schema: schema, cache_control: hourCache }]);
    expect(out.messages[1].content).toEqual([{ type: 'text', text: 'ship it', cache_control: hourCache }]);
  });

  it('keeps a cache breakpoint that had nothing left in front of it', () => {
    const body = advisorBody();
    body.messages[1].content = [{ ...advisorResult, cache_control: hourCache }];

    expect(stripAdvisorTool(body).messages[1].content).toEqual([
      { type: 'text', text: '[Advisor response]', cache_control: hourCache },
    ]);
  });

  it('returns the very same body when the advisor never appeared', () => {
    const body = lateToolAdditionBody();
    expect(stripAdvisorTool(body)).toBe(body);
  });

  it('leaves the request it was given untouched', () => {
    const body = advisorBody();
    const before = structuredClone(body);

    stripAdvisorTool(body);

    expect(body).toEqual(before);
  });
});

describe('anthropicBodyForUpstream', () => {
  it('leaves requests to Anthropic itself byte-for-byte alone', () => {
    for (const body of [lateToolAdditionBody(), advisorBody()]) {
      expect(isAnthropicFirstPartyUpstream({ baseUrl: 'https://api.anthropic.com' })).toBe(true);
      expect(anthropicBodyForUpstream(body, { providerId: 'anthropic', baseUrl: 'https://api.anthropic.com' })).toBe(body);
      expect(anthropicBodyForUpstream(body, { providerId: 'claude-code', baseUrl: 'https://gateway.example' })).toBe(body);
    }
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

  it('strips the advisor tool and its history blocks on the way to any other upstream', () => {
    const go = { providerId: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go' };

    expect(wireText(anthropicBodyForUpstream(advisorBody(), go))).not.toContain('advisor');
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

  it('sends OpenCode Go a request with no trace of the advisor tool', async () => {
    const sent = captureUpstreamFetch();
    const handle = await startProxyCatalog([goRoute], goRoute.aliasId, false);
    try {
      expect(await postToProxy(handle.port, handle.token, { ...advisorBody(), model: goRoute.aliasId })).toBe(200);

      expect(wireText(sent[0]!.body)).not.toContain('advisor');
      expect(sent[0]!.body.messages[1].content).toEqual([{ type: 'text', text: 'ship it' }]);
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
      const body = { ...lateToolAdditionBody(), ...advisorBody(), model: route.aliasId };
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

  it('sends OpenCode Go a request with no trace of the advisor tool', async () => {
    const sent = captureUpstreamFetch();
    const handle = await startGateway('opencode-go', 'https://opencode.ai/zen/go');

    expect(await post(handle, '/anthropic/v1/messages', advisorBody())).toBe(200);

    expect(wireText(sent[0]!.body)).not.toContain('advisor');
  });

  it('forwards the same blocks untouched to api.anthropic.com', async () => {
    const sent = captureUpstreamFetch();
    const handle = await startGateway('anthropic', 'https://api.anthropic.com');
    const body = { ...lateToolAdditionBody(), ...advisorBody() };

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

  it('never carried the advisor tool or its result blocks to a translated provider', () => {
    const params = translateRequest(advisorBody() as any, '@ai-sdk/openai');

    expect(Object.keys(params.tools ?? {})).toEqual(['Bash', 'Read']);
    expect(wireText(params.messages)).not.toContain('advisor');
  });
});
