/**
 * ChatView — conversations with Simba AI.
 *
 * Markdown, maths and highlighting are applied once, when a reply finalises.
 * Never mid-stream: half of $$\frac{a}{b}$$ is not valid TeX and would thrash
 * on every frame, which is exactly the bug the web app had to fix.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Check, AlertCircle, FileText, Download } from 'lucide-react';
import { toast } from 'sonner';

import { useApp, useChat, uid } from '@/store';
import { renderMarkdown, enhanceCodeBlocks } from '@/lib/chat/markdown';
import { renderFences } from '@/lib/chat/fences';
import { downloadDocx, docxCardTitle } from '@/lib/chat/docx';
import { generateResponse, processFile, type Attachment, type ChatMessage } from '@/lib/chat/stream';
import { CHAT_SUGGESTIONS, SUBLINES, greetingFor, timeBand } from '@/lib/config';
import { Composer } from './Composer';
import { cn } from '@/lib/utils';

/** Chosen once per launch, not per keystroke — a line that reshuffles as you
    type reads as a glitch. */
const SUBLINE = (() => {
  const pool = SUBLINES[timeBand()];
  return pool[Math.floor(Math.random() * pool.length)];
})();

/**
 * Swap a ```docx fence for a download card.
 *
 * The body is deliberately not rendered as prose as well — when the user asks
 * for a Word file, the chat should offer the file, not duplicate it. The
 * markdown is stashed via the DOM API rather than round-tripped through
 * innerHTML, so model text is never re-parsed as markup.
 */
function renderDocxCards(root: HTMLElement) {
  root.querySelectorAll('pre code').forEach((code) => {
    if (!/language-docx/i.test(code.className)) return;
    const pre = code.closest('pre');
    const block = pre?.closest('.code-block') ?? pre;
    if (!block) return;

    const source = code.textContent ?? '';
    const title = docxCardTitle(source) || 'Document';

    const card = document.createElement('div');
    card.className =
      'my-4 flex items-center gap-3 rounded-2xl border border-border bg-card p-4 backdrop-blur-xl';

    const icon = document.createElement('span');
    icon.className = 'grid size-10 shrink-0 place-items-center rounded-xl bg-primary/18 text-purple-2 text-lg';
    icon.textContent = '📄';

    const stack = document.createElement('div');
    stack.className = 'min-w-0 flex-1';
    const name = document.createElement('div');
    name.className = 'truncate text-[13.5px]';
    name.textContent = title;                      // textContent, never innerHTML
    const kind = document.createElement('div');
    kind.className = 'mono-label text-dim';
    kind.textContent = 'Word document';
    stack.append(name, kind);

    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      'flex shrink-0 items-center gap-1.5 rounded-full bg-[image:var(--gradient)] px-4 py-2 text-xs text-white transition-transform hover:-translate-y-0.5';
    button.textContent = 'Download';
    button.addEventListener('click', async () => {
      button.textContent = 'Building…';
      try {
        await downloadDocx(source, title, root);
        button.textContent = 'Downloaded';
      } catch {
        button.textContent = 'Failed';
      }
      setTimeout(() => { button.textContent = 'Download'; }, 1800);
    });

    card.append(icon, stack, button);
    block.replaceWith(card);
  });
}

