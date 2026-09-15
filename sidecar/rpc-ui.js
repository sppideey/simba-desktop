/**
 * rpc-ui.js — simba's UI interface, spoken as JSON instead of ANSI.
 *
 * The engine picks its own UI in the Agent constructor:
 *
 *     this.full = Boolean(process.stdout.isTTY && process.stdin.isTTY);
 *     this.ui = this.full ? new Screen({ cwd }) : new Plain({ cwd });
 *
 * The sidecar is spawned with piped stdio, so `full` is false and a Plain is
 * built and then thrown away when server.js assigns this class over it. That
 * matters: a Screen would have written alternate-screen escapes to stdout
 * before we could stop it, and stdout is our protocol.
 *
 * `src/ui/plain.js` in simba-agent is the reference implementation — this
 * class must cover its whole surface. A method the engine calls and we lack is
 * a TypeError halfway through a turn, not a missing pixel.
 *
 * Where Plain renders for a terminal, this sends structure and lets React
 * decide how it looks. A diff arrives as lines for the renderer to lay out; a
 * picker arrives as items rather than a numbered list; stats arrive as numbers
 * rather than a formatted row. Anything pre-coloured by the engine has its
 * escapes stripped on the way out.
 */

/** One JSON object per line. stdout is the channel; nothing else may write to it. */
function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * The engine colours plenty of strings before handing them over — `orange('●')`,
 * `dim(note)`, whole picker labels. Those escapes are meaningless here and ugly
 * if they reach a DOM node, so everything outbound goes through this.
 */
function clean(s) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

export class RpcUI {
  constructor() {
    /** 'build' | 'plan' — the engine reads this to decide which tools to offer. */
    this.mode = 'build';

    /** Resolvers for round-trips to the GUI: confirm, choose, pick. */
    this.pending = new Map();
    this.nextId = 1;

    /** Set by the engine when it wants to know about mode changes. */
    this.onModeChange = null;
    this.onInterrupt = null;

    /** Has anything been rendered yet? Drives welcoming(). */
    this.rendered = false;

    this.streamed = '';
    this.thinking = null;
    this.turn = null;
  }

  /**
   * A width for the engine's own text clipping.
   *
   * The window reflows and the transcript wraps, so there is no real column
   * count to report. A generous fixed value keeps the engine from hard-wrapping
   * text that React would have laid out better.
   */
  width() { return 100; }

  // -- transcript ----------------------------------------------------------

  write(text = '') {
    this.rendered = true;
    emit({ type: 'note', text: clean(text) });
  }

  blank() { /* spacing is the renderer's business, not the engine's */ }

  note(text) {
    this.rendered = true;
    emit({ type: 'note', text: clean(text) });
  }

  clearScreen() {
    this.rendered = false;
    emit({ type: 'clear' });
  }

  /** The model's own one-line account of the step it is about to take. */
  narrate(text) {
    const line = clean(text).trim();
    if (!line) return;
    this.rendered = true;
    emit({ type: 'narrate', text: line });
  }

  /** The current plan, as items — the renderer draws the checklist. */
  plan(items) {
    if (!items?.length) return;
    this.rendered = true;
    emit({ type: 'plan', items });
  }

  toolCall(label) {
    this.rendered = true;
    emit({ type: 'tool_call', label: clean(label) });
  }

  toolResult(summary) { emit({ type: 'tool_result', summary: clean(summary) }); }
  toolFailed(summary) { emit({ type: 'tool_failed', summary: clean(summary) }); }

  /** Lines arrive as "+418| text" / "-418| text" / "~heading" — parsed by the renderer. */
  diff(lines) {
    this.rendered = true;
    emit({ type: 'diff', lines: lines.map(clean) });
  }

  commandOutput(lines) {
    this.rendered = true;
    emit({ type: 'command_output', lines: lines.map(clean) });
  }

  assistant(text, { closing = false } = {}) {
    if (!text?.trim()) return;
    this.rendered = true;
    // Markdown goes over raw: the renderer has a real markdown component and
    // terminal-rendered markdown would have to be un-rendered to use it.
    emit({ type: 'assistant', text: String(text), closing });
  }

  /**
   * Output from a running command.
   *
   * Only the last line reaches the status area, the way Plain does it. Raw
   * build output — webpack hashes, npm progress bars, stack frames — is noise
   * the moment it scrolls past, and putting it where someone looks for "what is
   * happening" turns the app into a log viewer.
   */
  progress(lines = []) {
    const last = [...lines].reverse().map(clean).find((l) => l.trim());
    if (last) this.updateSpinner(last.trim());
    emit({ type: 'working' });
  }

  // -- streaming -----------------------------------------------------------

  streamBegin() {
    this.streamed = '';
    this.rendered = true;
    emit({ type: 'stream_begin' });
  }

  streamDelta(delta) {
    this.streamed += delta;
    emit({ type: 'stream_delta', delta });
  }

  streamEnd({ asStatus = false } = {}) {
    const text = this.streamed;
    this.streamed = '';
    emit({ type: 'stream_end', text, asStatus });
    return text;   // the engine uses this return value
  }

  // -- thinking ------------------------------------------------------------
  //
  // Called reasoningDelta/reasoningEnd before 1.19.0. The event names on the
  // wire changed with them so the two sides stay readable together.

