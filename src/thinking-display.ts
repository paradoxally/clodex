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

/** The `data:` payload of a single line, or undefined when the line is not one. */
function dataPayload(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith('data:')) return undefined;
  try {
    const parsed = JSON.parse(line.slice(5)) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

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
function blankedThinkingStart(payload: Record<string, unknown>, ending: string): string | undefined {
  const block = payload.content_block;
  if (payload.type !== 'content_block_start' || !isRecord(block)) return undefined;
  if (block.type !== 'thinking' || !block.thinking) return undefined;
  return `data: ${JSON.stringify({ ...payload, content_block: { ...block, thinking: '' } })}${ending}`;
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
  const payload = eventPayload(lines.map(line => line.text));
  if (payload && isThinkingDelta(payload)) return '';
  let out = '';
  for (const { text, ending } of lines) {
    const linePayload = dataPayload(text);
    const blanked = linePayload && blankedThinkingStart(linePayload, ending);
    out += blanked ?? text + ending;
  }
  return out;
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

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const buffered = tail + decoder.write(chunk);
      // A trailing CR may be the first half of a CRLF whose LF is still in the
      // next chunk. Treating it as a bare-CR ending would close a line that had
      // not ended, splitting an event in two and emitting its `event:` line
      // with the `data:` line that followed now travelling alone.
      const held = buffered.endsWith('\r') ? '\r' : '';
      const parts = (held ? buffered.slice(0, -1) : buffered).split(SSE_LINE_SPLIT);
      // The final element is the unterminated remainder of the last line.
      tail = (parts.pop() ?? '') + held;
      callback(null, consume(parts));
    },
    flush(callback) {
      const rest = tail + decoder.end();
      let out = '';
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
