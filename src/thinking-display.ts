// Whether a request's thinking text may reach the client.
//
// Claude Code 2.1.273 asks for the chain of thought in three shapes, all of
// which Anthropic answers with a thinking block carrying a signature and zero
// characters of text:
//
//   * `display: "omitted"` -- `-p`, subagents and background agents (`pKn`).
//   * no `display` at all -- an interactive session with summaries off.
//   * `display: "updates"` -- a first-party connection in `connector_text`
//     render mode upgrades the request so the block streams and the connector
//     can tick. Measured on a real proxy-mode run, which is the normal path:
//     every other capture shape hides this value, because the upgrade only
//     fires when the client believes it is talking to api.anthropic.com.
//
// Only `display: "summarized"` asks for readable text, and the text Anthropic
// returns for that rides a separate `narration` channel rather than the
// thinking block -- across 1,839 transcripts on this machine, 33,351
// `thinking`-tagged blocks carried text zero times.
//
// So a third-party route that streams its model's reasoning into the thinking
// block shows the user something Claude never shows. Blanking it is not a
// cosmetic match: unfinished chain of thought is not written for a reader.
//
// `type: "enabled"` with `budget_tokens` is the pre-adaptive shape, where the
// caller may have asked for the reasoning itself, so only an explicit
// `omitted` or `updates` display touches it.

import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hidesThinkingText(thinking: unknown): boolean {
  if (!isRecord(thinking)) return false;
  if (thinking.type === 'disabled') return false;
  if (thinking.display === 'summarized') return false;
  if (thinking.display === 'omitted' || thinking.display === 'updates') return true;
  // Adaptive with an unset or unrecognised display: Anthropic's answer is an
  // empty block either way, so hiding fails towards Claude's behaviour.
  return thinking.type === 'adaptive';
}

/** A streaming or non-streaming Anthropic Message, narrowed to the fields read here. */
export function withoutThinkingText<T extends Record<string, unknown>>(message: T): T {
  const content = message.content;
  if (!Array.isArray(content)) return message;
  let changed = false;
  const blocks = content.map(block => {
    if (!isRecord(block) || block.type !== 'thinking' || !block.thinking) return block;
    changed = true;
    return { ...block, thinking: '' };
  });
  return changed ? { ...message, content: blocks } : message;
}

/**
 * An event-stream line ends with CRLF, LF, or a bare CR. Same split as
 * `anthropicSseModelRewrite`, for the same reason: splitting on \n alone finds
 * no boundary in a CR-framed stream, so every byte piles up in the tail buffer
 * until the upstream closes.
 */
const SSE_LINE_SPLIT = /(\r\n|\r|\n)/;

/**
 * How much of one event is held before it is relayed untouched. Every upstream
 * seen so far terminates each event, so this is a backstop against one that
 * does not: without it a stream that never emits a blank line grows this
 * buffer for as long as it runs. Well above any real event -- a thinking delta
 * is a few bytes and a tool-argument delta is orders of magnitude smaller than
 * this -- so exceeding it means the event is not something to hide.
 */
const MAX_BUFFERED_EVENT_CHARS = 1024 * 1024;

/** Two line endings with nothing between them: the blank line that ends an event. */
const BLANK_LINE = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/;

/** Longest a line terminator can be, so a split one is still recognised. */
const OVERFLOW_CARRY_CHARS = 3;

/**
 * The payload of a whole event. SSE allows one payload to be split over
 * consecutive `data:` lines and rejoined with newlines, and a line-at-a-time
 * parse fails on that legal framing. Failing open there is not neutral for this
 * transform: it is the case where reasoning the client asked to hide would be
 * relayed verbatim, so the lines are rejoined before the decision is made.
 * A payload that still does not parse is passed through.
 */
