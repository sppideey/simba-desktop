/**
 * client.ts — the desktop side of the agent sidecar.
 *
 * Every event below maps 1:1 onto a method of sidecar/rpc-ui.js, which is
 * itself a drop-in replacement for the agent's terminal UI. Nothing here
 * invents agent behaviour; it renders what the agent already reports.
 */

import { invoke, Channel } from '@tauri-apps/api/core';
import { CODE_KEY, TAVILY_KEY } from '../config';

export type AgentEvent =
  | { type: 'ready'; cwd: string; model: string; check: string | null; skills: SkillInfo[] }
  | { type: 'turn_begin' }
  | { type: 'turn_end'; usage: Usage; context: ContextStats; title: string; sessionId: string }
  | { type: 'narrate'; text: string }
  | { type: 'note'; text: string }
  | { type: 'status'; text: string }
  | { type: 'busy'; text: string }
  | { type: 'idle' }
  | { type: 'clear' }
  | { type: 'tool_call'; label: string }
  | { type: 'tool_result'; summary: string }
  | { type: 'tool_failed'; summary: string }
  | { type: 'diff'; lines: string[] }
  | { type: 'command_output'; lines: string[] }
  | { type: 'assistant'; text: string }
  | { type: 'stream_begin' }
  | { type: 'stream_delta'; delta: string }
  | { type: 'stream_end'; text: string; asStatus: boolean }
  | { type: 'reasoning_begin' }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'reasoning_end'; seconds: number }
  | { type: 'confirm_request'; id: number; action: string; detail: string; risk: string }
  | { type: 'error'; kind: string; attempted: string; failed: string; fix?: string; stack?: string | null }
  | { type: 'stderr'; text: string }
  | { type: 'model_changed'; model: string }
  | { type: 'mode_changed'; mode: 'plan' | 'build' }
  | { type: 'session_new'; id: string }
  | { type: 'skills'; skills: SkillInfo[] }
  | { type: 'models'; curated: unknown[]; rest: unknown[]; current: string };

export type SkillInfo = { name: string; description: string; loaded?: boolean };
export type Usage = { promptTokens: number; outputTokens: number; totalTokens: number; turns: number };
export type ContextStats = { used: number; limit: number; percent: number; remaining: number };

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
    tavilyKey: TAVILY_KEY,
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
  setModel: (model: string) => sendAgent({ type: 'set_model', model }),
  setMode: (mode: 'plan' | 'build') => sendAgent({ type: 'set_mode', mode }),
  abort: () => sendAgent({ type: 'abort' }),
  newSession: () => sendAgent({ type: 'new_session' }),
  listSkills: () => sendAgent({ type: 'list_skills' }),
};
