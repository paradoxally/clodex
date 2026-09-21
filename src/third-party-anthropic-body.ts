// Anthropic-format request bodies bound for an upstream that is not Anthropic.
//
// When deferred tools (`defer_loading: true`) connect mid-conversation, Claude
// Code announces them with `tool_addition` blocks in a system message. OpenCode
// Go answers any request carrying one with HTTP 400 `{"model":"<id>"}`, which
// kills every later turn of the session. It accepts the same body without them,
// and it accepts the `tool_reference` blocks a ToolSearch result carries, so
// those are left alone.
//
// Removing the blocks alone would change what the request means to an upstream
// that honours `defer_loading`: the tools they announced would stay hidden. So
// each announced tool is sent as an ordinary tool instead, as Claude Code does
// itself when the API refuses `tool_addition` and no ToolSearch tool is
// present. OpenCode Go ignores `defer_loading` and exposes deferred tools from
// the first request, so for it that step changes nothing the model sees.
//
// Claude Code 2.1.278 added a second, unrelated block from the same class of
// mistake. Once an advisor model resolves it appends an `advisor_20260301`
// server-side tool to the `tools` array of every request, whatever upstream the
// request is headed for, and once the advisor has run the history carries the
// `server_tool_use` and `advisor_tool_result` blocks it produced. OpenCode Go
// answers a request carrying the tool with HTTP 422 `{"model":"<id>"}`, the
// result block with 422 and the `server_tool_use` block with 400. Claude Code
// has its own recovery for all three, but it only fires on an Anthropic-shaped
// 400, so nothing on its side ever retries. Only Anthropic executes the advisor,
// so removing those blocks costs a third-party upstream nothing.
//
// The request also carries an `advisor-tool-2026-03-01` beta header, which is
// left alone: OpenCode Go answers 200 with it present, and the header is
// assembled outside this module.
//
// A message left holding only the advisor's own blocks gets the same
// `[Advisor response]` placeholder Claude Code substitutes, because an
// assistant turn with no content of its own is not a valid request.

import { toolAdditionName } from './tool-search.js';

type Block = Record<string, unknown>;

export interface AnthropicUpstream {
  providerId?: string;
  baseUrl: string;
}

