/**
 * CodeView — the agent, rendered.
 *
 * Every row here corresponds to a method the agent already calls on its UI
 * object, so nothing is invented: tool calls, results, diffs, command output,
 * approvals and errors all arrive as events from sidecar/rpc-ui.js.
 *
 * The empty state deliberately does not name the open project — the sidebar
 * carries that — and there is no logo above the composer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  FolderSearch, AlertCircle, Download, Sparkles, ShieldAlert, ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';

import { useApp, useCode, uid, type TranscriptItem } from '@/store';
import {
  agent, startAgent, stopAgent, nodeVersion, type AgentEvent,
} from '@/lib/agent/client';
import { renderMarkdown, enhanceCodeBlocks } from '@/lib/chat/markdown';
import { CODE_SUGGESTIONS, SUBLINES, greetingFor, timeBand } from '@/lib/config';
import { Composer } from './Composer';
import { cn } from '@/lib/utils';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const SUBLINE = (() => {
  const pool = SUBLINES[timeBand()];
  return pool[Math.floor(Math.random() * pool.length)];
})();

/* ------------------------------------------------------------------ rows */

/**
 * A diff, in the shape Claude Code uses: a dim line-number gutter, then the
 * sign and the code tinted across the whole row, so the shape of the edit
 * reads at a glance rather than as two loose coloured strings.
 *
 * The tints are the agent's own, from tui.js, so the terminal and the desktop
 * show the same change the same way.
 */
function Diff({ lines }: { lines: string[] }) {
  // A count says more at a glance than counting rows does.
  const added = lines.filter((l) => l.startsWith('+') && /^\+\d+\|/.test(l)).length;
  const removed = lines.filter((l) => l.startsWith('-') && /^-\d+\|/.test(l)).length;

  return (
    <div className="my-2 ml-[17px]">
      <div className="mb-1 flex gap-2.5 font-mono text-[11px]">
        {added > 0 && <span style={{ color: 'var(--added-fg)' }}>+{added}</span>}
        {removed > 0 && <span style={{ color: 'var(--removed-fg)' }}>−{removed}</span>}
      </div>
      <DiffBody lines={lines} />
    </div>
  );
}

