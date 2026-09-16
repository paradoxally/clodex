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
  return isAnthropicFirstPartyUpstream(upstream) ? body : stripToolAdditions(body);
}

function hasToolAddition(content: unknown): boolean {
  return Array.isArray(content) && content.some(block => isBlock(block) && block.type === 'tool_addition');
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
    // The breakpoint marks the end of this message; the block before it ends the same prefix.
    const previous = out.at(-1);
    if (block.cache_control !== undefined && isBlock(previous) && previous.cache_control === undefined) {
      out[out.length - 1] = { ...previous, cache_control: block.cache_control };
    }
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