function Rendered({ markdown }: { markdown: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = renderMarkdown(markdown);

  // No dependency array on purpose. These passes mutate DOM that React owns,
  // so a re-render elsewhere can wipe a rendered chart while `html` stays
  // identical — meaning a [html]-keyed effect would never restore it. All
  // three passes are idempotent (each skips blocks it has already claimed),
  // so running after every render is both safe and self-healing.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    // Order matters: charts and graphs claim their <pre> before the code-block
    // wrapper can, so a chart never ends up with a "Copy" header.
    renderFences(root).catch(() => { /* a bad fence stays a code block */ });
    enhanceCodeBlocks(root, (text) => navigator.clipboard.writeText(text));
    renderDocxCards(root);
  });

  return <div ref={ref} className="prose-simba" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Bubble({ message, title }: { message: ChatMessage; title: string }) {
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

  if (message.role === 'user') {
    return (
      <div className="mb-7 flex animate-in justify-end fade-in slide-in-from-bottom-2 duration-300">
        <div className="max-w-[88%] rounded-[1.2rem] border border-border bg-card px-4 py-3 text-[14.5px] leading-relaxed whitespace-pre-wrap backdrop-blur-xl">
          {message.content}
          {!!message.attachments?.length && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {message.attachments.map((f, i) =>
                f.kind === 'image' ? (
                  <img key={i} src={f.data} alt="" className="size-14 rounded-lg object-cover" />
                ) : (
                  <span key={i} className="rounded-lg bg-primary/20 px-2 py-1 text-[11px] text-purple-2">
                    {f.name}
                  </span>
                ),
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={hostRef} className="mb-7 animate-in fade-in slide-in-from-bottom-2 duration-300">
      {message.error ? (
        <div className="flex gap-3 rounded-2xl border border-destructive/30 bg-destructive/8 p-4">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="text-[13.5px] leading-relaxed">
            <p className="mb-1 font-medium text-foreground">That turn did not go through.</p>
            <p className="text-muted-foreground">{message.error}</p>
          </div>
        </div>
      ) : (
        <>
          <Rendered markdown={message.content} />
          <div className="mt-3 flex gap-0.5">
            <button
              type="button"
              title="Copy"
              onClick={() => {
                navigator.clipboard.writeText(message.content);
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }}
              className="grid size-7 place-items-center rounded-lg text-dim transition-colors hover:bg-accent hover:text-purple-2"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
            <button
              type="button"
              title="Export to Word"
              disabled={exporting}
              onClick={async () => {
                setExporting(true);
                try {
                  // Charts already on screen are captured as images, so the
                  // document carries the picture rather than its JSON.
                  await downloadDocx(message.content, title, hostRef.current);
                } catch (err) {
                  toast(`Word export failed: ${err instanceof Error ? err.message : String(err)}`);
                } finally {
                  setExporting(false);
                }
              }}
              className="grid size-7 place-items-center rounded-lg text-dim transition-colors hover:bg-accent hover:text-purple-2 disabled:opacity-40"
            >
              {exporting ? <Download className="size-3.5 animate-pulse" /> : <FileText className="size-3.5" />}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function ChatView() {
  const chat = useChat();
  const userName = useApp((s) => s.userName);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const current = chat.chats.find((c) => c.id === chat.currentId) ?? null;
  const messages = current?.messages ?? [];
  const empty = messages.length === 0;

  const nearBottom = () => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  };

  const scrollDown = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  useEffect(() => { scrollDown(); }, [chat.currentId]);
  useEffect(() => { if (nearBottom()) scrollDown(); }, [messages.length, chat.streaming]);

  const attach = async (files: FileList | File[]) => {
    const list = Array.from(files);
    const processed = await Promise.all(list.map(processFile));
    setAttachments((prev) => [...prev, ...processed]);
  };

  const send = async (text: string) => {
    const outgoing: ChatMessage = {
      id: uid(),
      role: 'user',
      content: text || '(files attached)',
      attachments: attachments.length ? attachments : undefined,
    };
    setAttachments([]);
    chat.addMessage(outgoing);
    chat.setBusy(true);
    chat.setStreaming('');
    chat.setStatusNote(null);

    const history = [...(useChat.getState().current()?.messages ?? [])];
    const controller = new AbortController();
    abortRef.current = controller;

    let acc = '';
    try {
      const full = await generateResponse(history, {
        signal: controller.signal,
        onAttempt: (note) => chat.setStatusNote(note),
        onToken: (delta) => {
          acc += delta;
          chat.setStreaming(acc);
          if (nearBottom()) scrollDown();
        },
      });
      chat.addMessage({ id: uid(), role: 'assistant', content: full });
    } catch (err) {
      if (controller.signal.aborted) {
        if (acc.trim()) chat.addMessage({ id: uid(), role: 'assistant', content: acc });
      } else {
        chat.addMessage({
          id: uid(),
          role: 'assistant',
          content: '',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      abortRef.current = null;
      chat.setBusy(false);
      chat.setStreaming(null);
      chat.setStatusNote(null);
    }
  };

  const greeting = greetingFor(timeBand());

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className={cn('mx-auto flex w-full max-w-[780px] flex-1 flex-col px-8', empty && 'justify-center')}>
          {empty ? (
            <>
              {/* No logo here, by design — the sidebar carries the mark. */}
              <div className="pb-7 text-center">
                <h1 className="mb-2.5 font-heading text-[clamp(1.7rem,3.4vw,2.15rem)] leading-tight font-bold">
                  {greeting}
                  {userName.trim() && (
                    <>
                      ,{' '}
                      <span className="bg-[linear-gradient(135deg,var(--purple-3),var(--indigo-2))] bg-clip-text text-transparent">
                        {userName.trim()}
                      </span>
                    </>
                  )}
                </h1>
                <p className="text-[15px] text-muted-foreground">{SUBLINE}</p>
              </div>

              <Composer
                mode="chat"
                docked={false}
                busy={chat.busy}
                placeholder="How can Simba help?"
                attachments={attachments}
                onAttach={attach}
                onRemoveAttachment={(i) => setAttachments((a) => a.filter((_, n) => n !== i))}
                onSend={send}
                onStop={() => abortRef.current?.abort()}
              />

              <div className="flex flex-wrap justify-center gap-2.5 pt-5">
                {CHAT_SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    className="rounded-full border border-border bg-card px-4 py-2 text-[12.5px] text-muted-foreground backdrop-blur-xl transition-all duration-300 hover:-translate-y-1 hover:border-ring hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="pt-6 pb-2">
              {messages.map((m) => (
                <Bubble key={m.id} message={m} title={current?.title ?? 'Simba chat'} />
              ))}

              {chat.streaming !== null && (
                <div className="mb-7">
                  {chat.streaming ? (
                    <div className="text-[15px] leading-relaxed whitespace-pre-wrap">
                      {chat.streaming}
                      <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-purple-2 align-text-bottom" />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-[13.5px] text-muted-foreground">
                      <span className="size-1.5 animate-pulse rounded-full bg-purple-2" />
                      {chat.statusNote ?? 'Thinking…'}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {!empty && (
        <div className="px-8 pt-1.5 pb-6">
          <div className="mx-auto w-full max-w-[780px]">
            <Composer
              mode="chat"
              docked
              busy={chat.busy}
              placeholder="How can Simba help?"
              attachments={attachments}
              onAttach={attach}
              onRemoveAttachment={(i) => setAttachments((a) => a.filter((_, n) => n !== i))}
              onSend={send}
              onStop={() => { abortRef.current?.abort(); toast('Stopped'); }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