function isBlock(value: unknown): value is Block {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isAnthropicFirstPartyUpstream(upstream: AnthropicUpstream): boolean {
  if (upstream.providerId === 'claude-code') return true;
  try {
    return new URL(upstream.baseUrl).hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
}

export function anthropicBodyForUpstream<T extends Record<string, unknown>>(
  body: T,
  upstream: AnthropicUpstream,
): T {
  if (isAnthropicFirstPartyUpstream(upstream)) return body;
  return stripAdvisorTool(stripToolAdditions(body));
}

function hasToolAddition(content: unknown): boolean {
  return Array.isArray(content) && content.some(block => isBlock(block) && block.type === 'tool_addition');
}

/**
 * The breakpoint ends a prefix the preceding entry ends too, so move it rather than lose it.
 * It only ever moves backwards. Moving it onto what follows would cache a longer prefix than the
 * client asked to cache, so a dropped entry with nothing before it loses its breakpoint instead.
 */
function carryCacheControlBack(kept: unknown[], dropped: Block): void {
  const previous = kept.at(-1);
  if (dropped.cache_control !== undefined && isBlock(previous) && previous.cache_control === undefined) {
    kept[kept.length - 1] = { ...previous, cache_control: dropped.cache_control };
  }
}

function withoutToolAdditions(content: unknown[], announced: Set<string>): unknown[] {
  const out: unknown[] = [];
  for (const block of content) {
    if (!isBlock(block) || block.type !== 'tool_addition') {
      out.push(block);
      continue;
    }
    const name = toolAdditionName(block);
    if (name !== undefined) announced.add(name);
    carryCacheControlBack(out, block);
  }
  return out;
}

/** Returns `body` itself when it carries no `tool_addition` block; never mutates it. */
export function stripToolAdditions<T extends Record<string, unknown>>(body: T): T {
  const messages = body.messages;
  if (!Array.isArray(messages) || !messages.some(message => isBlock(message) && hasToolAddition(message.content))) {
    return body;
  }

  const announced = new Set<string>();
  const cleaned: Record<string, unknown> = {
    ...body,
    messages: messages.flatMap(message => {
      if (!isBlock(message) || !hasToolAddition(message.content)) return [message];
      const content = withoutToolAdditions(message.content as unknown[], announced);
      return content.length === 0 ? [] : [{ ...message, content }];
    }),
  };
  if (Array.isArray(body.tools)) {
    cleaned.tools = body.tools.map(tool => {
      if (!isBlock(tool) || tool.defer_loading !== true) return tool;
      if (typeof tool.name !== 'string' || !announced.has(tool.name)) return tool;
      const { defer_loading: _deferred, ...announcedTool } = tool;
      return announcedTool;
    });
  }
  return cleaned as T;
}

const ADVISOR_TOOL_NAME = 'advisor';
const ADVISOR_PLACEHOLDER_TEXT = '[Advisor response]';

/** Anthropic dates these types, so match the family rather than the one release we have seen. */
function isAdvisorType(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('advisor_');
}

function isAdvisorTool(tool: unknown): boolean {
  return isBlock(tool) && isAdvisorType(tool.type);
}

function isAdvisorContent(block: unknown): boolean {
  if (!isBlock(block)) return false;
  return isAdvisorType(block.type)
    || (block.type === 'server_tool_use' && block.name === ADVISOR_TOOL_NAME);
}

function hasAdvisorContent(content: unknown): boolean {
  return Array.isArray(content) && content.some(isAdvisorContent);
}

/** Claude Code's own rule for an assistant turn the advisor blocks were carrying on their own. */
function isEmptyOfSpeech(content: unknown[]): boolean {
  return content.every(block => isBlock(block) && (
    block.type === 'thinking'
    || block.type === 'redacted_thinking'
    || (block.type === 'text' && (typeof block.text !== 'string' || block.text.trim() === ''))
  ));
}

function withoutAdvisorTool(tools: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const tool of tools) {
    if (!isAdvisorTool(tool)) out.push(tool);
    else carryCacheControlBack(out, tool as Block);
  }
  return out;
}

function withoutAdvisorContent(content: unknown[], role: unknown): unknown[] {
  const out: unknown[] = [];
  let orphanedCacheControl: unknown;
  for (const block of content) {
    if (!isAdvisorContent(block)) {
      out.push(block);
      continue;
    }
    const dropped = block as Block;
    if (out.length > 0) carryCacheControlBack(out, dropped);
    else if (dropped.cache_control !== undefined) orphanedCacheControl = dropped.cache_control;
  }
  // Claude Code substitutes the placeholder on assistant turns only; any other role that the
  // blocks somehow reached is left to the same rule the tool_addition strip uses, and goes away.
  if (role !== 'assistant' || !isEmptyOfSpeech(out)) return out;
  out.push({
    type: 'text',
    text: ADVISOR_PLACEHOLDER_TEXT,
    ...(orphanedCacheControl !== undefined && { cache_control: orphanedCacheControl }),
  });
  return out;
}

/** Returns `body` itself when nothing in it came from the advisor tool; never mutates it. */
export function stripAdvisorTool<T extends Record<string, unknown>>(body: T): T {
  const { tools, messages } = body;
  const declaresTool = Array.isArray(tools) && tools.some(isAdvisorTool);
  const carriesContent = Array.isArray(messages)
    && messages.some(message => isBlock(message) && hasAdvisorContent(message.content));
  if (!declaresTool && !carriesContent) return body;

  const cleaned: Record<string, unknown> = { ...body };
  if (declaresTool) cleaned.tools = withoutAdvisorTool(tools as unknown[]);
  if (carriesContent) {
    cleaned.messages = (messages as unknown[]).flatMap(message => {
      if (!isBlock(message) || !hasAdvisorContent(message.content)) return [message];
      const content = withoutAdvisorContent(message.content as unknown[], message.role);
      return content.length === 0 ? [] : [{ ...message, content }];
    });
  }
  return cleaned as T;
}
