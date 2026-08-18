/**
 * bundle-node.mjs — ship a Node runtime inside the installer.
 *
 * Code mode runs the agent as a Node process. Without this, every machine
 * needs Node installed separately, which is a prerequisite most people will
 * never satisfy — and the failure looks like "the app is broken" rather than
 * "something is missing".
 *
 * Only node.exe is needed: the agent is plain ESM with no native modules, so
 * there is nothing to compile and no npm to ship.
 *
 * Cached in src-tauri/node-cache so repeat builds do not re-download ~80MB.
 */

import { createWriteStream, existsSync, mkdirSync, statSync, copyFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = 'v22.14.0';
const URL = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'src-tauri', 'node-cache');
const cached = join(cacheDir, `node-${NODE_VERSION}.exe`);
const target = join(root, 'src-tauri', 'sidecar-dist', 'node.exe');

mkdirSync(cacheDir, { recursive: true });

if (!existsSync(cached)) {
  console.log(`[bundle-node] downloading Node ${NODE_VERSION} (~80MB, once)…`);
  const response = await fetch(URL);
  if (!response.ok) {
    console.error(`[bundle-node] download failed: HTTP ${response.status}`);
    process.exit(1);
  }
  await pipeline(response.body, createWriteStream(`${cached}.partial`));
  // Rename only after a complete download, so an interrupted build cannot
  // leave a truncated binary that looks cached.
  const { renameSync } = await import('node:fs');
  renameSync(`${cached}.partial`, cached);
}

const size = statSync(cached).size;
if (size < 20_000_000) {
  console.error(`[bundle-node] cached node.exe is only ${size} bytes — refusing to ship it`);
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(cached, target);
console.log(`[bundle-node] staged node.exe (${Math.round(size / 1024 / 1024)}MB)`);