function DiffBody({ lines }: { lines: string[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border font-mono text-[11.5px] leading-[1.6]">
      {lines.map((raw, i) => {
        const added = raw.startsWith('+');
        const rest = raw.slice(1);
        const m = /^(\d+)\|\s?([\s\S]*)$/.exec(rest);

        // The trailing "… 12 more lines" note has no line number and is not
        // part of the change, so it stays untinted.
        if (!m) {
          return (
            <div key={i} className="flex">
              <span className="w-11 shrink-0" />
              <span className="flex-1 px-2.5 py-px text-dim opacity-70">{rest}</span>
            </div>
          );
        }
        return (
          <div key={i} className="flex">
            <span className="w-11 shrink-0 py-px pr-2 text-right text-dim opacity-60 select-none">
              {m[1]}
            </span>
            <span
              className="flex-1 overflow-x-auto px-2.5 py-px whitespace-pre"
              style={{
                background: added ? 'var(--added-bg)' : 'var(--removed-bg)',
                color: added ? 'var(--added-fg)' : 'var(--removed-fg)',
              }}
            >
              <span className="select-none opacity-70">{added ? '+' : '-'} </span>
              {m[2]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = renderMarkdown(text);
  useEffect(() => {
    if (ref.current) enhanceCodeBlocks(ref.current, (t) => navigator.clipboard.writeText(t));
  }, [html]);
  return <div ref={ref} className="prose-simba my-3" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A run of consecutive tool calls, collapsed into one line. */
type ToolGroup = { kind: 'tools'; id: string; items: Extract<TranscriptItem, { kind: 'tool' }>[] };
type Renderable = TranscriptItem | ToolGroup;

const READ_LABEL = /^(Reading|Listing|Finding)\b/;

/** "Read 4 files", "Ran 3 commands", "Made 5 edits" — what the run actually was. */
function describeRun(items: Extract<TranscriptItem, { kind: 'tool' }>[]): string {
  const n = items.length;
  const every = (re: RegExp) => items.every((t) => re.test(t.label));
  if (every(READ_LABEL)) return `Read ${n} files`;
  if (every(/^(Running|Executing)\b/)) return `Ran ${n} commands`;
  if (every(/^(Writing|Editing|Creating)\b/)) return `Made ${n} edits`;
  return `${n} steps`;
}

/**
 * Collapse runs of two or more consecutive tool calls.
 *
 * A long job is mostly the same action repeated, and listing every one buries
 * the rows that matter — the edits, the test run, the answer. One line with a
 * count reads at a glance and opens if you want the detail.
 *
 * A failed call always breaks the run and stays visible on its own: hiding a
 * failure inside a tally is the one thing grouping must never do.
 */
function groupTools(items: TranscriptItem[]): Renderable[] {
  const out: Renderable[] = [];
  let run: Extract<TranscriptItem, { kind: 'tool' }>[] = [];

  const flush = () => {
    if (run.length >= 2) out.push({ kind: 'tools', id: run[0].id, items: run });
    else out.push(...run);
    run = [];
  };

  for (const item of items) {
    if (item.kind === 'tool' && !item.failed) {
      run.push(item);
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}

/** Collapsed run: one quiet line, expandable to the individual steps. */
function ToolGroupRow({ group }: { group: ToolGroup }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-left text-[12px] text-dim opacity-70 transition-opacity hover:opacity-100"
      >
        <span>{describeRun(group.items)}</span>
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="mt-1 border-l border-border pl-3">
          {group.items.map((t) => (
            <div key={t.id} className="text-[11.5px] text-dim opacity-70">
              {stripTrailingStop(t.label)}
              {t.summary && <span className="opacity-60"> · {stripTrailingStop(t.summary)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The agent ends some labels with a full stop; a list item should not. */
function stripTrailingStop(text: string): string {
  return String(text ?? '').trim().replace(/\.$/, '');
}

function Row({ item }: { item: Renderable }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="mb-4 flex justify-end">
          <div className="max-w-full rounded-[1.2rem] border border-border bg-card px-4 py-3 text-[14.5px] leading-relaxed whitespace-pre-wrap">
            {item.text}
          </div>
        </div>
      );

    case 'tools':
      return <ToolGroupRow group={item} />;

    // Narration and thinking are context, not content: small and faint enough
    // to skim past, so the eye lands on what the agent did rather than on what
    // it said about doing it.
    case 'narrate':
      return <div className="mb-0.5 pl-0.5 text-[11.5px] text-dim opacity-45">{item.text}</div>;

    case 'thought':
      return (
        <div className="mb-0.5 pl-0.5 text-[11.5px] text-dim italic opacity-40">
          Thought for {item.seconds}s
        </div>
      );

    // No leading bullet and no trailing full stop — this is a log line, not
    // a sentence, and the punctuation reads as clutter at this size.
    case 'tool':
      return (
        <div className="mb-1">
          <div
            className={cn(
              'text-[12px]',
              item.failed ? 'text-destructive' : 'text-dim opacity-70',
            )}
          >
            {stripTrailingStop(item.label)}
          </div>
          {item.summary !== undefined && (
            <div
              className={cn(
                'pl-3 text-[11.5px]',
                item.failed ? 'text-destructive' : 'text-dim opacity-55',
              )}
            >
              {stripTrailingStop(item.summary)}
            </div>
          )}
        </div>
      );

    case 'diff':
      return <Diff lines={item.lines} />;

    case 'output':
      return (
        <div className="mb-2 pl-[17px]">
          {item.lines.map((l, i) => (
            <div key={i} className="font-mono text-[11.5px] whitespace-pre-wrap text-dim opacity-80">{l}</div>
          ))}
        </div>
      );

    case 'note':
      return <div className="mb-0.5 pl-0.5 text-[11.5px] text-dim opacity-45">{item.text}</div>;

    case 'assistant':
      return <Markdown text={item.text} />;

    case 'error':
      return (
        <div className="my-3 flex gap-3 rounded-2xl border border-destructive/30 bg-destructive/8 p-4">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="text-[13.5px] leading-relaxed">
            <p className="mb-1 font-medium">Failed while {item.attempted}.</p>
            <p className="text-muted-foreground">{item.failed}</p>
            {item.fix && <p className="mt-1.5 text-purple-2">→ {item.fix}</p>}
          </div>
        </div>
      );
  }
}

/**
 * Why the composer will not send yet.
 *
 * Shown under the box rather than by disabling it: the user can still type,
 * and a specific reason beats an input that silently does nothing.
 */
function AgentStatus() {
  const running = useCode((s) => s.running);
  const node = useCode((s) => s.nodeVersion);
  if (running) return null;

  const reason = node === null
    ? 'Node.js was not found. Code mode runs the agent as a Node process — install Node 22 or newer and reopen this project.'
    : 'Starting the agent…';

  return (
    <p className="pt-2.5 text-center text-[12px] text-dim">
      {node === null && <span className="text-destructive">Can’t run here. </span>}
      {reason}
    </p>
  );
}

/**
 * Seconds since the turn began.
 *
 * The label can sit unchanged for a minute on a slow free endpoint, so the
 * count is the proof the app is still alive rather than hung.
 */
function Elapsed() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  if (seconds < 2) return null;
  return <span className="ml-auto shrink-0 font-mono text-[11px] text-dim">{seconds}s</span>;
}

/* ------------------------------------------------------------------ view */

export function CodeView() {
  const code = useCode();
  const userName = useApp((s) => s.userName);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [streamed, setStreamed] = useState('');
  const project = code.projects.find((p) => p.id === code.currentId) ?? null;

  const scrollDown = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  useEffect(() => { scrollDown(); }, [code.transcript.length, streamed]);

  useEffect(() => {
    nodeVersion().then((v) => code.setNodeVersion(v));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Translate one agent event into transcript state. */
  const handle = useCallback((e: AgentEvent) => {
    const store = useCode.getState();
    switch (e.type) {
      case 'ready': {
        // The agent boots on its own default (north-mini-code). Taking that as
        // the truth threw away the user's stored choice on every reconnect —
        // and left Code mode on a slower model than the one the chip promised.
        // Our preference wins; the agent is told about it.
        const wanted = store.model || e.model;
        store.setReady({ check: e.check, skills: e.skills, model: wanted });
        if (wanted !== e.model) agent.setModel(wanted);
        break;
      }
      case 'turn_begin': store.setBusy(true); store.setStopped(null); break;
      case 'turn_end':
        store.setBusy(false);
        store.setStatus(null);
        store.setContextPercent(Math.round(e.context?.percent ?? 0));
        // A turn that ended because it ran out of steps, or threw, is not a
        // finished job — say so and offer to carry on.
        store.setStopped(e.stopped ?? null);
        break;
      // The agent's one-line account of what it is about to do. It is both a
      // transcript row and the live line — this is the "text by the AI" that
      // makes a long wait legible, rather than a generic spinner label.
      case 'narrate':
        store.push({ kind: 'narrate', id: uid(), text: e.text });
        store.setStatus(e.text);
        break;
      case 'tool_call': store.push({ kind: 'tool', id: uid(), label: e.label }); break;
      case 'tool_result': store.patchLastTool({ summary: e.summary }); break;
      case 'tool_failed': store.patchLastTool({ summary: e.summary, failed: true }); break;
      case 'diff': store.push({ kind: 'diff', id: uid(), lines: e.lines }); break;
      case 'command_output': store.push({ kind: 'output', id: uid(), lines: e.lines }); break;
      case 'assistant': store.push({ kind: 'assistant', id: uid(), text: e.text }); break;
      case 'note': store.push({ kind: 'note', id: uid(), text: e.text }); break;
      case 'reasoning_end':
        if (e.seconds >= 2) store.push({ kind: 'thought', id: uid(), seconds: e.seconds });
        break;
      case 'stream_begin': setStreamed(''); break;
      case 'stream_delta': setStreamed((s) => s + e.delta); break;
      case 'stream_end':
        setStreamed('');
        if (e.text.trim() && !e.asStatus) store.push({ kind: 'assistant', id: uid(), text: e.text });
        else if (e.text.trim()) store.push({ kind: 'narrate', id: uid(), text: e.text });
        break;
      // Only the agent's own words reach the live line. Raw command output
      // arrives as 'working', which means "still moving" and nothing more.
      case 'busy':
      case 'status': store.setStatus(e.text); break;
      case 'working': break;
      case 'idle': store.setStatus(null); break;
      case 'confirm_request':
        store.setConfirm({ id: e.id, action: e.action, detail: e.detail, risk: e.risk });
        break;
      case 'model_changed': store.setModel(e.model); break;
      case 'error':
        store.push({ kind: 'error', id: uid(), attempted: e.attempted, failed: e.failed, fix: e.fix });
        store.setBusy(false);
        break;
      case 'stderr':
        if (/Error|error|Cannot find/.test(e.text)) {
          store.push({ kind: 'error', id: uid(), attempted: 'starting the agent', failed: e.text });
        }
        break;
      default: break;
    }
  }, []);

  /** Start (or restart) the sidecar whenever the open project changes. */
  useEffect(() => {
    if (!project) { stopAgent(); code.setRunning(false); return; }
    let cancelled = false;
    code.clearTranscript();
    startAgent(project.path, (e) => { if (!cancelled) handle(e); })
      .then(() => agent.setMode(code.planMode ? 'plan' : 'build'))
      .catch((err) => {
        useCode.getState().push({
          kind: 'error', id: uid(),
          attempted: 'starting the agent',
          failed: String(err),
          fix: 'Code mode needs Node.js 22 or newer on this machine.',
        });
      });
    return () => { cancelled = true; stopAgent(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.path]);

  useEffect(() => {
    if (code.running) agent.setMode(code.planMode ? 'plan' : 'build');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code.planMode]);

  const chooseFolder = async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: 'Choose a project folder',
    });
    if (typeof picked !== 'string') return;
    const name = picked.split(/[\\/]/).filter(Boolean).pop() ?? picked;
    code.addProject(picked, name);
  };

  /**
   * Slash commands, handled here rather than sent to the model.
   *
   * The CLI has them and muscle memory expects them; typing /clear and getting
   * a confused paragraph back is worse than not having them at all.
   */
  const COMMANDS: Record<string, { hint: string; run: () => void }> = {
    '/new': { hint: 'start a fresh session', run: () => { code.clearTranscript(); agent.newSession(); } },
    '/clear': { hint: 'clear the screen, keep the session', run: () => code.clearTranscript() },
    '/plan': { hint: 'read-only mode', run: () => code.setPlanMode(true) },
    '/build': { hint: 'allow edits and commands', run: () => code.setPlanMode(false) },
    '/skills': {
      hint: 'list what Simba can load',
      run: () => code.push({
        kind: 'note', id: uid(),
        text: code.skills.length
          ? `Skills: ${code.skills.map((s) => s.name).join(', ')}`
          : 'No skills found for this project.',
      }),
    },
    '/model': {
      hint: 'show the current model',
      run: () => code.push({ kind: 'note', id: uid(), text: `Model: ${code.model}` }),
    },
    '/stop': { hint: 'interrupt the current turn', run: () => agent.abort() },
    '/help': {
      hint: 'this list',
      run: () => code.push({
        kind: 'note', id: uid(),
        text: Object.entries(COMMANDS).map(([k, v]) => `${k} — ${v.hint}`).join('\n'),
      }),
    },
  };

  const send = (text: string) => {
    const command = text.trim().split(/\s+/)[0].toLowerCase();
    if (COMMANDS[command]) {
      code.push({ kind: 'user', id: uid(), text });
      COMMANDS[command].run();
      return;
    }
    code.push({ kind: 'user', id: uid(), text });
    code.setBusy(true);
    code.setStopped(null);
    agent.message(text);
  };

  const empty = code.transcript.length === 0;
  const greeting = greetingFor(timeBand());

  /* ---------------------------------------------------- no project open */

  if (!project) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
        <h1 className="mb-2.5 font-heading text-[clamp(1.7rem,3.4vw,2.15rem)] font-bold">
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
        <p className="mb-7 max-w-md text-[15px] leading-relaxed text-muted-foreground">
          Pick a folder to work in. Everything Simba reads, edits or runs stays inside it —
          anything outside needs your approval, every time.
        </p>
        <button
          type="button"
          onClick={chooseFolder}
          className="flex items-center gap-2.5 rounded-full bg-[image:var(--gradient)] px-6 py-3 text-sm text-white transition-all hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(0,0,0,0.45)]"
        >
          <FolderSearch className="size-4" />
          Choose a folder
        </button>

        {code.nodeVersion === null && (
          <div className="mt-8 flex max-w-md gap-3 rounded-2xl border border-destructive/30 bg-destructive/8 p-4 text-left">
            <Download className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">Node.js was not found.</span> Code mode
              runs the agent as a Node process, so it needs Node 22 or newer installed. Chat mode
              works without it.
            </p>
          </div>
        )}
      </div>
    );
  }

  /* -------------------------------------------------------- live session */

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className={cn('mx-auto flex w-full max-w-[1000px] flex-1 flex-col px-8', empty && 'justify-center')}>
          {empty ? (
            <>
              {/* No logo, and nothing naming the project — the sidebar has both. */}
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
                mode="code"
                docked={false}
                busy={code.busy}
                disabled={!code.running}
                placeholder="Ask Simba to build, fix or explain something…"
                attachments={[]}
                onAttach={() => toast('Attachments are chat-only for now')}
                onRemoveAttachment={() => {}}
                onSend={send}
                onStop={() => agent.abort()}
                onModelChange={(m) => { code.setModel(m); agent.setModel(m); }}
              />
              <AgentStatus />

              <div className="flex flex-wrap justify-center gap-2.5 pt-5">
                {CODE_SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={!code.running}
                    onClick={() => send(s)}
                    className="rounded-full border border-border bg-card px-4 py-2 text-[12.5px] text-muted-foreground backdrop-blur-xl transition-all duration-300 hover:-translate-y-1 hover:border-ring hover:text-foreground disabled:opacity-40"
                  >
                    {s}
                  </button>
                ))}
              </div>

              {code.check && (
                <p className="pt-6 text-center text-[12px] text-dim">
                  Verified with <span className="font-mono text-teal">{code.check}</span> — changes are
                  run before they are reported as done.
                </p>
              )}
            </>
          ) : (
            <div className="pt-6 pb-2">
              {groupTools(code.transcript).map((item) => <Row key={item.id} item={item} />)}
              {streamed && (
                <div className="my-3 text-[15px] leading-relaxed whitespace-pre-wrap">
                  {streamed}
                  <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-purple-2 align-text-bottom" />
                </div>
              )}
              {/*
                What it is doing, right now.
                Kept at full strength while the transcript around it is dimmed:
                a long turn is otherwise a wall of faint grey with no sign of
                life, and this is the one line that says the app is working.
              */}
              {code.busy && (
                <div className="flex items-center gap-2.5 py-2.5 text-[12.5px] text-muted-foreground">
                  <Sparkles className="size-3.5 shrink-0 animate-pulse text-purple-2" />
                  <span className="truncate">{code.status ?? 'Thinking…'}</span>
                  <Elapsed />
                </div>
              )}

              {/*
                The turn ended before the work did. Rather than going quiet —
                which is what "it just stopped" feels like — say why, and make
                carrying on a single click.
              */}
              {!code.busy && code.stopped && (
                <div className="my-3 flex items-center gap-3 rounded-xl border border-ring bg-primary/10 px-4 py-3">
                  <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted-foreground">
                    {code.stopped === 'step_limit'
                      ? 'That was a long job and it paused partway through.'
                      : 'The turn ended early.'}{' '}
                    Nothing is lost — it can pick up where it left off.
                  </span>
                  <button
                    type="button"
                    onClick={() => send('Continue exactly where you left off. Do not start again.')}
                    className="shrink-0 rounded-full bg-[image:var(--gradient)] px-4 py-1.5 text-xs text-white transition-transform hover:-translate-y-0.5"
                  >
                    Continue
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {!empty && (
        <div className="px-8 pt-1.5 pb-6">
          <div className="mx-auto w-full max-w-[1000px]">
            <Composer
              mode="code"
              docked
              busy={code.busy}
              disabled={!code.running}
              placeholder="Ask Simba to build, fix or explain something…"
              attachments={[]}
              onAttach={() => toast('Attachments are chat-only for now')}
              onRemoveAttachment={() => {}}
              onSend={send}
              onStop={() => agent.abort()}
              onModelChange={(m) => { code.setModel(m); agent.setModel(m); }}
            />
            <AgentStatus />
          </div>
        </div>
      )}

      {/* Approval — raised by guardOutsideRoot() in the agent's tools.js */}
      <AlertDialog open={!!code.confirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <span className="mono-label w-fit rounded-md bg-[image:var(--gradient)] px-2.5 py-1 text-white">
              {code.confirm?.risk === 'command' ? 'shell' : 'outside project'}
            </span>
            <AlertDialogTitle className="pt-3 font-heading text-[15.5px] font-medium">
              {code.confirm?.action}
            </AlertDialogTitle>
            <AlertDialogDescription className="sr-only">
              Simba is asking permission before touching something outside the project folder.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="rounded-xl border border-border bg-input p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-muted-foreground">
            {code.confirm?.detail}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (code.confirm) agent.confirm(code.confirm.id, false);
                code.setConfirm(null);
              }}
            >
              Decline
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (code.confirm) agent.confirm(code.confirm.id, true);
                code.setConfirm(null);
              }}
            >
              <ShieldAlert className="size-3.5" />
              Approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
