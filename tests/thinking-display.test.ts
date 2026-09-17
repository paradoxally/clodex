import { Transform } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  anthropicSseThinkingDisplay,
  hidesThinkingText,
  withoutThinkingText,
} from '../src/thinking-display.js';

// Claude Code 2.1.273 asks for the chain of thought in two different ways. An
// interactive session sends `{"type":"adaptive"}` with no `display` at all
// (`pKn` returns undefined whenever `isNonInteractive` is false), while `-p`,
// subagents and background agents send `display:"omitted"`. Anthropic answers
// both with a thinking block that has zero characters of text -- across 1,839
// transcripts of this machine, 33,351 `thinking`-tagged blocks carried text
// zero times. The only text Anthropic returns is on a separate `narration`
// channel, which is what Claude Code's `connector_text` render mode shows.
//
// So the client's displayed thinking text is governed by `display`, and by
// `type: "adaptive"` whenever `display` is absent.

describe('hidesThinkingText', () => {
  it('hides when the client explicitly asked for omitted display', () => {
    expect(hidesThinkingText({ type: 'adaptive', display: 'omitted' })).toBe(true);
  });

  it('hides for an adaptive request that names no display', () => {
    // The interactive TUI shape, captured from Claude Code 2.1.273 with
    // showThinkingSummaries:false. Missing this branch leaves the reported bug
    // unfixed for every interactive session.
    expect(hidesThinkingText({ type: 'adaptive' })).toBe(true);
  });

  it('keeps the text when the client asked for summaries', () => {
    expect(hidesThinkingText({ type: 'adaptive', display: 'summarized' })).toBe(false);
  });

  it('keeps the text for legacy extended thinking', () => {
    // `enabled` + budget_tokens is the pre-adaptive shape, where the caller is
    // asking for the reasoning rather than a summary of it.
    expect(hidesThinkingText({ type: 'enabled', budget_tokens: 4096 })).toBe(false);
  });

  it('does nothing when thinking is disabled or absent', () => {
    expect(hidesThinkingText({ type: 'disabled' })).toBe(false);
    // Without this the disabled guard is unpinned: the fall-through already
    // returns false for a bare `disabled`, so only a display value that would
    // otherwise hide proves the guard is doing anything.
    expect(hidesThinkingText({ type: 'disabled', display: 'omitted' })).toBe(false);
    expect(hidesThinkingText({ type: 'disabled', display: 'updates' })).toBe(false);
    expect(hidesThinkingText(undefined)).toBe(false);
    expect(hidesThinkingText(null)).toBe(false);
    expect(hidesThinkingText('omitted')).toBe(false);
    expect(hidesThinkingText([])).toBe(false);
  });

  it('hides for the streaming-updates mode Claude Code upgrades to on a first-party connection', () => {
    // Measured on a real proxy-mode run of 2.1.273: `thinking_display_updates`
    // rewrites `connector_text` requests to this value, so it is what the
    // normal path actually sends. Missing it leaves the reported bug unfixed.
    expect(hidesThinkingText({ type: 'adaptive', display: 'updates' })).toBe(true);
  });

  it('hides for an adaptive request with a display value it does not recognise', () => {
    // Anthropic has no mode that returns raw chain of thought for adaptive
    // thinking, so an unknown value fails towards hiding rather than leaking it.
    expect(hidesThinkingText({ type: 'adaptive', display: 'verbose' })).toBe(true);
  });

  it('does not hide an unknown thinking type that happens to omit display', () => {
    expect(hidesThinkingText({ budget_tokens: 4096 })).toBe(false);
  });

  it('hides legacy extended thinking only when it explicitly asked for it', () => {
    expect(hidesThinkingText({ type: 'enabled', display: 'omitted' })).toBe(true);
    expect(hidesThinkingText({ type: 'enabled', display: 'updates' })).toBe(true);
  });
});