  thinkingDelta(delta) {
    if (!this.thinking) {
      this.thinking = { start: Date.now(), text: '' };
      this.rendered = true;
      emit({ type: 'thinking_begin' });
    }
    this.thinking.text += delta;
    emit({ type: 'thinking_delta', delta });
  }

  thinkingEnd() {
    if (!this.thinking) return '';
    const { start, text } = this.thinking;
    this.thinking = null;
    emit({ type: 'thinking_end', seconds: Math.round((Date.now() - start) / 1000) });
    return text;
  }

  // -- status --------------------------------------------------------------

  startSpinner(text = 'thinking') { emit({ type: 'busy', text: clean(text) }); }
  updateSpinner(text) { emit({ type: 'status', text: clean(text) }); }
  stopSpinner() { emit({ type: 'idle' }); }
  stopTimer() { /* the renderer owns its own clock */ }

  /** A transient message — the app raises it as a toast. */
  flash(text) { emit({ type: 'flash', text: clean(text) }); }

  /** True while the transcript is still empty, so start-up notes can be held back. */
  welcoming() { return !this.rendered; }

  // -- the turn in flight --------------------------------------------------
  //
  // The engine reports its own progress through these. The window turns them
  // into a live step count and elapsed time, which is the one thing a long
  // build gives no other sign of.

  turnStart() {
    this.turn = { start: Date.now(), steps: 0, added: 0, removed: 0 };
    emit({ type: 'turn_start' });
  }

  step() {
    if (!this.turn) return;
    this.turn.steps++;
    emit({ type: 'step', n: this.turn.steps });
  }

  turnEnd({ ok = true } = {}) {
    const t = this.turn;
    this.turn = null;
    emit({
      type: 'turn_done',
      ok,
      steps: t?.steps ?? 0,
      ms: t ? Date.now() - t.start : 0,
      added: t?.added ?? 0,
      removed: t?.removed ?? 0,
    });
  }

  /** Running totals for the turn, so the window can show what it has changed. */
  diffStat({ added = 0, removed = 0 } = {}) {
    if (!this.turn) return;
    this.turn.added += added;
    this.turn.removed += removed;
    emit({ type: 'diff_stat', added: this.turn.added, removed: this.turn.removed });
  }

  runStat(text) {
    if (!text) return;
    emit({ type: 'run_stat', text: clean(text) });
  }

  // -- header --------------------------------------------------------------

  header(facts) { emit({ type: 'header', ...facts }); }

  /** Live updates to the facts already on screen: model, context use, updates. */
  setFacts(facts = {}) { emit({ type: 'facts', ...facts }); }

  /** Terminal-only: there is no framed row to build here. */
  statusRow() { return ''; }

  // -- input ---------------------------------------------------------------

  /**
   * The engine never reads a line from us: the app drives one turn at a time.
   * Resolving to null would end its REPL, so this never settles — server.js
   * calls turn() directly instead of repl().
   */
  ask() { return new Promise(() => {}); }
  nextLine() { return new Promise(() => {}); }
  promptWith() { return new Promise(() => {}); }

  /** Round-trips to a GUI dialog and waits for the answer. */
  request(event) {
    const id = this.nextId++;
    emit({ ...event, id });
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  /** Answer from the app, routed back to whichever request is waiting. */
  resolve(id, value) {
    const resolver = this.pending.get(id);
    if (!resolver) return;
    this.pending.delete(id);
    resolver(value);
  }

  confirm({ action, detail, risk }) {
    return this.request({
      type: 'confirm_request',
      action: clean(action),
      detail: clean(detail),
      risk,
    });
  }

  choose(prompt, items, { allowNone = true } = {}) {
    return this.request({
      type: 'choose_request',
      prompt: clean(prompt),
      items: items.map(clean),
      allowNone,
    });
  }

  /**
   * A list to choose from, with one row already current.
   *
   * The engine offers this as an upgrade over `choose` and falls back when a UI
   * does not have it — a terminal gets a numbered list, we get a real dialog
   * with the active row marked. Resolves to an index, null to cancel, or
   * `{ delete: index }` when the list allows removing rows.
   */
  pick(items, { active = 0, hint = '', deletable = false } = {}) {
    return this.request({
      type: 'pick_request',
      items: items.map((item) => (typeof item === 'string'
        ? { label: clean(item) }
        : { ...item, label: clean(item.label) })),
      active,
      hint: clean(hint),
      deletable,
    });
  }

  /** A user message being replayed from a resumed session. */
  userMessage(text) {
    this.rendered = true;
    emit({ type: 'user_echo', text: String(text ?? '') });
  }

  error(err, { debug = false } = {}) {
    const known = err && typeof err === 'object' && err.attempted;
    this.rendered = true;
    emit({
      type: 'error',
      kind: known ? err.kind : 'internal',
      attempted: known ? err.attempted : 'running your request',
      failed: known ? err.failed : (err?.message ?? String(err)),
      fix: known ? err.fix : 'This is a bug in simba rather than in your project.',
      stack: debug ? (err?.cause?.stack ?? err?.stack ?? null) : null,
    });
  }

  close() { /* the process exiting is the close */ }
}
