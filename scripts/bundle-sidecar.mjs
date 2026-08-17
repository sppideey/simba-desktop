/**
 * bundle-sidecar.mjs — stage everything Code mode needs into the installer.
 *
 * In development the sidecar runs straight out of ../sidecar and resolves
 * simba-agent through the pnpm workspace link. A packaged app has neither, so
 * this copies the agent's own source, its skills, and a real (non-symlinked)
 * node_modules into src-tauri/sidecar-dist/, which tauri.conf.json ships as a
 * bundle resource.
 *
 * npm is used rather than pnpm on purpose: pnpm's store is a symlink farm, and
 * symlinks do not survive being copied into an installer.
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const agentSrc = join(root, '..', 'TERMINAL-AGENT', 'simba-agent');
const stage = join(root, 'src-tauri', 'sidecar-dist');

if (!existsSync(agentSrc)) {
  console.error(`[bundle-sidecar] simba-agent not found at ${agentSrc}`);
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'agent'), { recursive: true });

// 1. The sidecar itself.
for (const file of ['server.js', 'rpc-ui.js']) {
  cpSync(join(root, 'sidecar', file), join(stage, file));
}

// 2. The agent's source, exactly the files its own package.json publishes.
const agentPkg = JSON.parse(readFileSync(join(agentSrc, 'package.json'), 'utf8'));
for (const entry of agentPkg.files ?? []) {
  const from = join(agentSrc, entry.replace(/\/$/, ''));
  if (!existsSync(from)) continue;
  cpSync(from, join(stage, 'agent', entry.replace(/\/$/, '')), { recursive: true });
}
writeFileSync(
  join(stage, 'agent', 'package.json'),
  JSON.stringify({ ...agentPkg, devDependencies: undefined, scripts: undefined }, null, 2),
);

// 3. A flat node_modules holding the agent's runtime dependencies plus the
//    agent itself, so `import 'simba-agent/agent.js'` resolves in the bundle.
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'simba-sidecar',
      private: true,
      type: 'module',
      dependencies: { ...agentPkg.dependencies, 'simba-agent': 'file:./agent' },
    },
    null,
    2,
  ),
);

console.log('[bundle-sidecar] installing agent runtime dependencies…');
execSync('npm install --omit=dev --no-audit --no-fund --install-links', {
  cwd: stage,
  stdio: 'inherit',
});

console.log(`[bundle-sidecar] staged at ${stage}`);
