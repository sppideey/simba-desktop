/**
 * stream.ts — the only file in chat mode that talks to OpenRouter.
 *
 * Ported from Simba AI/deploy/index.html. Three behaviours are load-bearing
 * and must survive any refactor:
 *
 *   1. A mid-stream failure arrives INSIDE a 200 response as
 *      `data: {"error":…}` — the `response.ok` check never sees it. The parse
 *      loop throws on frame.error so the key-fallthrough still runs.
 *   2. Vision is a list, not a constant. Free endpoints share an upstream pool,
 *      so the 31B returns bursts of 429 that have nothing to do with our quota.
 *      Models × keys are flattened into one attempt list.
 *   3. OpenRouter emits `: OPENROUTER PROCESSING` comment lines while queued.
 *      Any line not starting with `data:` is skipped.
 */

import {
  CHAT_KEYS, OPENROUTER_URL, TEXT_MODEL, VISION_MODELS, MAX_TOKENS, MAX_CONTINUATIONS, IMAGE_MAX_EDGE,
} from '../config';
import { SYSTEM_INSTRUCTION } from './prompt';

export type Attachment = {
  name: string;
  size: number;
  kind: 'image' | 'pdf' | 'text';
  /** data: URL for images, extracted text for everything else */
  data: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
  error?: string;
};

/** Some providers ignore `reasoning: {enabled:false}`; never render raw output. */
export function stripThinking(text: string): string {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trimStart();
}

/** Re-inject attachment content so follow-up questions about a PDF still work. */
function buildFilePrompt(files: Attachment[] | undefined, message: string): string {
  if (!files?.length) return message;
  const textual = files.filter((f) => f.kind !== 'image');
  if (!textual.length) return message;
  const blocks = textual
    .map((f) => `--- FILE: ${f.name} ---\n${f.data}\n--- END FILE ---`)
    .join('\n\n');
  return `${blocks}\n\n${message}`;
}

type WireMessage =
  | { role: 'system' | 'assistant'; content: string }
  | { role: 'user'; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> };

function toWire(history: ChatMessage[]): { messages: WireMessage[]; hasImages: boolean } {
  const messages: WireMessage[] = [{ role: 'system', content: SYSTEM_INSTRUCTION }];
  let hasImages = false;

  for (const m of history) {
    if (m.role === 'assistant') {
      messages.push({ role: 'assistant', content: m.content });
      continue;
    }
    const images = (m.attachments ?? []).filter((f) => f.kind === 'image');
    const text = buildFilePrompt(m.attachments, m.content);
    if (images.length) {
      hasImages = true;
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text },
          ...images.map((f) => ({ type: 'image_url', image_url: { url: f.data } })),
        ],
      });
    } else {
      messages.push({ role: 'user', content: text });
    }
  }
  return { messages, hasImages };
}

type StreamOptions = {
  onToken: (delta: string) => void;
  signal?: AbortSignal;
  onAttempt?: (note: string) => void;
};

/** One request against one key and one model. Throws so the caller can fall through. */
async function callOnce(
  key: string,
  model: string,
  messages: WireMessage[],
  { onToken, signal }: StreamOptions,
): Promise<{ text: string; truncated: boolean }> {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': 'https://simba.omdixit.dev',
      'X-Title': 'Simba Desktop',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      max_tokens: MAX_TOKENS,
      temperature: 0.9,
      reasoning: { enabled: false },
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`HTTP ${response.status} ${body.slice(0, 200)}`);
    (err as Error & { status?: number }).status = response.status;
    throw err;
  }
  if (!response.body) throw new Error('The response carried no body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let finishReason: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      // ": OPENROUTER PROCESSING" and other comments are skipped.
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;

      let frame: {
        error?: { message?: string; code?: number };
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      };
      try {
        frame = JSON.parse(payload);
      } catch {
        continue; // a split frame; the tail is still in `buffer`
      }

      // A mid-stream failure arrives inside a 200. Throwing here is what keeps
      // the key-fallthrough working — do not soften this to a `return`.
      if (frame.error) {
        const err = new Error(frame.error.message ?? 'The provider failed mid-stream.');
        (err as Error & { status?: number }).status = frame.error.code ?? 500;
        throw err;
      }

      // "length" means the provider cut the reply at its output cap, not that
      // the thought finished. Recorded so the caller can ask for the rest.
      const reason = frame.choices?.[0]?.finish_reason;
      if (reason) finishReason = reason;

      const delta = frame.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onToken(delta);
      }
    }
  }

  return { text: full, truncated: finishReason === 'length' };
}

