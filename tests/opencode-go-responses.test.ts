import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpenCodeGoModels,
  OPENCODE_GO_COMPLETIONS_BASE_URL,
  openCodeGoSessionHeaders,
} from '../src/data/opencode-go-models.js';
import { buildHttpProxyRoutes } from '../src/http-proxy/routes.js';
import {
  createLanguageModel,
  effortProviderOptions,
  getPatchReasoningCapabilities,
  type ProviderModelSpec,
} from '../src/provider-factory.js';
import { materializeRegistry } from '../src/registry/materialize.js';
import type { CachedModel, ProviderRegistry } from '../src/registry/types.js';
import { streamAnthropicResponse, translateRequest } from '../src/sdk-adapter.js';

// OpenCode Go serves gpt-5.6-luna only on POST /v1/responses: /v1/chat/completions
// answers HTTP 500 for it on every request, while the same key and body shape work
// for its Chat Completions models. The wire tests replace only `fetch` below
// translateRequest and createLanguageModel; the step that turns a proxy or server
// route into their inputs is covered in opencode-go-session-header.test.ts.

const SESSION_ID = '7d0f4a52-1c2b-4e8a-9b6f-3c5d2e1f0a9b';
const LUNA = 'gpt-5.6-luna';
// Upstream's Muse Spark contributors joined Luna on the Responses path. Naming the
// set keeps the fleet check below from going vacuous as it grows.
const GO_RESPONSES_MODELS = [LUNA, 'muse-spark-1.2-contributor', 'muse-spark-1.3-contributor'];
const GO_CIPHERTEXT = 'go-encrypted-reasoning';

function lunaCatalogEntry() {
  return buildOpenCodeGoModels().find(model => model.id === LUNA)!;
}

function responsesSse(chunks: unknown[]): string {
  return chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('');
}

// Event order and field names follow a live Go stream captured on 2026-09-16,
// including the `ping` Go sends after `response.completed`.
function toolCallStream(): string {
  return responsesSse([
    { type: 'response.created', sequence_number: 0, response: { id: 'resp_go', created_at: 0, model: LUNA, status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added', sequence_number: 1, output_index: 0,
      item: { id: 'rs_go', type: 'reasoning', encrypted_content: null, summary: [] },
    },
    { type: 'response.reasoning_summary_part.added', sequence_number: 2, item_id: 'rs_go', summary_index: 0 },
    { type: 'response.reasoning_summary_text.delta', sequence_number: 3, item_id: 'rs_go', summary_index: 0, delta: 'Running the command.' },
    { type: 'response.reasoning_summary_part.done', sequence_number: 4, item_id: 'rs_go', summary_index: 0 },
    {
      type: 'response.output_item.done', sequence_number: 5, output_index: 0,
      item: { id: 'rs_go', type: 'reasoning', encrypted_content: GO_CIPHERTEXT, summary: [] },
    },
    {
      type: 'response.output_item.added', sequence_number: 6, output_index: 1,
      item: { id: 'fc_go', type: 'function_call', status: 'in_progress', name: 'Bash', call_id: 'call_go', arguments: '' },
    },
    { type: 'response.function_call_arguments.delta', sequence_number: 7, output_index: 1, item_id: 'fc_go', delta: '{"command":' },
    { type: 'response.function_call_arguments.delta', sequence_number: 8, output_index: 1, item_id: 'fc_go', delta: '"echo hi"}' },
    { type: 'response.function_call_arguments.done', sequence_number: 9, output_index: 1, item_id: 'fc_go', arguments: '{"command":"echo hi"}' },
    {
      type: 'response.output_item.done', sequence_number: 10, output_index: 1,
      item: { id: 'fc_go', type: 'function_call', status: 'completed', name: 'Bash', call_id: 'call_go', arguments: '{"command":"echo hi"}' },
    },
    {
      type: 'response.completed', sequence_number: 11,
      response: {
        id: 'resp_go', created_at: 0, model: LUNA, status: 'completed', incomplete_details: null,
        usage: {
          input_tokens: 40, input_tokens_details: { cached_tokens: 0 },
          output_tokens: 12, output_tokens_details: { reasoning_tokens: 4 },
        },
      },
    },
    { type: 'ping', cost: '0' },
  ]);
}

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

function stubNetwork(): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    return new Response(toolCallStream(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }));
  return captured;
}

