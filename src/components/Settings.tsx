/**
 * Settings — three things only: your name, the version, and a short guide.
 *
 * There are no credential fields. Chat and Code carry separate keys, built
 * into the app and managed for you, and neither mode can reach the other's.
 */

import { useState } from 'react';
import { ArrowLeft, User, RefreshCw, BookOpen } from 'lucide-react';

import { useApp } from '@/store';
import { installUpdate, lookForUpdate } from '@/lib/updater';
import { Input } from '@/components/ui/input';
import { getVersion } from '@tauri-apps/api/app';
import { useEffect } from 'react';

function Card({
  icon: Icon, title, children,
}: { icon: typeof User; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 rounded-2xl border border-border bg-card p-5 backdrop-blur-xl">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid size-8 place-items-center rounded-lg bg-primary/18 text-purple-2">
          <Icon className="size-4" />
        </span>
        <h3 className="font-heading text-[14.5px] font-semibold">{title}</h3>
      </div>
      {children}
    </section>
  );
}

/**
 * Version, and the button that pulls the next one down.
 *
 * Shares its state with the sidebar pill, so the two can never disagree about
 * whether an update is waiting.
 */
function Version() {
  const [version, setVersion] = useState('');
  const state = useApp((s) => s.updateState);
  const found = useApp((s) => s.updateVersion);
  const error = useApp((s) => s.updateError);

  useEffect(() => { getVersion().then(setVersion).catch(() => setVersion('')); }, []);

  const busy = state === 'checking' || state === 'installing';

  return (
    <Card icon={RefreshCw} title="Version">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void (state === 'ready' ? installUpdate() : lookForUpdate(false))}
          disabled={busy}
          className="rounded-full bg-[image:var(--gradient)] px-4 py-2 text-xs text-white transition-transform hover:-translate-y-0.5 disabled:opacity-50"
        >
          {state === 'checking' ? 'Checking…'
            : state === 'installing' ? 'Installing…'
            : state === 'ready' ? `Install ${found}`
            : 'Check for updates'}
        </button>
        <span className="text-[12.5px] text-muted-foreground">
          {state === 'ready' ? `Version ${found} is ready`
            : `Simba ${version}`}
        </span>
      </div>
      {state === 'error' && error && (
        <p className="mt-3 text-[12px] leading-relaxed text-destructive">{error}</p>
      )}
    </Card>
  );
}

const GUIDE: Array<[string, string]> = [
  ['Chat', 'Ask anything. Attach files with +, or dictate with the mic. Ask for a chart, a graph or a Word file and you get one.'],
  ['Code', 'Pick a folder, then say what you want changed. Simba reads, edits and runs it, and asks before touching anything outside that folder.'],
  ['Shortcuts', 'Ctrl+B hides the sidebar · Ctrl+, opens settings · Enter sends'],
];

export function Settings() {
  const app = useApp();

  return (
    <section className="absolute inset-0 z-30 flex flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2.5 px-5">
        <button
          type="button"
          onClick={() => app.setSettingsOpen(false)}
          className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </button>
        <span className="text-[13px] text-muted-foreground">Settings</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[620px] px-8 pt-2 pb-16">
          <h2 className="mt-4 mb-7 font-heading text-[26px] font-bold">Settings</h2>

          <Card icon={User} title="Your name">
            <Input
              value={app.userName}
              placeholder="Your name"
              onChange={(e) => app.setUserName(e.target.value)}
              className="h-9.5"
            />
            <p className="mt-2.5 text-[12px] text-dim">Used in the greeting. Leave blank to skip it.</p>
          </Card>

          <Version />

          <Card icon={BookOpen} title="How to use it">
            <dl className="space-y-3">
              {GUIDE.map(([term, text]) => (
                <div key={term}>
                  <dt className="mono-label mb-1 text-purple-2">{term}</dt>
                  <dd className="text-[12.5px] leading-relaxed text-muted-foreground">{text}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <p className="mt-6 text-center text-[11.5px] text-dim">Made by Om Dixit</p>
        </div>
      </div>
    </section>
  );
}
