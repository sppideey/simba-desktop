/**
 * store.ts — application state.
 *
 * Two independent halves that never share anything but the window: `chat`
 * holds conversations with Simba AI, `code` holds one live agent session.
 * Chat is persisted; code sessions live in ~/.simba/sessions, written by the
 * agent itself, so the desktop app and the CLI share one history.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ChatMessage } from './lib/chat/stream';
import type { SkillInfo } from './lib/agent/client';
import { DEFAULT_MODEL } from './lib/config';

/* ------------------------------------------------------------------ types */

export type Mode = 'chat' | 'code';

export type Chat = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
};

export type Project = {
  id: string;
  /** A label the user can rename. The folder on disk is never touched. */
  name: string;
  path: string;
  lastOpened: number;
};

/** One row in the code-mode transcript. */
export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'narrate'; id: string; text: string }
  | { kind: 'tool'; id: string; label: string; summary?: string; failed?: boolean }
  | { kind: 'diff'; id: string; lines: string[] }
  | { kind: 'output'; id: string; lines: string[] }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thought'; id: string; seconds: number }
  | { kind: 'note'; id: string; text: string }
  | { kind: 'error'; id: string; attempted: string; failed: string; fix?: string };

export type ConfirmRequest = { id: number; action: string; detail: string; risk: string };

let counter = 0;
export const uid = () => `${Date.now().toString(36)}-${(counter++).toString(36)}`;

/* ------------------------------------------------------------------- app */

type AppState = {
  mode: Mode;
  sidebarOpen: boolean;
  settingsOpen: boolean;
  userName: string;
  sendOnEnter: boolean;
  setMode: (m: Mode) => void;
  toggleSidebar: () => void;
  setSettingsOpen: (v: boolean) => void;
  setUserName: (v: string) => void;
  setSendOnEnter: (v: boolean) => void;
};

export const useApp = create<AppState>()(
  persist(
    (set) => ({
      mode: 'chat',
      sidebarOpen: true,
      settingsOpen: false,
      userName: '',
      sendOnEnter: true,
      setMode: (mode) => set({ mode, settingsOpen: false }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setUserName: (userName) => set({ userName }),
      setSendOnEnter: (sendOnEnter) => set({ sendOnEnter }),
    }),
    {
      name: 'simba-app',
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        userName: s.userName,
        sendOnEnter: s.sendOnEnter,
      }) as AppState,
    },
  ),
);

/* ------------------------------------------------------------------ chat */

type ChatState = {
  chats: Chat[];
  currentId: string | null;
  busy: boolean;
  streaming: string | null;
  statusNote: string | null;

  newChat: () => void;
  open: (id: string) => void;
  rename: (id: string, title: string) => void;
  remove: (id: string) => void;

  addMessage: (m: ChatMessage) => string;
  patchMessage: (id: string, patch: Partial<ChatMessage>) => void;
  setBusy: (v: boolean) => void;
  setStreaming: (v: string | null) => void;
  setStatusNote: (v: string | null) => void;
  current: () => Chat | null;
};

/** Turn the first message into something recognisable in the sidebar. */
function titleFrom(text: string): string {
  const t = (text || 'New chat').replace(/\s+/g, ' ').trim();
  const clipped = t.length > 48 ? `${t.slice(0, 47)}…` : t;
  return clipped.charAt(0).toUpperCase() + clipped.slice(1);
}

export const useChat = create<ChatState>()(
  persist(
    (set, get) => ({
      chats: [],
      currentId: null,
      busy: false,
      streaming: null,
      statusNote: null,

      newChat: () => set({ currentId: null, streaming: null, statusNote: null }),
      open: (id) => set({ currentId: id, streaming: null, statusNote: null }),

      rename: (id, title) =>
        set((s) => ({
          chats: s.chats.map((c) => (c.id === id ? { ...c, title: title.trim() || c.title } : c)),
        })),

      remove: (id) =>
        set((s) => ({
          chats: s.chats.filter((c) => c.id !== id),
          currentId: s.currentId === id ? null : s.currentId,
        })),

      addMessage: (message) => {
        const state = get();
        let chatId = state.currentId;

        if (!chatId) {
          chatId = uid();
          const chat: Chat = {
            id: chatId,
            title: message.role === 'user' ? titleFrom(message.content) : 'New chat',
            updatedAt: Date.now(),
            messages: [message],
          };
          set({ chats: [chat, ...state.chats], currentId: chatId });
          return chatId;
        }

        set({
          chats: state.chats.map((c) =>
            c.id === chatId
              ? { ...c, updatedAt: Date.now(), messages: [...c.messages, message] }
              : c,
          ),
        });
        return chatId;
      },

      patchMessage: (id, patch) =>
        set((s) => ({
          chats: s.chats.map((c) =>
            c.id !== s.currentId
              ? c
              : { ...c, messages: c.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) },
          ),
        })),

      setBusy: (busy) => set({ busy }),
      setStreaming: (streaming) => set({ streaming }),
      setStatusNote: (statusNote) => set({ statusNote }),
      current: () => get().chats.find((c) => c.id === get().currentId) ?? null,
    }),
    {
      name: 'simba-chats',
      partialize: (s) => ({ chats: s.chats }) as ChatState,
    },
  ),
);

