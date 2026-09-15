#!/usr/bin/env node
/**
 * server.js — headless entry point for the desktop app.
 *
 * Drives the same Agent the CLI drives, with RpcUI in place of the terminal.
 * Reads newline-delimited JSON commands on stdin, writes events on stdout.
 *
 * Imports go through the names simba-agent publishes in its `exports` map, not
 * through file paths. 1.19.0 moved every module this file used to import —
 * agent.js, llm.js and session.js all became something under src/ — and the
 * app could not start until they were renamed here. The exports map exists so
 * the next reshuffle costs nothing.
 *
 * Commands from the app:
 *   { type: 'user_message',     text }
 *   { type: 'set_model',        model }
 *   { type: 'set_mode',         mode: 'plan' | 'build' }
 *   { type: 'confirm_response', id, approved }
 *   { type: 'choose_response',  id, index }
 *   { type: 'pick_response',    id, index }       // index | null | { delete }
 *   { type: 'abort' }
 *   { type: 'new_session' }
 *   { type: 'resume_session',   id }
 *   { type: 'list_sessions' }
 *   { type: 'list_skills' }
 *   { type: 'list_models' }
 */

import readline from 'node:readline';
import process from 'node:process';

import { RpcUI } from './rpc-ui.js';
import { Agent } from 'simba-agent/agent';
import {
  setModel,
  model as currentModel,
  modelList,
  contextLimit,
  estimateConversation,
} from 'simba-agent/provider';
import { list as listSessions } from 'simba-agent/history';

const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

const cwd = process.argv[2] || process.cwd();
const debug = Boolean(process.env.SIMBA_DEBUG);
const ui = new RpcUI();

const agent = new Agent({ cwd, debug });
agent.ui = ui;              // the injection point this whole design rests on

// bootstrap() loads skills and works out the project's check command; it is
// everything start() does apart from opening a terminal and entering the REPL.
await agent.bootstrap();

/** What the window shows in its status strip. */
const context = () => ({
  used: estimateConversation(agent.working),
  limit: contextLimit(),
});

send({
  type: 'ready',
  cwd,
  model: currentModel(),
  check: agent.check ?? null,
  context: context(),
  skills: agent.skills.map((s) => ({ name: s.name, description: s.description })),
});

/** One turn at a time: the composer is disabled while this is true. */
let running = false;

async function runTurn(text) {
  if (running) return;
  running = true;
  send({ type: 'turn_begin' });

  // Why the turn ended, so the app can offer to carry on rather than just
  // going quiet. "Stopped in the middle" with no explanation is the single
  // most confusing thing an agent can do.
  let stopped = null;

  try {
    await agent.turn(text);
  } catch (err) {
    stopped = err?.kind ?? 'error';
    ui.error(err, { debug });
  } finally {
    running = false;
    send({
      type: 'turn_end',
      stopped,
      usage: agent.session.usage,
      context: context(),
      title: agent.session.title,
      sessionId: agent.session.id,
    });
  }
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const raw = line.trim();
  if (!raw) return;

  let cmd;
  try {
    cmd = JSON.parse(raw);
  } catch {
    return; // a malformed command is ignored rather than killing the process
  }

  switch (cmd.type) {
    case 'user_message':
      await runTurn(cmd.text);
      break;

    case 'confirm_response':
      ui.resolve(cmd.id, Boolean(cmd.approved));
      break;

    case 'choose_response':
      ui.resolve(cmd.id, cmd.index ?? null);
      break;

    case 'pick_response':
      // null cancels; { delete: n } removes a row; a number chooses one.
      ui.resolve(cmd.id, cmd.index ?? null);
      break;

    case 'set_model':
      try {
        setModel(cmd.model);
        agent.session.model = cmd.model;
        send({ type: 'model_changed', model: cmd.model });
      } catch (err) {
        ui.error(err, { debug });
      }
      break;

    case 'set_mode':
      ui.mode = cmd.mode === 'plan' ? 'plan' : 'build';
      ui.onModeChange?.();
      send({ type: 'mode_changed', mode: ui.mode });
      break;

    case 'abort':
      agent.abort?.abort();
      break;

    case 'new_session':
      await agent.cmdNew();
      send({ type: 'session_new', id: agent.session.id, context: context() });
      break;

    case 'resume_session':
      if (await agent.resume(cmd.id)) {
        send({
          type: 'session_resumed',
          id: agent.session.id,
          title: agent.session.title,
          messages: agent.session.messages,
          context: context(),
        });
      }
      break;

    case 'list_sessions':
      send({ type: 'sessions', sessions: await listSessions({ cwd: agent.cwd }) });
      break;

    case 'list_skills':
      send({
        type: 'skills',
        skills: agent.skills.map((s) => ({
          name: s.name,
          description: s.description,
          // `loaded` holds whole skills, `short` the digest-only ones.
          loaded: agent.loaded.has(s.name) || agent.short.has(s.name),
        })),
      });
      break;

    case 'list_models':
      // modelList() already marks the active one; there is no separate
      // free-model fetch in 1.19.0.
      send({ type: 'models', models: modelList(), current: currentModel() });
      break;

    default:
      break;
  }
});

rl.on('close', async () => {
  // Take dev servers down with the session that started them. Without this
  // every build leaves its server holding the port the next run wants.
  try {
    const { stopServers } = await import('simba-agent/shell');
    stopServers?.();
  } catch { /* nothing started, or not exported — not worth failing the exit */ }
  process.exit(0);
});

// A crash must not vanish silently — the app shows it as an error card.
process.on('uncaughtException', (err) => {
  send({
    type: 'error',
    kind: 'crash',
    attempted: 'running the agent',
    failed: err?.message ?? String(err),
    fix: 'Restart Code mode.',
    stack: debug ? err?.stack ?? null : null,
  });
});
