import type { FullStreamPart } from './proxy-shared.js';

const SIGNATURE_PREFIX = 'clodex:openai-thinking:';
const SIGNATURE_V1 = `${SIGNATURE_PREFIX}v1:`;

interface ReasoningPart {
  itemId: string;
  text: string;
  encryptedContent?: string;
}

export function openAiReasoningItemId(part: FullStreamPart): string | undefined {
  const id = part.providerMetadata?.openai?.itemId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** One live display block; the original SDK parts survive independently of client display edits. */
export class OpenAiThinkingBlock {
  private readonly parts = new Map<string, ReasoningPart>();
  private hasText = false;

  /** `origin` names a provider whose ciphertext only it can decrypt; unset is OpenAI's own. */
  constructor(private readonly origin?: string) {}

  start(part: FullStreamPart): void {
    const itemId = openAiReasoningItemId(part);
    if (!itemId || !part.id) throw new Error('OpenAI reasoning part has no identity');
    if (!this.parts.has(part.id)) this.parts.set(part.id, { itemId, text: '' });
    this.end(part);
  }

  append(part: FullStreamPart): string {
    const entry = this.parts.get(part.id ?? '');
    if (!entry) throw new Error('OpenAI reasoning delta has no matching start');
    const text = part.text ?? '';
    if (!text) return '';
    const separator = entry.text.length === 0 && this.hasText ? '\n\n' : '';
    entry.text += text;
    this.hasText = true;
    return separator + text;
  }

  end(part: FullStreamPart): void {
    const entry = this.parts.get(part.id ?? '');
    const encrypted = part.providerMetadata?.openai?.reasoningEncryptedContent;
    if (entry && typeof encrypted === 'string' && encrypted) entry.encryptedContent = encrypted;
  }

  signature(): string {
    // JSON escapes lone surrogates, so request-wide Unicode sanitization cannot
    // change the originals inside this opaque string. Avoid base64-wrapping blobs
    // that are already encoded upstream.
    return SIGNATURE_V1 + JSON.stringify({
      parts: [...this.parts.values()],
      ...(this.origin ? { origin: this.origin } : {}),
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * undefined is a legacy/provider signature. An invalid owned envelope yields no reasoning:
 * never mistake our metadata for provider ciphertext, including on a model switch.
 */
export function restoreOpenAiThinking(
  text: string,
  signature: string | undefined,
  npm: string,
  origin?: string,
): Array<Record<string, unknown>> | undefined {
  if (!signature?.startsWith(SIGNATURE_PREFIX)) return undefined;
  if (!signature.startsWith(SIGNATURE_V1)) return [];
  try {
    const envelope: unknown = JSON.parse(signature.slice(SIGNATURE_V1.length));
    if (!isRecord(envelope) || !Array.isArray(envelope.parts) || envelope.parts.length === 0) return [];
    if (envelope.origin !== undefined && typeof envelope.origin !== 'string') return [];
    const parts: ReasoningPart[] = [];
    for (const part of envelope.parts) {
      if (!isRecord(part) || typeof part.itemId !== 'string' || !part.itemId
        || typeof part.text !== 'string'
        || (part.encryptedContent !== undefined && typeof part.encryptedContent !== 'string')) return [];
      parts.push(part as unknown as ReasoningPart);
    }
    // OpenCode Go answers 400 invalid_encrypted_content to ciphertext it did not
    // produce, and one such item fails every later turn of the conversation.
    if (npm !== '@ai-sdk/openai' || envelope.origin !== origin) return text ? [{ type: 'reasoning', text }] : [];
    return parts.map(part => ({
      type: 'reasoning', text: part.text,
      providerOptions: {
        openai: {
          itemId: part.itemId,
          ...(part.encryptedContent ? { reasoningEncryptedContent: part.encryptedContent } : {}),
        },
      },
    }));
  } catch {
    return [];
  }
}