function eventPayload(lines: string[]): Record<string, unknown> | undefined {
  const payloads = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5));
  if (payloads.length === 0) return undefined;
  try {
    const parsed = JSON.parse(payloads.join('\n')) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isThinkingDelta(payload: Record<string, unknown>): boolean {
  const delta = payload.delta;
  return payload.type === 'content_block_delta'
    && isRecord(delta)
    && delta.type === 'thinking_delta';
}

/**
 * A `content_block_start` that carries the whole reasoning in its opening
 * block. These upstreams send an empty one and stream the text as deltas, so
 * this is defence against a backend that shapes the block differently.
 */
function isThinkingStart(payload: Record<string, unknown>): boolean {
  const block = payload.content_block;
  return payload.type === 'content_block_start'
    && isRecord(block)
    && block.type === 'thinking'
    && Boolean(block.thinking);
}

/**
 * Rewrite an event whose whole-event payload must change. Every line is kept
 * as it arrived except the `data:` lines, which collapse into one carrying the
 * replacement; a payload split over several `data:` lines is legal SSE and
 * rejoining it produces the same event.
 */
function rewritePayloadEvent(lines: SseLine[], payload: Record<string, unknown>): string {
  const block = payload.content_block as Record<string, unknown>;
  const replacement = `data: ${JSON.stringify({ ...payload, content_block: { ...block, thinking: '' } })}`;
  let out = '';
  let wrotePayload = false;
  for (const { text, ending } of lines) {
    if (!text.startsWith('data:')) {
      out += text + ending;
      continue;
    }
    if (wrotePayload) continue;
    wrotePayload = true;
    out += replacement + ending;
  }
  return out;
}

interface SseLine { text: string; ending: string }

/** Split one event into its lines, keeping each line's exact ending. */
function splitEvent(raw: string): SseLine[] {
  const parts = raw.split(SSE_LINE_SPLIT);
  const lines: SseLine[] = [];
  // `i < parts.length` rather than `i + 1 < parts.length`: a stream cut
  // mid-event leaves a final line with no ending, and skipping it would both
  // miss a thinking delta and emit the event's other lines as a data-less stub.
  for (let i = 0; i < parts.length; i += 2) lines.push({ text: parts[i]!, ending: parts[i + 1] ?? '' });
  return lines;
}

/**
 * One complete SSE event, terminator included, as the upstream wrote it, or ''
 * to remove it. The decision cannot be made from the `event:` field alone, and
 * the `event:` line is already read by the time its `data:` line arrives --
 * dropping only the data line would leave the client an event with no payload,
 * so an event is held until its blank line terminates it.
 */
function rewriteEvent(raw: string): string {
  const lines = splitEvent(raw);
  // One decision per event, from the whole payload. Deciding a line at a time
  // leaves a payload split over consecutive `data:` lines -- legal SSE --
  // unparsed and relayed verbatim, which is the reasoning this exists to hide.
  const payload = eventPayload(lines.map(line => line.text));
  if (!payload) return raw;
  if (isThinkingDelta(payload)) return '';
  if (isThinkingStart(payload)) return rewritePayloadEvent(lines, payload);
  return raw;
}

/**
 * Line-preserving SSE transform that removes the thinking text from a stream.
 * Every event that is not a thinking delta passes through byte-for-byte, with
 * its original line ending; a partial event is carried across chunks.
 */
export function anthropicSseThinkingDisplay(hide: boolean): Transform {
  if (!hide) {
    return new Transform({
      transform(chunk, _encoding, callback) { callback(null, chunk); },
    });
  }
  const decoder = new StringDecoder('utf8');
  let tail = '';
  let current = '';
  // Set while an event too large to hold is being relayed, so its bytes leave
  // as they arrive rather than being buffered.
  let overflowed = false;
  // The last few bytes of an overflowing event, held back only so a terminator
  // split across two chunks is still recognised as one.
  let carry = '';

  const handleLine = (line: string, ending: string): string => {
    current += line + ending;
    if (line) return '';
    const raw = current;
    current = '';
    return rewriteEvent(raw);
  };

  const consume = (parts: string[]): string => {
    let out = '';
    for (let i = 0; i + 1 < parts.length; i += 2) out += handleLine(parts[i]!, parts[i + 1]!);
    return out;
  };

  /** Parse one run of complete-or-partial SSE text through the normal path. */
  const feed = (text: string): string => {
    const buffered = tail + text;
    // A trailing CR may be the first half of a CRLF whose LF is still in the
    // next chunk. Treating it as a bare-CR ending would close a line that had
    // not ended, splitting an event in two and emitting its `event:` line
    // with the `data:` line that followed now travelling alone.
    const held = buffered.endsWith('\r') ? '\r' : '';
    const parts = (held ? buffered.slice(0, -1) : buffered).split(SSE_LINE_SPLIT);
    // The final element is the unterminated remainder of the last line.
    tail = (parts.pop() ?? '') + held;
    let out = consume(parts);
    // The cap covers everything held for this event. A single line longer than
    // the cap never reaches `handleLine`, so it has to be checked here too.
    if (tail.length + current.length > MAX_BUFFERED_EVENT_CHARS) {
      // The line ending that closed the oversized line is already in here, and
      // it is half of the blank line that will end the event. Hold it back, or
      // the overflow branch sees the second half alone, never matches a
      // terminator, and relays every later event unfiltered.
      const flushed = current + tail;
      const ending = /(?:\r\n|\r|\n)$/.exec(flushed)?.[0] ?? '';
      out += ending ? flushed.slice(0, -ending.length) : flushed;
      current = '';
      tail = '';
      carry = ending;
      overflowed = true;
    }
    return out;
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      let text = carry + decoder.write(chunk);
      carry = '';
      let out = '';
      if (overflowed) {
        const match = BLANK_LINE.exec(text);
        if (!match) {
          // Hold a couple of bytes back so a terminator split across chunks is
          // still seen whole. Missing it leaves this transform relaying every
          // later event unfiltered for the rest of the stream.
          carry = text.slice(-OVERFLOW_CARRY_CHARS);
          callback(null, text.slice(0, text.length - carry.length));
          return;
        }
        const boundary = match.index + match[0].length;
        out += text.slice(0, boundary);
        overflowed = false;
        // Anything after the terminator belongs to the next event and is
        // parsed normally rather than relayed with the oversized one.
        text = text.slice(boundary);
        if (!text) {
          callback(null, out);
          return;
        }
      }
      callback(null, out + feed(text));
    },
    flush(callback) {
      let out = carry;
      carry = '';
      const rest = tail + decoder.end();
      if (rest) {
        const parts = rest.split(SSE_LINE_SPLIT);
        const remainder = parts.length % 2 === 1 ? parts.pop()! : '';
        out += consume(parts);
        if (remainder) out += handleLine(remainder, '');
      }
      out += current ? rewriteEvent(current) : '';
      current = '';
      callback(null, out);
    },
  });
}
