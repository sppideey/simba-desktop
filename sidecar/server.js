#!/usr/bin/env node
/**
 * server.js — headless entry point for the desktop app.
 *
 * Drives the same Agent the CLI drives, with RpcUI in place of the terminal.
 * Reads newline-delimited JSON commands on stdin, writes events on stdout.
 *
 * Commands from the app:
 *   { type: 'user_message', text }
 *   { type: 'set_model',    model }
 *   { type: 'set_mode',     mode: 'plan' | 'build' }
 *   { type: 'set_cwd',      cwd }
 *   { type: 'confirm_response', id, approved }
 *   { type: 'choose_response',  id, index }
 *   { type: 'abort' }
 *   { type: 'new_session' }
 *   { type: 'resume_session', id }
 *   { type: 'list_sessions' }
 *   { type: 'list_skills' }
 *   { type: 'list_models' }
 */

import readline from 'node:readline';
import process from 'node:process';

import { RpcUI } from './rpc-ui.js';
import { Agent } from 'simba-agent/agent.js';
import { setModel, getModel, listFreeModels, MODELS, contextLimit } from 'simba-agent/llm.js';
import { listSessions } from 'simba-agent/session.js';
import { contextStats } from 'simba-agent/context.js';

const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');

const cwd = process.argv[2] || process.cwd();
const ui = new RpcUI();

const agent = new Agent({ cwd, debug: Boolean(process.env.SIMBA_DEBUG) });
agent.ui = ui;              // the injection point this whole design rests on
agent.tui = false;

await agent.bootstrap();    // skills + verification detection, without the REPL

send({
  type: 'ready',
  cwd,
  model: getModel(),
  check: agent.verificationCommand(),
  skills: agent.skills.map((s) => ({ name: s.name, description: s.description })),
});

/** One turn at a time: the composer is disabled while `busy` is true. */
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
    ui.error(err, { debug: Boolean(process.env.SIMBA_DEBUG) });
  } finally {
    running = false;
    send({
      type: 'turn_end',
      stopped,
      usage: agent.session.usage,
      context: contextStats(agent.working, contextLimit()),
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
      ui.resolveConfirm(cmd.id, Boolean(cmd.approved));
      break;

    case 'choose_response':
      ui.resolveConfirm(cmd.id, cmd.index ?? null);
      break;

    case 'set_model':
      setModel(cmd.model);
      agent.session.model = cmd.model;
      send({ type: 'model_changed', model: cmd.model });
      break;

    case 'set_mode':
      ui.mode = cmd.mode === 'plan' ? 'plan' : 'build';
      send({ type: 'mode_changed', mode: ui.mode });
      break;

    case 'abort':
      if (agent.abort) agent.abort.abort();
      break;

    case 'new_session':
      await agent.cmdNew();
      send({ type: 'session_new', id: agent.session.id });
      break;

    case 'resume_session':
      if (await agent.resume(cmd.id)) {
        send({
          type: 'session_resumed',
          id: agent.session.id,
          title: agent.session.title,
          messages: agent.session.messages,
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
          loaded: agent.loadedSkills.has(s.name),
        })),
      });
      break;

    case 'list_models': {
      const curated = Object.entries(MODELS).map(([id, info]) => ({ id, ...info }));
      const known = new Set(curated.map((m) => m.id));
      const rest = (await listFreeModels()).filter((m) => !known.has(m.id));
      send({ type: 'models', curated, rest, current: getModel() });
      break;
    }

    default:
      break;
  }
});

rl.on('close', () => process.exit(0));

// A crash must not vanish silently — the app shows it as an error card.
process.on('uncaughtException', (err) => {
  send({ type: 'error', kind: 'crash', attempted: 'running the agent',
         failed: err?.message ?? String(err), fix: 'Restart Code mode.' });
});