describe('anthropicSseThinkingDisplay', () => {
  const collect = async (transform: Transform, chunks: string[]): Promise<string> => {
    const out: Buffer[] = [];
    transform.on('data', chunk => out.push(Buffer.from(chunk)));
    for (const chunk of chunks) transform.write(Buffer.from(chunk, 'utf8'));
    await new Promise<void>((resolve, reject) => {
      transform.on('end', resolve);
      transform.on('error', reject);
      transform.end();
    });
    return Buffer.concat(out).toString('utf8');
  };

  const event = (name: string, data: unknown): string =>
    `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

  const blockStart = event('content_block_start', {
    type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' },
  });
  const thinkingDelta = (text: string) => event('content_block_delta', {
    type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text },
  });
  const signatureDelta = event('content_block_delta', {
    type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' },
  });
  const textDelta = event('content_block_delta', {
    type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello' },
  });

  it('drops thinking deltas and keeps the signature that carries the block', async () => {
    const out = await collect(anthropicSseThinkingDisplay(true), [
      blockStart + thinkingDelta('secret one ') + thinkingDelta('secret two') + signatureDelta + textDelta,
    ]);
    expect(out).not.toContain('secret one');
    expect(out).not.toContain('secret two');
    expect(out).not.toContain('thinking_delta');
    expect(out).toContain('"signature":"sig-1"');
    expect(out).toContain('"text":"hello"');
    expect(out).toContain('"type":"thinking","thinking":"","signature":""');
  });

  it('drops the event line with the data line, leaving no data-less event behind', async () => {
    // An orphaned `event: content_block_delta` is its own defect: the client
    // reads it as an event with no payload.
    const out = await collect(anthropicSseThinkingDisplay(true), [
      thinkingDelta('secret') + textDelta,
    ]);
    expect(out.match(/event:/g)).toHaveLength(1);
    expect(out).toBe(textDelta);
  });

  it('blanks a thinking block that arrives with its text in content_block_start', async () => {
    const startWithText = event('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'thinking', thinking: 'secret at start', signature: '' },
    });
    const out = await collect(anthropicSseThinkingDisplay(true), [startWithText]);
    expect(out).not.toContain('secret at start');
    expect(out).toContain('"thinking":""');
    expect(out).toContain('"type":"content_block_start"');
  });

  it('leaves every other event byte-identical, including tool input', async () => {
    const toolDelta = event('content_block_delta', {
      type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":"Lisbon"}' },
    });
    const stop = event('content_block_stop', { type: 'content_block_stop', index: 0 });
    const ping = 'event: ping\ndata: {"type":"ping"}\n\n';
    const body = textDelta + toolDelta + stop + ping;
    expect(await collect(anthropicSseThinkingDisplay(true), [body])).toBe(body);
  });

  it('passes the stream through untouched when nothing is hidden', async () => {
    const body = blockStart + thinkingDelta('visible') + signatureDelta;
    expect(await collect(anthropicSseThinkingDisplay(false), [body])).toBe(body);
  });

  it('keeps whatever line endings the upstream used', async () => {
    const crlf = 'event: content_block_delta\r\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"secret"}}\r\n\r\n'
      + 'event: content_block_delta\r\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}\r\n\r\n';
    const out = await collect(anthropicSseThinkingDisplay(true), [crlf]);
    expect(out).not.toContain('secret');
    expect(out).toContain('"signature":"sig"');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('drops a thinking delta that is split across chunk boundaries', async () => {
    const whole = thinkingDelta('secret') + textDelta;
    const split = whole.indexOf('secret') + 3;
    const out = await collect(anthropicSseThinkingDisplay(true), [whole.slice(0, split), whole.slice(split)]);
    expect(out).toBe(textDelta);
  });

  it('emits a complete event before the stream ends', async () => {
    // A relay that buffers until flush stalls the client; the trimmed stream is
    // only correct if it still streams.
    const out: Buffer[] = [];
    const transform = anthropicSseThinkingDisplay(true);
    transform.on('data', chunk => out.push(Buffer.from(chunk)));
    transform.write(Buffer.from(textDelta, 'utf8'));
    await new Promise(resolve => setImmediate(resolve));
    expect(Buffer.concat(out).toString('utf8')).toBe(textDelta);
  });

  it('passes a malformed data line through unchanged rather than guessing', async () => {
    const malformed = 'event: content_block_delta\ndata: {"type":"content_block_delta",oops\n\n';
    const out = await collect(anthropicSseThinkingDisplay(true), [malformed]);
    expect(out).toBe(malformed);
  });

  it('drops an unterminated thinking event at the end of a stream', async () => {
    // A provider that dies mid-event leaves a final line with no blank line
    // after it. Missing it there would emit the event's `event:` line with no
    // payload AND leak the reasoning.
    const cut = 'event: content_block_delta\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"secret"}}';
    expect(await collect(anthropicSseThinkingDisplay(true), [cut])).toBe('');
  });

  it('keeps an unterminated event that is not a thinking delta', async () => {
    const cut = 'event: content_block_delta\n'
      + 'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}';
    expect(await collect(anthropicSseThinkingDisplay(true), [cut])).toBe(cut);
  });

  it('drops a thinking delta whose payload is far larger than any buffer', async () => {
    const huge = `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"${'x'.repeat(300000)}"}}\n\n`;
    const ping = 'event: ping\ndata: {"type":"ping"}\n\n';
    expect(await collect(anthropicSseThinkingDisplay(true), [huge + ping])).toBe(ping);
  });

  it('blanks a thinking block whose content_block_start is split over data lines', async () => {
    // The same legal framing as the delta case: deciding per line leaves this
    // one unparsed, and the reasoning inside content_block reaches the client.
    const split = 'event: content_block_start\n'
      + 'data: {"type":"content_block_start","index":0,\n'
      + 'data: "content_block":{"type":"thinking","thinking":"secret at start","signature":""}}\n\n';
    const out = await collect(anthropicSseThinkingDisplay(true), [split]);
    expect(out).not.toContain('secret at start');
    expect(out).toContain('"thinking":""');
    expect(out).toContain('"type":"content_block_start"');
  });

  it('relays an event too large to hold rather than buffering it without bound', async () => {
    // An upstream that never emits a blank line must not grow this buffer for
    // as long as it runs: past the cap, bytes go out as they arrive.
    const transform = anthropicSseThinkingDisplay(true);
    const out: Buffer[] = [];
    transform.on('data', chunk => out.push(Buffer.from(chunk)));
    const unterminated = 'event: content_block_delta\ndata: ' + 'x'.repeat(1_200_000);
    transform.write(Buffer.from(unterminated, 'utf8'));
    await new Promise(resolve => setImmediate(resolve));

    expect(Buffer.concat(out).toString('utf8').length).toBeGreaterThan(1_000_000);

    await new Promise<void>((resolve, reject) => {
      transform.on('end', resolve);
      transform.on('error', reject);
      transform.end();
    });
    // Past the cap the bytes are relayed unchanged, so nothing is lost.
    expect(Buffer.concat(out).toString('utf8')).toBe(unterminated);
  });

  it('filters an event that follows an oversized one in the same chunk', async () => {
    // Everything after the oversized event's terminator belongs to the next
    // event. Relaying it with the oversized one leaks the reasoning.
    const transform = anthropicSseThinkingDisplay(true);
    const out: Buffer[] = [];
    transform.on('data', chunk => out.push(Buffer.from(chunk)));
    const oversized = 'event: content_block_delta\ndata: ' + 'x'.repeat(1_200_000);
    transform.write(Buffer.from(oversized + '\n\n'
      + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"secret"}}\n\n', 'utf8'));
    await new Promise<void>((resolve, reject) => {
      transform.on('end', resolve);
      transform.on('error', reject);
      transform.end();
    });

    const streamed = Buffer.concat(out).toString('utf8');
    expect(streamed).not.toContain('secret');
    expect(streamed).toContain('x'.repeat(100));
  });

  it('resumes filtering when the oversized event terminator is split across chunks', async () => {
    // Holding no bytes back across the boundary means the two halves are never
    // seen as one terminator, and every later event is relayed unfiltered for
    // the rest of the stream.
    const transform = anthropicSseThinkingDisplay(true);
    const out: Buffer[] = [];
    transform.on('data', chunk => out.push(Buffer.from(chunk)));
    const oversized = 'event: content_block_delta\ndata: ' + 'x'.repeat(1_200_000);
    const thinking = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"secret"}}\n\n';
    transform.write(Buffer.from(oversized, 'utf8'));
    transform.write(Buffer.from('\n', 'utf8'));
    transform.write(Buffer.from('\n' + thinking, 'utf8'));
    await new Promise<void>((resolve, reject) => {
      transform.on('end', resolve);
      transform.on('error', reject);
      transform.end();
    });

    expect(Buffer.concat(out).toString('utf8')).not.toContain('secret');
  });

  it('passes comment lines and multi-line payloads through with their framing', async () => {
    const comment = ': keepalive\n\n';
    const multiData = 'event: x\ndata: {"a":1}\ndata: {"b":2}\n\n';
    const body = comment + multiData;
    expect(await collect(anthropicSseThinkingDisplay(true), [body])).toBe(body);
  });

  it('keeps a CRLF split between its CR and its LF across chunks', async () => {
    // Treating the CR as a bare-CR ending closes the `event:` line early, so the
    // event is emitted before its data arrives and the data line travels alone.
    const thinking = 'event: content_block_delta\r\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"secret"}}\r\n\r\n';
    const kept = 'event: content_block_delta\r\n'
      + 'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}\r\n\r\n';
    const whole = thinking + kept;
    const cut = thinking.indexOf('\r') + 1;   // between the CR and the LF of the event line
    const out = await collect(anthropicSseThinkingDisplay(true), [whole.slice(0, cut), whole.slice(cut)]);
    expect(out).not.toContain('secret');
    expect(out).toBe(kept);
  });

  it('drops a thinking delta whose payload legal SSE split over two data lines', async () => {
    // A line-at-a-time parse fails on this framing, and failing open here
    // relays the reasoning the client asked to hide.
    const split = 'event: content_block_delta\n'
      + 'data: {"type":"content_block_delta","index":0,\n'
      + 'data: "delta":{"type":"thinking_delta","thinking":"secret"}}\n\n';
    expect(await collect(anthropicSseThinkingDisplay(true), [split])).toBe('');
  });

  it('preserves bare-CR framing', async () => {
    const cr = 'event: ping\rdata: {"type":"ping"}\r\r';
    expect(await collect(anthropicSseThinkingDisplay(true), [cr])).toBe(cr);
  });
});

describe('withoutThinkingText', () => {
  it('blanks a thinking block in a non-streaming message', () => {
    const message = {
      type: 'message',
      model: 'deepseek-v4.1-flash',
      content: [
        { type: 'thinking', thinking: 'secret reasoning', signature: 'sig-1' },
        { type: 'text', text: 'the answer' },
      ],
    };
    expect(withoutThinkingText(message)).toEqual({
      type: 'message',
      model: 'deepseek-v4.1-flash',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'text', text: 'the answer' },
      ],
    });
  });

  it('returns the same object when there is nothing to blank', () => {
    const message = { type: 'message', content: [{ type: 'text', text: 'hi' }] };
    expect(withoutThinkingText(message)).toBe(message);
    const noContent = { type: 'message' };
    expect(withoutThinkingText(noContent)).toBe(noContent);
  });

  it('never mutates the message it was given', () => {
    const block = { type: 'thinking', thinking: 'secret', signature: 'sig-1' };
    const message = { type: 'message', content: [block] };
    withoutThinkingText(message);
    expect(block.thinking).toBe('secret');
  });
});
