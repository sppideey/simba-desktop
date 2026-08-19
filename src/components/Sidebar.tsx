/**
 * Sidebar — floating panel, rounded on all four corners, inset from the
 * window edges. Closing it removes the panel entirely rather than leaving a
 * rail; the only chrome that survives is the reopen button in App.tsx.
 */

import { useEffect, useRef, useState } from 'react';
import {
  MessageSquare, Terminal, Plus, Settings as SettingsIcon,
  Pencil, Folder, PanelLeftClose, Trash2, ArrowDownToLine,
} from 'lucide-react';

import { useApp, useChat, useCode, type Chat, type Project } from '@/store';
import { installUpdate } from '@/lib/updater';
import { cn } from '@/lib/utils';
import logo from '@/assets/logo.png';

const DAY = 86_400_000;

function dateGroup(ts: number): string {
  const days = Math.floor((Date.now() - ts) / DAY);
  if (days < 1) return 'Today';
  if (days < 2) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';
  return 'Older';
}

/** Inline rename: Enter commits, Escape abandons, blur commits. */
function RenameField({
  value, onCommit, onCancel,
}: { value: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && ref.current) onCommit(ref.current.value);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      defaultValue={value}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
      className="min-w-0 flex-1 rounded-md border border-purple-2 bg-black/40 px-2 py-0.5 text-[13px] outline-none"
    />
  );
}

type RowProps = {
  icon: 'chat' | 'folder';
  label: string;
  active: boolean;
  onOpen: () => void;
  onRename: (v: string) => void;
  onDelete: () => void;
};

