/**
 * updater.ts — one place that knows how updating works.
 *
 * Both the sidebar pill and Settings call these, so there is a single path to
 * debug rather than two that drift apart.
 *
 * Errors are recorded in the store rather than swallowed. An update that
 * silently does nothing is indistinguishable from one that is broken, and
 * that ambiguity has already cost real time here.
 */

import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

import { useApp } from '@/store';

/** Held between "found" and "install", so the click does not re-download. */
let pending: Update | null = null;

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Tauri surfaces "Could not fetch a valid release JSON" for both offline and
  // a malformed manifest; saying which is not possible, so say what to do.
  if (/fetch|network|connect|dns|timed? ?out/i.test(message)) {
    return 'Could not reach the update server. Check your connection.';
  }
  return message;
}

/** Look for a newer version. Returns true when one is waiting. */
export async function lookForUpdate(quiet = true): Promise<boolean> {
  const { setUpdate } = useApp.getState();
  if (!quiet) setUpdate({ state: 'checking', error: null });

  try {
    const update = await check();
    if (!update) {
      pending = null;
      setUpdate({ state: 'idle', version: null, error: null });
      return false;
    }
    pending = update;
    setUpdate({ state: 'ready', version: update.version, error: null });
    return true;
  } catch (err) {
    pending = null;
    // A background check that fails quietly should not paint an error over the
    // sidebar; an explicit one the user asked for absolutely should.
    setUpdate(quiet ? { state: 'idle' } : { state: 'error', error: describe(err) });
    return false;
  }
}

/**
 * Download and install, then restart.
 *
 * On Windows the installer replaces files the running app is using, so Tauri
 * exits the process itself once the installer takes over — which means the
 * relaunch below often never runs. That is expected, not a failure, so it is
 * attempted and ignored rather than treated as an error.
 */
export async function installUpdate(): Promise<void> {
  const { setUpdate } = useApp.getState();
  setUpdate({ state: 'installing', error: null });

  try {
    const update = pending ?? (await check());
    if (!update) {
      setUpdate({ state: 'idle', version: null });
      return;
    }
    await update.downloadAndInstall();
    try {
      await relaunch();
    } catch {
      /* the process is already on its way out */
    }
  } catch (err) {
    setUpdate({ state: 'error', error: describe(err) });
  }
}
