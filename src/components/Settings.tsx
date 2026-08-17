/**
 * Settings — deliberately has no credential fields.
 *
 * Chat and Code carry separate credentials, built into the app and managed
 * for the user. Neither mode can reach the other's, and neither ever appears
 * in the interface, so there is nothing here to configure or leak.
 */

import { useState } from 'react';
import { ArrowLeft, User, SlidersHorizontal, Palette, Info, ShieldCheck, Cpu, RefreshCw } from 'lucide-react';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { toast } from 'sonner';

import { useApp, useCode } from '@/store';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';

const APP_VERSION = '0.1.0';

function Card({
  icon: Icon, title, help, children,
}: {
  icon: typeof User;
  title: string;
  help?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="mb-4 rounded-2xl border border-border bg-card p-5 backdrop-blur-xl transition-all duration-300 hover:-translate-y-1 hover:border-ring">
      <div className="mb-1.5 flex items-center gap-3">
        <span className="grid size-8 place-items-center rounded-lg bg-primary/18 text-purple-2">
          <Icon className="size-4" />
        </span>
        <h3 className="font-heading text-[14.5px] font-semibold">{title}</h3>
      </div>
      {help && <p className="mt-2 mb-4 text-[12.5px] leading-relaxed text-muted-foreground">{help}</p>}
      {children}
    </section>
  );
}

function Toggle({
  label, sub, checked, onChange,
}: { label: string; sub: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div>
        <div className="text-[13.5px]">{label}</div>
        <div className="mt-0.5 text-[11.5px] text-dim">{sub}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * Updates.
 *
 * The app checks a signed manifest on GitHub, downloads the new installer and
 * relaunches into it. Signature verification is done by the updater plugin
 * against the public key baked into tauri.conf.json, so a tampered release
 * cannot install itself.
 */
function UpdateCard() {
  const [state, setState] = useState<'idle' | 'checking' | 'none' | 'installing'>('idle');
  const [found, setFound] = useState<{ version: string; notes?: string } | null>(null);

  const look = async () => {
    setState('checking');
    setFound(null);
    try {
      const update = await check();
      if (!update) {
        setState('none');
        return;
      }
      setFound({ version: update.version, notes: update.body });
      setState('idle');
    } catch (err) {
      setState('idle');
      toast(`Could not check for updates: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const install = async () => {
    setState('installing');
    try {
      const update = await check();
      if (!update) return;
      await update.downloadAndInstall();
      await relaunch();
    } catch (err) {
      setState('idle');
      toast(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <Card
      icon={RefreshCw}
      title="Updates"
      help="Simba checks for a new version and installs it for you. Your chats and settings are kept."
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={found ? install : look}
          disabled={state === 'checking' || state === 'installing'}
          className="rounded-full bg-[image:var(--gradient)] px-4 py-2 text-xs text-white transition-transform hover:-translate-y-0.5 disabled:opacity-50"
        >
          {state === 'checking' ? 'Checking…'
            : state === 'installing' ? 'Installing…'
            : found ? `Install ${found.version}`
            : 'Check for updates'}
        </button>
        <span className="text-[12.5px] text-muted-foreground">
          {state === 'none' ? `You're on the latest version (${APP_VERSION})`
            : found ? `Version ${found.version} is available`
            : `Currently on ${APP_VERSION}`}
        </span>
      </div>
      {found?.notes && (
        <p className="mt-3 border-l-2 border-purple pl-3 text-[12px] leading-relaxed whitespace-pre-wrap text-dim">
          {found.notes}
        </p>
      )}
    </Card>
  );
}

export function Settings() {
  const app = useApp();
  const code = useCode();

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
        <div className="mx-auto max-w-[690px] px-8 pt-2 pb-16">
          <h2 className="mt-4 mb-1.5 font-heading text-[26px] font-bold">Settings</h2>
          <p className="mb-7 text-[13.5px] text-muted-foreground">
            Simba is ready to use — there is nothing to configure before you start.
          </p>

          <div className="mb-5 flex items-start gap-3 rounded-2xl border border-ring bg-primary/8 p-4">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-purple-2" />
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              Chat and Code run on their own separate credentials, built into the app and managed
              for you. Neither mode can reach the other's, and neither ever appears in the interface.
            </p>
          </div>

          <Card icon={User} title="Profile" help="Used for the greeting above the composer. Leave it blank and the greeting drops the name.">
            <Input
              value={app.userName}
              placeholder="Your name"
              onChange={(e) => app.setUserName(e.target.value)}
              className="h-9.5"
            />
          </Card>

          <Card icon={SlidersHorizontal} title="Behaviour">
            <Toggle
              label="Start Code mode in Plan"
              sub="Read-only until you switch to Build. Nothing is edited or run."
              checked={code.planMode}
              onChange={code.setPlanMode}
            />
            <Toggle
              label="Send on Enter"
              sub="Off means Enter adds a newline and Ctrl+Enter sends."
              checked={app.sendOnEnter}
              onChange={app.setSendOnEnter}
            />
          </Card>

          <Card
            icon={Cpu}
            title="Code engine"
            help="The agent runs as a separate Node process so the terminal CLI and this app share one codebase and one session history in ~/.simba/sessions."
          >
            <div className="flex items-center gap-2.5 text-[13px]">
              <span
                className={`size-2 rounded-full ${code.nodeVersion === null ? 'bg-destructive' : code.nodeVersion === 'unknown' ? 'bg-dim' : 'bg-teal'}`}
              />
              <span className="text-muted-foreground">
                {code.nodeVersion === null
                  ? 'Node.js not found — Code mode is unavailable'
                  : code.nodeVersion === 'unknown'
                    ? 'Checking for Node.js…'
                    : `Node.js ${code.nodeVersion}`}
              </span>
            </div>
            {code.skills.length > 0 && (
              <div className="mt-4">
                <div className="mono-label mb-2 text-dim">Skills available</div>
                <div className="flex flex-wrap gap-1.5">
                  {code.skills.map((s) => (
                    <span
                      key={s.name}
                      title={s.description}
                      className="rounded-full border border-border px-2.5 py-1 text-[11.5px] text-muted-foreground"
                    >
                      {s.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </Card>

          <Card
            icon={Palette}
            title="Appearance"
            help="Dark only, as in both existing apps. Purple and indigo are the chrome; teal and amber stay reserved as content signals for code and writing."
          >
            <div className="flex items-center gap-2.5">
              <span className="size-7 rounded-lg bg-[image:var(--gradient)]" />
              <span className="size-7 rounded-lg bg-purple-2" />
              <span className="size-7 rounded-lg bg-teal" />
              <span className="size-7 rounded-lg bg-amber" />
              <span className="mono-label ml-2 text-dim">chrome · accent · code · writing</span>
            </div>
          </Card>

          <UpdateCard />

          <Card icon={Info} title="About">
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              Simba Desktop {APP_VERSION}<br />
              Chat is powered by Simba AI · Code by Simba Agent<br />
              Made by Om Dixit
            </p>
          </Card>
        </div>
      </div>
    </section>
  );
}