function anthropicSseEvents(chunks: string[]): Array<Record<string, any>> {
  return chunks.join('').split('\n\n').flatMap(block => {
    const data = block.split('\n').find(line => line.startsWith('data: '));
    return data ? [JSON.parse(data.slice(6))] : [];
  });
}

/** Rebuilds the assistant content blocks a client would persist from the streamed events. */
function assistantBlocks(events: Array<Record<string, any>>): Array<Record<string, any>> {
  const blocks: Array<Record<string, any>> = [];
  const json = new Map<number, string>();
  for (const event of events) {
    if (event.type === 'content_block_start') blocks[event.index] = structuredClone(event.content_block);
    if (event.type !== 'content_block_delta') continue;
    const block = blocks[event.index]!;
    if (event.delta.type === 'thinking_delta') block.thinking += event.delta.thinking;
    if (event.delta.type === 'signature_delta') block.signature = event.delta.signature;
    if (event.delta.type === 'input_json_delta') json.set(event.index, (json.get(event.index) ?? '') + event.delta.partial_json);
  }
  for (const [index, text] of json) blocks[index]!.input = JSON.parse(text);
  return blocks;
}

const bashTool = {
  name: 'Bash',
  description: 'Run a shell command',
  input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
};

const firstUserTurn = { role: 'user', content: 'Run echo hi.' };

function goLunaRoute(spec: Partial<ProviderModelSpec> = {}): ProviderModelSpec {
  const catalog = lunaCatalogEntry();
  return {
    npm: catalog.npm!,
    modelId: LUNA,
    apiKey: 'go-key',
    baseURL: catalog.apiUrl,
    providerId: 'opencode-go',
    authType: 'api',
    compatibility: catalog.compatibility,
    ...spec,
  };
}

function openAiLunaRoute(): ProviderModelSpec {
  return { npm: '@ai-sdk/openai', modelId: LUNA, apiKey: 'sk-openai', providerId: 'openai', authType: 'api' };
}

async function runTurn(
  route: ProviderModelSpec,
  { effort = 'high', messages = [firstUserTurn] }: { effort?: string; messages?: unknown[] } = {},
): Promise<{ request: CapturedRequest; events: Array<Record<string, any>> }> {
  const captured = stubNetwork();
  const params = translateRequest({
    model: LUNA,
    max_tokens: 2000,
    stream: true,
    tools: [bashTool],
    output_config: { effort },
    metadata: { user_id: JSON.stringify({ session_id: SESSION_ID }) },
    messages: messages as never,
  }, route.npm, {
    claudeSessionId: SESSION_ID,
    reasoningMetadata: {
      providerId: route.providerId,
      apiBaseUrl: route.baseURL,
      reasoning: true,
      compatibility: route.compatibility,
      upstreamModelId: LUNA,
    },
  });
  const sessionHeaders = openCodeGoSessionHeaders(
    { providerId: route.providerId, baseUrl: route.baseURL },
    SESSION_ID,
  );
  if (sessionHeaders) params.headers = { ...params.headers, ...sessionHeaders };
  const model = await createLanguageModel(route);
  const written: string[] = [];
  await streamAnthropicResponse(model, params, 'luna', chunk => written.push(chunk), () => {});
  expect(captured).toHaveLength(1);
  vi.unstubAllGlobals();
  return { request: captured[0]!, events: anthropicSseEvents(written) };
}

function replayedReasoning(request: CapturedRequest): Array<Record<string, any>> {
  return (request.body.input as Array<Record<string, any>>).filter(item => item.type === 'reasoning');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenCode Go gpt-5.6-luna catalog entry', () => {
  it('routes Luna through the OpenAI Responses SDK at the Go endpoint', () => {
    expect(lunaCatalogEntry()).toMatchObject({
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      apiUrl: 'https://opencode.ai/zen/go/v1',
    });
  });

  it('keeps every other OpenAI-format Go model on Chat Completions', () => {
    const others = buildOpenCodeGoModels()
      .filter(model => model.modelFormat === 'openai' && !GO_RESPONSES_MODELS.includes(model.id));
    expect(others.length).toBeGreaterThan(0);
    for (const model of others) {
      expect(model.npm, model.id).toBe('@ai-sdk/openai-compatible');
    }
  });

  it('carries only the effort ladder, not Chat Completions field quirks', () => {
    // Measured on /v1/responses 2026-09-16: none/low/medium/high/xhigh/max answer
    // 200 and minimal answers 400 unsupported_value.
    expect(lunaCatalogEntry().compatibility).toEqual({
      reasoningEffortMap: {
        off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
      },
    });
  });

  it('reports the input Go accepts as the window, not input plus output', () => {
    // Measured on Go's /v1/responses 2026-09-23: 915,013 input tokens answer 200,
    // 930,000 answer context_length_exceeded. models.dev lists 1,050,000 in total.
    expect(lunaCatalogEntry().contextWindow).toBe(922_000);
  });
});

