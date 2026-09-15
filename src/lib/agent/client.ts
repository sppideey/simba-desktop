/**
 * client.ts — the desktop side of the agent sidecar.
 *
 * Every event below maps 1:1 onto a method of sidecar/rpc-ui.js, which is
 * itself a drop-in replacement for the agent's terminal UI. Nothing here
 * invents agent behaviour; it renders what the agent already reports.
 *
 * Kept in step with simba-agent 1.19.0. That release renamed the model's
 * private reasoning from "reasoning" to "thinking", and added the turn-level
 * reporting the window uses for its live step count — turn_start, step,
 * turn_done, diff_stat, run_stat.
 */

import { invoke, Channel } from '@tauri-apps/api/core';
import { CODE_KEY } from '../config';

export type AgentEvent =
  // -- lifecycle
  | { type: 'ready'; cwd: string; model: string; check: string | null; context: ContextStats; skills: SkillInfo[] }
  | { type: 'turn_begin' }
  | { type: 'turn_end'; stopped?: string | null; usage: Usage; context: ContextStats; title: string; sessionId: string }
  // -- the turn in flight: what drives the live step counter
  | { type: 'turn_start' }
  | { type: 'step'; n: number }
  | { type: 'turn_done'; ok: boolean; steps: number; ms: number; added: number; removed: number }
  | { type: 'diff_stat'; added: number; removed: number }
  | { type: 'run_stat'; text: string }
  // -- transcript
  | { type: 'narrate'; text: string }
  | { type: 'note'; text: string }
  | { type: 'plan'; items: PlanItem[] }
  | { type: 'status'; text: string }
  | { type: 'busy'; text: string }
  | { type: 'idle' }
  | { type: 'working' }
  | { type: 'flash'; text: string }
  | { type: 'clear' }
  | { type: 'tool_call'; label: string }
  | { type: 'tool_result'; summary: string }
  | { type: 'tool_failed'; summary: string }
  | { type: 'diff'; lines: string[] }
  | { type: 'command_output'; lines: string[] }
  | { type: 'assistant'; text: string; closing?: boolean }
  | { type: 'user_echo'; text: string }
  // -- streaming
  | { type: 'stream_begin' }
  | { type: 'stream_delta'; delta: string }
  | { type: 'stream_end'; text: string; asStatus: boolean }
  // -- the model's private thinking (was reasoning_* before 1.19.0)
  | { type: 'thinking_begin' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_end'; seconds: number }
  // -- things that need an answer from the person
  | { type: 'confirm_request'; id: number; action: string; detail: string; risk: string }
  | { type: 'choose_request'; id: number; prompt: string; items: string[]; allowNone: boolean }
  | { type: 'pick_request'; id: number; items: PickItem[]; active: number; hint: string; deletable: boolean }
  // -- state
  | { type: 'header'; cwd?: string; model?: string; used?: number; limit?: number; title?: string }
  | { type: 'facts'; model?: string; update?: string; used?: number; limit?: number }
  | { type: 'error'; kind: string; attempted: string; failed: string; fix?: string; stack?: string | null }
  | { type: 'stderr'; text: string }
  | { type: 'model_changed'; model: string }
  | { type: 'mode_changed'; mode: 'plan' | 'build' }
  | { type: 'session_new'; id: string; context: ContextStats }
  | { type: 'session_resumed'; id: string; title: string; messages: SessionMessage[]; context: ContextStats }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'skills'; skills: SkillInfo[] }
  | { type: 'models'; models: ModelInfo[]; current: string };

export type PlanItem = { text: string; done?: boolean };
export type PickItem = { label: string; [k: string]: unknown };
export type SkillInfo = { name: string; description: string; loaded?: boolean };
export type ModelInfo = { id: string; name: string; context: number; note?: string; star?: boolean; active?: boolean };
export type SessionMessage = { role: string; content: string };
export type SessionSummary = { id: string; title?: string; when?: number; messages?: number };
export type Usage = { promptTokens: number; outputTokens: number; totalTokens: number; turns: number };

/** The sidecar sends used/limit; the percentage is the window's business. */
export type ContextStats = { used: number; limit: number };

export function contextPercent({ used, limit }: ContextStats): number {
  if (!limit) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

let started = false;

/** Is Node available? Code mode explains itself rather than failing opaquely. */
export function nodeVersion(): Promise<string | null> {
  return invoke<string | null>('node_version');
}

export async function startAgent(cwd: string, onEvent: (e: AgentEvent) => void): Promise<void> {
  const channel = new Channel<string>();
  channel.onmessage = (line: string) => {
    for (const part of line.split('\n')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      try {
        onEvent(JSON.parse(trimmed) as AgentEvent);
      } catch {
        // Not JSON — almost always a Node warning on stderr. Surface it as a
        // note rather than dropping it silently.
        onEvent({ type: 'stderr', text: trimmed });
      }
    }
  };

  await invoke('agent_start', {
    cwd,
    openrouterKey: CODE_KEY,
    onEvent: channel,
  });
  started = true;
}

export async function stopAgent(): Promise<void> {
  if (!started) return;
  started = false;
  await invoke('agent_stop');
}

export function sendAgent(command: Record<string, unknown>): Promise<void> {
  return invoke('agent_send', { line: JSON.stringify(command) });
}

export const agent = {
  message: (text: string) => sendAgent({ type: 'user_message', text }),
  confirm: (id: number, approved: boolean) => sendAgent({ type: 'confirm_response', id, approved }),
  choose: (id: number, index: number | null) => sendAgent({ type: 'choose_response', id, index }),
  /** index, null to cancel, or { delete: n } when the list allows removing rows. */
  pick: (id: number, index: number | null | { delete: number }) => sendAgent({ type: 'pick_response', id, index }),
  setModel: (model: string) => sendAgent({ type: 'set_model', model }),
  setMode: (mode: 'plan' | 'build') => sendAgent({ type: 'set_mode', mode }),
  abort: () => sendAgent({ type: 'abort' }),
  newSession: () => sendAgent({ type: 'new_session' }),
  resumeSession: (id: string) => sendAgent({ type: 'resume_session', id }),
  listSessions: () => sendAgent({ type: 'list_sessions' }),
  listSkills: () => sendAgent({ type: 'list_skills' }),
  listModels: () => sendAgent({ type: 'list_models' }),
};
