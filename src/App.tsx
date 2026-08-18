/**
 * App — the shell.
 *
 * A floating sidebar inset from every edge, and a content pane whose top bar
 * carries the active name only once there is one. A fresh conversation shows
 * nothing up there — no "New chat" label.
 */

import { useEffect } from 'react';
import { PanelLeft } from 'lucide-react';
import { Toaster, toast } from 'sonner';

import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

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

  /**
   * Keep the app up to date without anyone having to ask.
   *
   * Checking once on launch is not enough, and that is not a hypothetical:
   * an app opened minutes before a release never sees it, and one left open
   * for a day never looks again. So it checks on launch, every 30 minutes
   * after that, and whenever the window regains focus — which covers the
   * common case of coming back to it later.
   *
   * Installing needs a relaunch, so it waits for a natural pause rather than
   * pulling the window away mid-sentence. If the pause never comes, it says
   * so instead of failing silently, because an update that quietly does
   * nothing is indistinguishable from one that is broken.
   */
  useEffect(() => {
    let cancelled = false;
    let installing = false;

    const idle = () =>
      !useChat.getState().busy &&
      !useCode.getState().busy &&
      useChat.getState().streaming === null;

    const run = async () => {
      if (cancelled || installing) return;
      try {
        const update = await check();
        if (!update || cancelled) return;

        installing = true;

        // Give the user up to two minutes to finish what they are doing.
        for (let waited = 0; waited < 120 && !idle(); waited++) {
          await new Promise((r) => setTimeout(r, 1000));
          if (cancelled) return;
        }

        if (!idle()) {
          // Still mid-turn. Say so and try again on the next tick rather than
          // interrupting, or disappearing without explanation.
          toast(`Simba ${update.version} is ready — it will install when you pause.`);
          installing = false;
          return;
        }

        toast(`Installing Simba ${update.version}…`);
        await update.downloadAndInstall();
        await relaunch();
      } catch (err) {
        installing = false;
        // Offline is not worth interrupting anyone over, but a real failure is.
        const message = err instanceof Error ? err.message : String(err);
        if (!/network|fetch|connect|dns|timed? ?out/i.test(message)) {
          console.warn('[updater]', message);
        }
      }
    };

    const first = setTimeout(run, 4000);           // let the window settle
    const repeat = setInterval(run, 30 * 60_000);  // and keep looking
    const onFocus = () => { void run(); };
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(repeat);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

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
