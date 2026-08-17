/**
 * rpc-ui.js — a third implementation of Simba's UI interface.
 *
 * agent.js already picks its UI at runtime:
 *
 *     this.ui = this.tui ? new Tui({ cwd }) : new UI();
 *
 * Both Tui and UI expose the same method set, so the desktop app needs no new
 * agent logic — only a UI that writes newline-delimited JSON to stdout instead
 * of ANSI to a terminal. Everything above this file (llm.js, tools.js,
 * session.js, context.js, skills.js, errors.js) is reused untouched, and the
 * `simba` CLI keeps working exactly as before.
 *
 * Every method below maps 1:1 onto an event the React transcript renders.
 */

/** One JSON object per line. stdout is the channel; nothing else may write to it. */
function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n');
}

export class RpcUI {
  constructor() {
    /** 'build' | 'plan' — agent.js reads this to decide which tools to offer. */
    this.mode = 'build';
    this.pending = new Map();
    this.nextId = 1;
    this.onModeChange = null;
  }

  // -- transcript ----------------------------------------------------------

  write(text = '') { emit({ type: 'note', text: stripAnsi(text) }); }
  blank() { /* spacing is the renderer's business, not the agent's */ }
  note(text) { emit({ type: 'note', text: stripAnsi(text) }); }
  clearScreen() { emit({ type: 'clear' }); }

  /** The model's own one-line account of the step it is about to take. */
  narrate(text) { emit({ type: 'narrate', text: String(text).trim() }); }

  toolCall(label) { emit({ type: 'tool_call', label }); }
  toolResult(summary) { emit({ type: 'tool_result', summary }); }
  toolFailed(summary) { emit({ type: 'tool_failed', summary }); }

  /** Lines arrive as "+418| text" / "-418| text" — parsed by the renderer. */
  diff(lines) { emit({ type: 'diff', lines }); }
  commandOutput(lines) { emit({ type: 'command_output', lines }); }
  progress(lines) {
    const last = lines[lines.length - 1]?.trim();
    if (last) emit({ type: 'status', text: last });
  }

  assistant(text) {
    if (!text?.trim()) return;
    emit({ type: 'assistant', text });
  }

  // -- streaming -----------------------------------------------------------

  streamBegin() { emit({ type: 'stream_begin' }); this._streamed = ''; }
  streamDelta(delta) { this._streamed += delta; emit({ type: 'stream_delta', delta }); }

  streamEnd({ asStatus = false } = {}) {
    const text = this._streamed ?? '';
    this._streamed = '';
    emit({ type: 'stream_end', text, asStatus });
    return text;
  }

  // -- reasoning -----------------------------------------------------------

  reasoningDelta(delta) {
    if (this._reasonStart === undefined) {
      this._reasonStart = Date.now();
      emit({ type: 'reasoning_begin' });
    }
    emit({ type: 'reasoning_delta', delta });
  }

  reasoningEnd() {
    if (this._reasonStart === undefined) return '';
    const seconds = Math.round((Date.now() - this._reasonStart) / 1000);
    this._reasonStart = undefined;
    emit({ type: 'reasoning_end', seconds });
    return '';
  }

  // -- spinner -------------------------------------------------------------

  startSpinner(text = 'thinking') { emit({ type: 'busy', text }); }
  updateSpinner(text) { emit({ type: 'status', text }); }
  stopSpinner() { emit({ type: 'idle' }); }

  // -- header --------------------------------------------------------------

  header(facts) { emit({ type: 'header', ...facts }); }

  // -- input ---------------------------------------------------------------

  /**
   * The agent never reads a line from us: the desktop app drives one turn at a
   * time. Resolving to null would end its REPL, so this simply never settles —
   * server.js calls turn() directly instead of repl().
   */
  ask() { return new Promise(() => {}); }

  /** Round-trips to the React approval dialog and waits for the answer. */
  confirm({ action, detail, risk }) {
    const id = this.nextId++;
    emit({ type: 'confirm_request', id, action, detail, risk });
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  /** Answer from the UI, routed back to whichever confirm() is waiting. */
  resolveConfirm(id, approved) {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(approved);
  }

  choose(promptText, items) {
    const id = this.nextId++;
    emit({ type: 'choose_request', id, prompt: promptText, items });
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  error(err, { debug = false } = {}) {
    const structured = err && typeof err === 'object' && err.attempted;
    emit({
      type: 'error',
      kind: structured ? err.kind : 'internal',
      attempted: structured ? err.attempted : 'running your request',
      failed: structured ? err.failed : (err?.message ?? String(err)),
      fix: structured ? err.fix : 'This is a bug in Simba rather than in your project.',
      stack: debug ? (err?.cause?.stack ?? err?.stack ?? null) : null,
    });
  }

  close() { /* the process exiting is the close */ }
}

/** The agent occasionally hands us pre-coloured strings; strip them. */
function stripAnsi(s) {
  return String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}
