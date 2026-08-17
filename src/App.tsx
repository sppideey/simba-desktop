/**
 * App — the shell.
 *
 * A floating sidebar inset from every edge, and a content pane whose top bar
 * carries the active name only once there is one. A fresh conversation shows
 * nothing up there — no "New chat" label.
 */

import { useEffect } from 'react';
import { PanelLeft } from 'lucide-react';
import { Toaster } from 'sonner';

import { useApp, useChat, useCode } from '@/store';
import { Sidebar } from '@/components/Sidebar';
import { ChatView } from '@/components/ChatView';
import { CodeView } from '@/components/CodeView';
import { Settings } from '@/components/Settings';
import { cn } from '@/lib/utils';

export default function App() {
  const { mode, sidebarOpen, settingsOpen, toggleSidebar, setSettingsOpen } = useApp();
  const chat = useChat();
  const code = useCode();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleSidebar();
      }
      if (e.ctrlKey && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
      if (e.key === 'Escape' && useApp.getState().settingsOpen) setSettingsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar, setSettingsOpen]);

  const activeChat = chat.chats.find((c) => c.id === chat.currentId) ?? null;
  const activeProject = code.projects.find((p) => p.id === code.currentId) ?? null;

  /** Only shown once something is open. Never "New chat". */
  const paneTitle = mode === 'chat' ? (activeChat?.title ?? '') : (activeProject?.name ?? '');

  const startNew = () => {
    if (mode === 'chat') chat.newChat();
    else code.openProject('');
  };

  return (
    <div className="relative z-10 flex h-full gap-2.5 p-2.5 transition-[gap] duration-300">
      {/* The one piece of chrome that survives a closed sidebar */}
      {!sidebarOpen && (
        <button
          type="button"
          onClick={toggleSidebar}
          title="Open sidebar  (Ctrl+B)"
          className="fixed top-4 left-4 z-40 grid size-8.5 place-items-center rounded-xl border border-border bg-card text-muted-foreground backdrop-blur-xl transition-colors hover:border-ring hover:bg-accent hover:text-foreground"
        >
          <PanelLeft className="size-4" />
        </button>
      )}

      <Sidebar onNew={startNew} />

      <main className="relative flex min-w-0 flex-1 flex-col">
        <div
          className={cn(
            'flex h-12 shrink-0 items-center transition-[padding] duration-300',
            sidebarOpen ? 'px-5' : 'pr-5 pl-14',
          )}
        >
          <span className="truncate text-[13px] text-muted-foreground">{paneTitle}</span>
        </div>

        {mode === 'chat' ? <ChatView /> : <CodeView />}

        {settingsOpen && <Settings />}
      </main>

      <Toaster
        theme="dark"
        position="bottom-center"
        toastOptions={{
          style: {
            background: 'var(--popover)',
            border: '1px solid var(--border-hi)',
            color: 'var(--foreground)',
            borderRadius: '50px',
          },
        }}
      />
    </div>
  );
}
