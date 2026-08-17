/**
 * Composer — one input, shared by both modes.
 *
 * It sits centred under the greeting while a conversation is empty and docks
 * to the bottom once the first message lands. The move is a FLIP so it slides
 * rather than teleports; that transition is the single most visible seam in
 * the layout if you skip it.
 *
 * There is deliberately no logo above the input, and Code mode says nothing
 * about which project is open — the sidebar already carries that.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Plus, Mic, ArrowUp, Square, Cpu, Hammer, Eye, ChevronDown, X, FileText, File as FileIcon } from 'lucide-react';

import { useApp, useCode } from '@/store';
import { cn } from '@/lib/utils';
import { formatSize, type Attachment } from '@/lib/chat/stream';
import { MODELS } from '@/lib/config';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type Props = {
  mode: 'chat' | 'code';
  docked: boolean;
  busy: boolean;
  disabled?: boolean;
  placeholder: string;
  attachments: Attachment[];
  onAttach: (files: FileList | File[]) => void;
  onRemoveAttachment: (index: number) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onModelChange?: (model: string) => void;
};

export function Composer({
  mode, docked, busy, disabled, placeholder,
  attachments, onAttach, onRemoveAttachment, onSend, onStop, onModelChange,
}: Props) {
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastTop = useRef<number | null>(null);
  const sendOnEnter = useApp((s) => s.sendOnEnter);
  const code = useCode();

  /* FLIP: measure before the layout change, invert after, then release. */
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    if (lastTop.current !== null && lastTop.current !== top) {
      const dy = lastTop.current - top;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = '';
        el.style.transform = '';
      });
    }
    lastTop.current = top;
  }, [docked]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  /**
   * Keep the caret in the box.
   *
   * Sending the first message swaps the centred composer for the docked one —
   * a different React element, so the old one unmounts and focus is lost with
   * it. Focusing on mount means the caret follows the composer down, and the
   * user can keep typing without clicking back into it.
   */
  useEffect(() => {
    if (!disabled) inputRef.current?.focus();
  }, [disabled]);

  const canSend = !busy && !disabled && (text.trim().length > 0 || attachments.length > 0);

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText('');
    inputRef.current?.focus();
  };

  /** Dictation drops the transcript into the box for review — never auto-sends. */
  const toggleVoice = () => {
    const SR = (window as unknown as {
      SpeechRecognition?: new () => never;
      webkitSpeechRecognition?: new () => never;
    });
    const Impl = SR.SpeechRecognition ?? SR.webkitSpeechRecognition;
    if (!Impl) {
      setRecording(false);
      return;
    }
    if (recording) { setRecording(false); return; }

    const rec = new Impl() as unknown as {
      lang: string; interimResults: boolean; continuous: boolean;
      start(): void; stop(): void;
      onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
      onend: (() => void) | null;
      onerror: (() => void) | null;
    };
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (e) => {
      let heard = '';
      for (let i = 0; i < e.results.length; i++) heard += e.results[i][0].transcript;
      setText((prev) => (prev ? `${prev} ${heard}` : heard));
      inputRef.current?.focus();
    };
    rec.onend = () => setRecording(false);
    rec.onerror = () => setRecording(false);
    rec.start();
    setRecording(true);
  };

  return (
    <div
      ref={boxRef}
      className="w-full rounded-[1.4rem] border border-[var(--border-hi)] bg-card p-3 pb-2.5 shadow-[0_10px_34px_rgba(0,0,0,0.34)] backdrop-blur-xl transition-[border-color,box-shadow,transform] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] focus-within:border-ring focus-within:shadow-[0_10px_34px_rgba(0,0,0,0.4),0_0_0_3px_rgba(124,58,237,0.14)]"
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-0.5 pb-2.5">
          {attachments.map((f, i) => (
            <div key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-xl border border-border bg-accent py-1 pr-2 pl-1.5 text-xs">
              {f.kind === 'image' ? (
                <img src={f.data} alt="" className="size-7 rounded-md object-cover" />
              ) : (
                <span className="grid size-7 place-items-center rounded-md bg-primary/20 text-purple-2">
                  {f.kind === 'pdf' ? <FileText className="size-3.5" /> : <FileIcon className="size-3.5" />}
                </span>
              )}
              <span className="max-w-[150px] truncate">{f.name}</span>
              <span className="text-[11px] text-dim">{formatSize(f.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => onRemoveAttachment(i)}
                className="grid place-items-center rounded p-0.5 text-dim transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={inputRef}
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          const send = sendOnEnter ? e.key === 'Enter' && !e.shiftKey : e.key === 'Enter' && e.ctrlKey;
          if (send) { e.preventDefault(); submit(); }
        }}
        className="max-h-[200px] w-full resize-none border-none bg-transparent px-1 pt-0.5 pb-1 text-[15px] leading-relaxed font-light outline-none placeholder:text-dim disabled:opacity-50"
      />

      <div className="flex items-center gap-1.5 pt-1.5">
        <button
          type="button"
          title="Attach files"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
          className="grid size-8.5 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-purple-2 disabled:opacity-40"
        >
          <Plus className="size-4" />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onAttach(e.target.files);
            e.target.value = '';
          }}
        />

        {/* Code mode only: the model picker and the plan/build toggle. */}
        {mode === 'code' && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger className="flex h-7.5 items-center gap-1.5 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:border-ring hover:text-foreground">
                <Cpu className="size-3" />
                <span className="max-w-[190px] truncate">{code.model}</span>
                <ChevronDown className="size-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="max-h-[380px] w-[360px] overflow-y-auto">
                <div className="mono-label px-2.5 py-2 text-dim">Model — free, tool-capable</div>
                {MODELS.map((m) => (
                  <DropdownMenuItem
                    key={m.id}
                    onClick={() => onModelChange?.(m.id)}
                    className="flex-col items-start gap-0.5"
                  >
                    <span className="flex w-full items-center gap-1.5">
                      {m.star && <span className="text-purple-2">★</span>}
                      <span className="truncate font-mono text-[12.5px]">{m.id}</span>
                      {m.id === code.model && <span className="ml-auto text-purple-2">✓</span>}
                    </span>
                    <span className="text-[11.5px] text-dim">{m.label}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <button
              type="button"
              onClick={() => code.setPlanMode(!code.planMode)}
              title={code.planMode
                ? 'Plan mode — reads and researches, will not edit or run anything'
                : 'Build mode — free to edit files and run commands'}
              className={cn(
                'flex h-7.5 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors',
                code.planMode
                  ? 'border-ring bg-primary/14 text-purple-3'
                  : 'border-border text-muted-foreground hover:border-ring hover:text-foreground',
              )}
            >
              {code.planMode ? <Eye className="size-3" /> : <Hammer className="size-3" />}
              {code.planMode ? 'Plan' : 'Build'}
            </button>
          </>
        )}

        <span className="flex-1" />

        <button
          type="button"
          title="Voice input"
          disabled={disabled}
          onClick={toggleVoice}
          className={cn(
            'grid size-8.5 place-items-center rounded-xl transition-colors disabled:opacity-40',
            recording
              ? 'animate-pulse bg-destructive/12 text-destructive'
              : 'text-muted-foreground hover:bg-accent hover:text-purple-2',
          )}
        >
          <Mic className="size-4" />
        </button>

        {busy ? (
          <button
            type="button"
            title="Stop"
            onClick={onStop}
            className="grid size-8.5 place-items-center rounded-full border border-[var(--border-hi)] text-foreground transition-colors hover:border-ring"
          >
            <Square className="size-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            title="Send"
            disabled={!canSend}
            onClick={submit}
            className="grid size-8.5 place-items-center rounded-full bg-[image:var(--gradient)] text-white transition-all hover:-translate-y-0.5 hover:shadow-[0_6px_16px_rgba(0,0,0,0.45)] disabled:cursor-default disabled:opacity-30 disabled:hover:translate-y-0 disabled:hover:shadow-none"
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