function Row({ icon, label, active, onOpen, onRename, onDelete }: RowProps) {
  const [editing, setEditing] = useState(false);
  const Icon = icon === 'chat' ? MessageSquare : Folder;

  return (
    <div
      onClick={() => !editing && onOpen()}
      className={cn(
        'group flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg border border-transparent px-3 pr-1.5 text-[13.5px] transition-colors',
        active
          ? 'border-ring bg-primary/16 text-foreground'
          : 'text-muted-foreground hover:border-border hover:bg-card hover:text-foreground',
      )}
    >
      <Icon className={cn('size-3.5 shrink-0', active && 'text-purple-2')} />

      {editing ? (
        <RenameField
          value={label}
          onCommit={(v) => { onRename(v); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <button
            type="button"
            aria-label="Rename"
            onClick={(e) => { e.stopPropagation(); setEditing(true); }}
            className="grid size-6 shrink-0 place-items-center rounded-md text-dim opacity-0 transition-all hover:bg-accent hover:text-purple-2 group-hover:opacity-100"
          >
            <Pencil className="size-3" />
          </button>
          <button
            type="button"
            aria-label="Delete"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="grid size-6 shrink-0 place-items-center rounded-md text-dim opacity-0 transition-all hover:bg-accent hover:text-destructive group-hover:opacity-100"
          >
            <Trash2 className="size-3" />
          </button>
        </>
      )}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="mono-label px-3 pt-4 pb-1.5 text-dim">{children}</div>;
}

/**
 * "New version — click to update", above Settings.
 *
 * The app tries to update itself quietly, but a silent mechanism that fails is
 * invisible, and that has already wasted real time here. This is the honest
 * fallback: if an update is waiting, you can always see it and always click it.
 */
function UpdatePill() {
  const state = useApp((s) => s.updateState);
  const version = useApp((s) => s.updateVersion);
  const error = useApp((s) => s.updateError);

  if (state !== 'ready' && state !== 'installing' && state !== 'error') return null;

  if (state === 'error') {
    return (
      <div className="px-2.5 pb-1">
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11.5px] leading-snug text-destructive">
          Update failed. {error}
        </div>
      </div>
    );
  }

  const busy = state === 'installing';
  return (
    <div className="px-2.5 pb-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => void installUpdate()}
        className="flex w-full items-center gap-2.5 rounded-xl border border-ring bg-primary/16 px-3 py-2 text-left transition-colors hover:bg-primary/24 disabled:opacity-60"
      >
        <ArrowDownToLine className={cn('size-3.5 shrink-0 text-purple-2', busy && 'animate-pulse')} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px]">
            {busy ? 'Updating…' : 'New version available'}
          </span>
          {!busy && version && (
            <span className="block text-[11px] text-dim">{version} · click to update</span>
          )}
        </span>
      </button>
    </div>
  );
}

export function Sidebar({ onNew }: { onNew: () => void }) {
  const { mode, sidebarOpen, setMode, toggleSidebar, setSettingsOpen } = useApp();
  const chat = useChat();
  const code = useCode();

  const chats = chat.chats;
  const projects = code.projects;

  return (
    <aside
      className={cn(
        // min-w-0 is load-bearing: a flex item defaults to min-width:auto, so
        // w-0 alone is floored at the panel's min-content width and the
        // sidebar never actually closes.
        'flex min-w-0 shrink-0 flex-col overflow-hidden rounded-2xl border border-border bg-sidebar shadow-[0_18px_44px_rgba(0,0,0,0.42)] backdrop-blur-2xl transition-[width,opacity] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]',
        sidebarOpen ? 'w-62 opacity-100' : 'w-0 border-transparent opacity-0',
      )}
    >
      {/* brand */}
      <div className="flex h-14 shrink-0 items-center justify-between pr-2.5 pl-4">
        <div className="flex items-center gap-2.5 whitespace-nowrap">
          <img src={logo} alt="" className="size-6 rounded-lg" />
          <span className="font-heading text-[15px] font-bold tracking-tight">Simba</span>
        </div>
        <button
          type="button"
          onClick={toggleSidebar}
          title="Close sidebar  (Ctrl+B)"
          className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelLeftClose className="size-4" />
        </button>
      </div>

      {/* new */}
      <div className="px-2.5">
        <button
          type="button"
          onClick={onNew}
          className="flex h-9.5 w-full items-center gap-2.5 whitespace-nowrap rounded-xl border border-transparent px-3 text-[13.5px] transition-colors hover:border-ring hover:bg-card"
        >
          <Plus className="size-4 shrink-0 text-purple-2" />
          {mode === 'chat' ? 'New chat' : 'New session'}
        </button>
      </div>

      {/* mode switcher */}
      <div className="mx-2.5 mt-3 mb-2 flex gap-1 rounded-xl border border-border bg-black/30 p-1">
        {(['chat', 'code'] as const).map((m) => {
          const Icon = m === 'chat' ? MessageSquare : Terminal;
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-[12.5px] capitalize transition-all',
                active
                  ? 'bg-[image:var(--gradient)] text-white shadow-[0_2px_8px_rgba(0,0,0,0.35)]'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" />
              {m}
            </button>
          );
        })}
      </div>

      {/* list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {mode === 'chat' ? (
          chats.length === 0 ? (
            <p className="px-3 pt-6 text-[12.5px] leading-relaxed text-dim">
              No conversations yet. Ask something and it appears here.
            </p>
          ) : (
            chats.map((c: Chat, i: number) => {
              const group = dateGroup(c.updatedAt);
              const showLabel = i === 0 || dateGroup(chats[i - 1].updatedAt) !== group;
              return (
                <div key={c.id}>
                  {showLabel && <GroupLabel>{group}</GroupLabel>}
                  <Row
                    icon="chat"
                    label={c.title}
                    active={chat.currentId === c.id}
                    onOpen={() => chat.open(c.id)}
                    onRename={(v) => chat.rename(c.id, v)}
                    onDelete={() => chat.remove(c.id)}
                  />
                </div>
              );
            })
          )
        ) : (
          <>
            <GroupLabel>Projects</GroupLabel>
            {projects.length === 0 ? (
              <p className="px-3 pt-2 text-[12.5px] leading-relaxed text-dim">
                No project open. Choose a folder to start.
              </p>
            ) : (
              projects.map((p: Project) => (
                <Row
                  key={p.id}
                  icon="folder"
                  label={p.name}
                  active={code.currentId === p.id}
                  onOpen={() => code.openProject(p.id)}
                  onRename={(v) => code.renameProject(p.id, v)}
                  onDelete={() => code.removeProject(p.id)}
                />
              ))
            )}
          </>
        )}
      </div>

      {/* update pill — only present when there is something to install */}
      <UpdatePill />

      {/* settings */}
      <div className="shrink-0 border-t border-border p-2.5">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex h-9.5 w-full items-center gap-2.5 whitespace-nowrap rounded-xl border border-transparent px-3 text-[13.5px] transition-colors hover:border-ring hover:bg-card"
        >
          <SettingsIcon className="size-4 shrink-0 text-purple-2" />
          Settings
        </button>
      </div>
    </aside>
  );
}