/* ------------------------------------------------------------------ code */

type CodeState = {
  projects: Project[];
  currentId: string | null;
  running: boolean;          // sidecar alive
  busy: boolean;             // a turn is in flight
  status: string | null;     // live spinner label
  transcript: TranscriptItem[];
  confirm: ConfirmRequest | null;
  model: string;
  planMode: boolean;
  check: string | null;      // how this project verifies itself
  skills: SkillInfo[];
  contextPercent: number;
  nodeVersion: string | null | 'unknown';

  addProject: (path: string, name: string) => Project;
  openProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  removeProject: (id: string) => void;

  push: (item: TranscriptItem) => void;
  patchLastTool: (patch: { summary?: string; failed?: boolean }) => void;
  clearTranscript: () => void;

  setRunning: (v: boolean) => void;
  setBusy: (v: boolean) => void;
  setStatus: (v: string | null) => void;
  setConfirm: (v: ConfirmRequest | null) => void;
  setModel: (v: string) => void;
  setPlanMode: (v: boolean) => void;
  setReady: (v: { check: string | null; skills: SkillInfo[]; model: string }) => void;
  setContextPercent: (v: number) => void;
  setNodeVersion: (v: string | null) => void;
  current: () => Project | null;
};

export const useCode = create<CodeState>()(
  persist(
    (set, get) => ({
      projects: [],
      currentId: null,
      running: false,
      busy: false,
      status: null,
      transcript: [],
      confirm: null,
      model: DEFAULT_MODEL,
      planMode: false,
      check: null,
      skills: [],
      contextPercent: 0,
      nodeVersion: 'unknown',

      addProject: (path, name) => {
        const existing = get().projects.find((p) => p.path === path);
        if (existing) {
          set((s) => ({
            currentId: existing.id,
            projects: s.projects.map((p) =>
              p.id === existing.id ? { ...p, lastOpened: Date.now() } : p,
            ),
          }));
          return existing;
        }
        const project: Project = { id: uid(), name, path, lastOpened: Date.now() };
        set((s) => ({ projects: [project, ...s.projects], currentId: project.id }));
        return project;
      },

      openProject: (id) => set({ currentId: id, transcript: [], status: null }),

      renameProject: (id, name) =>
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)),
        })),

      removeProject: (id) =>
        set((s) => ({
          projects: s.projects.filter((p) => p.id !== id),
          currentId: s.currentId === id ? null : s.currentId,
        })),

      push: (item) => set((s) => ({ transcript: [...s.transcript, item] })),

      /** Attach a result to the tool row that is still open. */
      patchLastTool: (patch) =>
        set((s) => {
          const next = [...s.transcript];
          for (let i = next.length - 1; i >= 0; i--) {
            const item = next[i];
            if (item.kind === 'tool' && item.summary === undefined) {
              next[i] = { ...item, ...patch };
              break;
            }
          }
          return { transcript: next };
        }),

      clearTranscript: () => set({ transcript: [], status: null }),
      setRunning: (running) => set({ running }),
      setBusy: (busy) => set({ busy }),
      setStatus: (status) => set({ status }),
      setConfirm: (confirm) => set({ confirm }),
      setModel: (model) => set({ model }),
      setPlanMode: (planMode) => set({ planMode }),
      setReady: ({ check, skills, model }) => set({ check, skills, model, running: true }),
      setContextPercent: (contextPercent) => set({ contextPercent }),
      setNodeVersion: (nodeVersion) => set({ nodeVersion }),
      current: () => get().projects.find((p) => p.id === get().currentId) ?? null,
    }),
    {
      name: 'simba-code',
      partialize: (s) => ({
        projects: s.projects,
        currentId: s.currentId,
        model: s.model,
        planMode: s.planMode,
      }) as CodeState,
    },
  ),
);