describe('an installed OpenCode Go provider exposes Luna on the Responses route', () => {
  // What providers.json holds for Luna on an install whose cache predates the Responses route.
  const staleCachedLuna: CachedModel = {
    id: LUNA,
    name: 'GPT-5.6 Luna',
    upstreamModelId: LUNA,
    family: 'gpt',
    modelFormat: 'openai',
    npm: '@ai-sdk/openai-compatible',
    apiUrl: OPENCODE_GO_COMPLETIONS_BASE_URL,
    compatibility: {
      reasoningEffortMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
    },
  };

  for (const identity of [
    { id: 'opencode-go', templateId: 'opencode-go' },
    { id: 'imported-opencode', templateId: 'opencode-go' },
  ]) {
    it(`materializes a Responses route pinned to Go for ${identity.id}`, () => {
      const registry: ProviderRegistry = {
        schemaVersion: 1,
        providers: [{
          ...identity,
          name: 'OpenCode Go',
          enabled: true,
          authRef: `keyring:provider:${identity.id}`,
          authType: 'api',
          api: { npm: '@ai-sdk/openai-compatible', url: OPENCODE_GO_COMPLETIONS_BASE_URL },
          modelsCache: { fetchedAt: '2026-09-11T00:00:00.000Z', models: [staleCachedLuna] },
          addedAt: '2026-09-11T00:00:00.000Z',
        }],
      };

      const routes = buildHttpProxyRoutes(
        materializeRegistry(registry, () => 'go-key'),
        [{ providerId: identity.id, modelId: LUNA }],
      ).routes;

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        modelFormat: 'openai',
        npm: '@ai-sdk/openai',
        baseURL: 'https://opencode.ai/zen/go/v1',
        apiKey: 'go-key',
        realModelId: LUNA,
        compatibility: lunaCatalogEntry().compatibility,
      });
    });
  }

  it('reports the catalog window over a 1,050,000 saved before the cap', () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'OpenCode Go',
        enabled: true,
        authRef: 'keyring:provider:opencode-go',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: OPENCODE_GO_COMPLETIONS_BASE_URL },
        modelsCache: {
          fetchedAt: '2026-09-16T00:00:00.000Z',
          models: [{ ...staleCachedLuna, npm: '@ai-sdk/openai', contextWindow: 1_050_000 }],
        },
        addedAt: '2026-09-11T00:00:00.000Z',
      }],
    };

    const [provider] = materializeRegistry(registry, () => 'go-key');
    expect(provider?.models.find(model => model.id === LUNA)?.contextWindow).toBe(922_000);
  });
});