/**
 * Send a conversation and stream the reply.
 *
 * Models × keys are flattened into one attempt list, so a 429 walks to the
 * next key, then to the next model, before the turn is given up.
 */
export async function generateResponse(
  history: ChatMessage[],
  options: StreamOptions,
): Promise<string> {
  if (!CHAT_KEYS.length) {
    throw new Error('Chat is not configured — no credentials were built into this app.');
  }

  const { messages, hasImages } = toWire(history);
  const models = hasImages ? VISION_MODELS : [TEXT_MODEL];

  const attempts: Array<{ key: string; model: string }> = [];
  for (const model of models) for (const key of CHAT_KEYS) attempts.push({ key, model });

  let lastError: unknown;
  let emitted = 0;

  for (let i = 0; i < attempts.length; i++) {
    const { key, model } = attempts[i];
    try {
      const first = await callOnce(key, model, messages, {
        ...options,
        onToken: (d) => { emitted += d.length; options.onToken(d); },
      });

      /**
       * Carry on where the provider cut it off.
       *
       * A long answer hits the output cap mid-sentence, and the user is handed
       * half a reply with no sign there was more of it. Asking for the rest and
       * streaming it straight on is the difference between an app that "stops
       * in the middle" and one that finishes the thought.
       *
       * Three continuations covers any answer worth reading; past that the
       * model is rambling and stopping is the kinder outcome.
       */
      let text = first.text;
      let truncated = first.truncated;

      for (let carry = 0; truncated && carry < MAX_CONTINUATIONS; carry++) {
        options.onAttempt?.('continuing…');
        const next = await callOnce(
          key,
          model,
          [
            ...messages,
            { role: 'assistant', content: text },
            {
              role: 'user',
              content:
                'Your reply stopped at the output limit, mid-sentence. Continue from exactly '
                + 'where it broke off. Do not repeat any of it, do not start again, and do not '
                + 'add a preface — just carry on.',
            },
          ],
          {
            ...options,
            // A continuation usually resumes mid-word, so no separator is added.
            onToken: (d) => { emitted += d.length; options.onToken(d); },
          },
        );
        text += next.text;
        truncated = next.truncated;
      }

      return text;
    } catch (err) {
      if (options.signal?.aborted) throw err;
      lastError = err;
      // Half a reply is already on screen — repeating it would be worse than
      // stopping, so only silent failures fall through.
      if (emitted > 0) throw err;
      if (i < attempts.length - 1) {
        options.onAttempt?.(
          attempts[i + 1].model === model
            ? 'busy — trying another key'
            : `busy — falling back to ${attempts[i + 1].model.split('/')[1]}`,
        );
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Every model and key was busy. Try again in a moment.');
}

/* ------------------------------------------------------------------ files */

/** A 2400x1600 PNG drops ~88% at this edge. Never send a full-res photo. */
export function downscaleImage(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.width, img.height));
      if (scale === 1) return resolve(dataUrl);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(dataUrl);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export async function processFile(file: File): Promise<Attachment> {
  const isImage = file.type.startsWith('image/');
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

  if (isImage) {
    const raw = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    return { name: file.name, size: file.size, kind: 'image', data: await downscaleImage(raw) };
  }

  if (isPdf) {
    return {
      name: file.name,
      size: file.size,
      kind: 'pdf',
      data: '[PDF text extraction is not wired up yet — ask about the file by name.]',
    };
  }

  const text = await file.text();
  return { name: file.name, size: file.size, kind: 'text', data: text.slice(0, 40_000) };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