describe('an OpenCode Go Luna turn on the wire', () => {
  it('posts to Go /v1/responses with the Go key and session, and streams the tool call back', async () => {
    const { request, events } = await runTurn(goLunaRoute());

    // Spelled out rather than built from a constant: this request carries a live key.
    expect(request.url).toBe('https://opencode.ai/zen/go/v1/responses');
    expect(request.headers.get('authorization')).toBe('Bearer go-key');
    expect(request.headers.get('x-opencode-session')).toBe(SESSION_ID);
    expect(request.body).toMatchObject({
      model: LUNA,
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 2000,
      reasoning: { effort: 'high' },
    });
    expect(request.body.tools).toEqual([expect.objectContaining({ type: 'function', name: 'Bash', strict: false })]);

    const blocks = assistantBlocks(events);
    expect(blocks.map(block => block.type)).toEqual(['thinking', 'tool_use']);
    expect(blocks[0]!.signature).toBeTruthy();
    expect(blocks[1]).toMatchObject({ name: 'Bash', id: 'call_go', input: { command: 'echo hi' } });
    expect(events.find(event => event.type === 'message_delta')?.delta.stop_reason).toBe('tool_use');
  });

  it('keeps the Go destination for a retained provider whose id drifted', async () => {
    const { request } = await runTurn(goLunaRoute({ providerId: 'imported-opencode' }));
    expect(request.url).toBe('https://opencode.ai/zen/go/v1/responses');
    expect(request.headers.get('x-opencode-session')).toBe(SESSION_ID);
  });

  it('sends a Go route to the reviewed Go address, never to the URL the route carries', async () => {
    const { request } = await runTurn(goLunaRoute({ baseURL: 'https://gateway.example/v1' }));
    expect(request.url).toBe('https://opencode.ai/zen/go/v1/responses');
  });

  it('keeps an anonymous Go route on Go without credentials, and refuses an OAuth-typed one', async () => {
    const { request } = await runTurn(goLunaRoute({ authType: 'none' }));
    expect(request.url).toBe('https://opencode.ai/zen/go/v1/responses');
    expect(request.headers.has('authorization')).toBe(false);

    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);
    await expect(createLanguageModel(goLunaRoute({ authType: 'oauth' }))).rejects.toThrow(/OpenCode Go/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('sends effort none for off and never sends minimal', async () => {
    expect((await runTurn(goLunaRoute(), { effort: 'off' })).request.body.reasoning).toMatchObject({ effort: 'none' });
    expect((await runTurn(goLunaRoute(), { effort: 'minimal' })).request.body.reasoning?.effort).toBeUndefined();
  });
});

describe('reasoning replay across a model switch', () => {
  // Go answers 400 invalid_encrypted_content (measured 2026-09-16) to reasoning
  // ciphertext it did not produce, and that item stays in every later request.
  async function historyFrom(route: ProviderModelSpec): Promise<unknown[]> {
    const { events } = await runTurn(route);
    const blocks = assistantBlocks(events);
    const toolUse = blocks.find(block => block.type === 'tool_use')!;
    return [
      firstUserTurn,
      { role: 'assistant', content: blocks },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'hi' }] },
    ];
  }

  it('replays Go reasoning ciphertext to Go and only its text to OpenAI', async () => {
    const history = await historyFrom(goLunaRoute());

    expect(replayedReasoning((await runTurn(goLunaRoute(), { messages: history })).request))
      .toEqual([expect.objectContaining({ id: 'rs_go', encrypted_content: GO_CIPHERTEXT })]);
    expect(JSON.stringify((await runTurn(openAiLunaRoute(), { messages: history })).request.body))
      .not.toContain(GO_CIPHERTEXT);
  });

  it('replays OpenAI reasoning ciphertext to OpenAI and never to Go', async () => {
    const history = await historyFrom(openAiLunaRoute());

    expect(replayedReasoning((await runTurn(openAiLunaRoute(), { messages: history })).request))
      .toEqual([expect.objectContaining({ id: 'rs_go', encrypted_content: GO_CIPHERTEXT })]);
    expect(JSON.stringify((await runTurn(goLunaRoute(), { messages: history })).request.body))
      .not.toContain(GO_CIPHERTEXT);
  });

  it('never sends a Claude thinking signature to Go as ciphertext', async () => {
    const history = [
      firstUserTurn,
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'Claude reasoning', signature: 'claude-signature' }, { type: 'text', text: 'ok' }] },
      { role: 'user', content: 'Run echo hi again.' },
    ];
    expect(JSON.stringify((await runTurn(goLunaRoute(), { messages: history })).request.body))
      .not.toContain('claude-signature');
  });
});

describe('Luna effort control on the Go Responses route', () => {
  const catalog = lunaCatalogEntry();
  const metadata = { providerId: 'opencode-go', reasoning: catalog.reasoning, compatibility: catalog.compatibility };

  it('advertises the gateway ladder, off included, to a patched client', () => {
    const patch = getPatchReasoningCapabilities(catalog.npm!, LUNA, metadata);
    expect(patch.levels).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
    for (const [level, wire] of [['off', 'none'], ['low', 'low'], ['xhigh', 'xhigh'], ['max', 'max']]) {
      expect(effortProviderOptions(catalog.npm!, level, LUNA, metadata), level)
        .toEqual({ openai: { reasoningEffort: wire, forceReasoning: true } });
    }
    expect(effortProviderOptions(catalog.npm!, 'minimal', LUNA, metadata)).toBeUndefined();
  });
});

describe('the OpenCode Go key probe', () => {
  it('names a Chat Completions model even when a Responses model sorts first', async () => {
    vi.resetModules();
    const models = buildOpenCodeGoModels();
    const luna = models.find(model => model.id === LUNA)!;
    vi.doMock('../src/data/opencode-go-models.js', async importOriginal => ({
      ...await importOriginal<typeof import('../src/data/opencode-go-models.js')>(),
      buildOpenCodeGoModels: () => [luna, ...models.filter(model => model !== luna)],
    }));
    try {
      const { verifyOpenCodeGoCredential } = await import('../src/provider-templates.js');
      const transport = vi.fn(async () => new Response('{}', { status: 400 }));
      vi.stubGlobal('fetch', transport);
      await verifyOpenCodeGoCredential('go-key');
      const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
      const probed = models.find(model => model.id === JSON.parse(String(init.body)).model);
      expect(probed?.npm).toBe('@ai-sdk/openai-compatible');
    } finally {
      vi.doUnmock('../src/data/opencode-go-models.js');
      vi.resetModules();
    }
  });
});

describe('OpenAI routes for gpt-5.6-luna stay where they were', () => {
  // An API-key route honours the URL it was given: a Luna route with no stored URL
  // reaches api.openai.com, and one pointed at a third-party host reaches THAT host
  // rather than silently sending its key to OpenAI. What the Go branch must never do
  // is claim either of them — the OpenCode key and endpoint stay out of both.
  it.each([
    [undefined, 'https://api.openai.com/v1/responses'],
    ['https://api.openai.com/v1', 'https://api.openai.com/v1/responses'],
    ['https://gateway.example/v1', 'https://gateway.example/v1/responses'],
  ])('sends an OpenAI API-key Luna request for stored URL %s to %s', async (baseURL, expected) => {
    const captured = stubNetwork();
    const model = await createLanguageModel({ ...openAiLunaRoute(), baseURL });
    const written: string[] = [];
    await streamAnthropicResponse(model, {
      messages: [{ role: 'user', content: 'hi' }],
      providerOptions: effortProviderOptions('@ai-sdk/openai', 'xhigh', LUNA, { providerId: 'openai' }),
    }, LUNA, chunk => written.push(chunk), () => {});
    expect(captured[0]?.url, String(baseURL)).toBe(expected);
    expect(captured[0]?.url, String(baseURL)).not.toContain('opencode.ai');
    expect(captured[0]?.headers.get('authorization')).toBe('Bearer sk-openai');
    expect(captured[0]?.body.reasoning).toMatchObject({ effort: 'xhigh' });
  });

  it('keeps the OpenAI family effort rules when no curated ladder is present', () => {
    expect(effortProviderOptions('@ai-sdk/openai', 'off', LUNA, { providerId: 'openai' })).toBeUndefined();
    expect(effortProviderOptions('@ai-sdk/openai', 'none', LUNA, { providerId: 'openai-oauth' }))
      .toEqual({ openai: { reasoningEffort: 'none', forceReasoning: true } });
  });

  it('keeps ChatGPT OAuth Luna on the Codex WebSocket backend', async () => {
    vi.resetModules();
    const responses = vi.fn((modelId: string) => ({ modelId }));
    const createOpenAI = vi.fn(() => ({ responses, chat: vi.fn() }));
    vi.doMock('@ai-sdk/openai', () => ({ createOpenAI }));
    try {
      const { createLanguageModel: create } = await import('../src/provider-factory.js');
      await create({
        npm: '@ai-sdk/openai',
        modelId: LUNA,
        apiKey: 'oauth-token',
        authType: 'oauth',
        providerId: 'openai-oauth',
        oauthAccountId: 'acct-1',
        useResponsesLite: true,
        preferWebSockets: true,
      });
      const options = (createOpenAI.mock.calls[0] as unknown as [Record<string, any>])[0];
      expect(options.baseURL).toBe('https://chatgpt.com/backend-api/codex');
      expect(options.fetch).toEqual(expect.any(Function));
      expect(options.headers['x-openai-internal-codex-responses-lite']).toBe('true');
      expect(responses).toHaveBeenCalledWith(LUNA);
    } finally {
      vi.doUnmock('@ai-sdk/openai');
      vi.resetModules();
    }
  });
});
