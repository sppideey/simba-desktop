/**
 * publish-release.mjs — turn a signed build into a release people receive.
 *
 * Building does not publish. The updater in every installed copy reads one
 * file — latest.json, at the endpoint in tauri.conf.json — and until that file
 * names a newer version, nothing knows an update exists. This writes that file
 * and puts it on GitHub with the installer beside it.
 *
 *   node scripts/publish-release.mjs "release notes here"
 *
 * Refuses to run without a .sig: an unsigned release is one every installed
 * copy rejects, which looks exactly like the updater being broken.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const { version } = pkg;
const tag = `v${version}`;

const REPO = 'sppideey/simba-desktop';
const BUNDLE = 'D:\\simba-build\\simba-desktop\\release\\bundle';
const stage = `D:\\simba-build\\release-stage-${version.replace(/\./g, '')}`;

const setup = join(BUNDLE, 'nsis', `Simba_${version}_x64-setup.exe`);
const sig = `${setup}.sig`;
const msi = join(BUNDLE, 'msi', `Simba_${version}_x64_en-US.msi`);

for (const [label, file] of [['installer', setup], ['signature', sig]]) {
  if (!existsSync(file)) {
    console.error(`[publish] no ${label} at ${file}`);
    if (label === 'signature') {
      console.error('[publish] build with TAURI_SIGNING_PRIVATE_KEY set, or the release is dead on arrival.');
    }
    process.exit(1);
  }
}

mkdirSync(stage, { recursive: true });
copyFileSync(setup, join(stage, `Simba_${version}_x64-setup.exe`));
copyFileSync(sig, join(stage, `Simba_${version}_x64-setup.exe.sig`));
if (existsSync(msi)) copyFileSync(msi, join(stage, `Simba_${version}_x64_en-US.msi`));

const manifest = {
  version,
  notes: process.argv[2] || `Simba ${version}`,
  pub_date: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(sig, 'utf8').trim(),
      url: `https://github.com/${REPO}/releases/download/${tag}/Simba_${version}_x64-setup.exe`,
    },
  },
};

const manifestPath = join(stage, 'latest.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 4));
console.log(`[publish] staged ${stage}`);

const gh = (...args) => execFileSync('gh', args, { stdio: 'inherit' });

// Recreate rather than edit: a half-updated release is worse than a new one,
// and the endpoint points at /latest/ so only the newest tag matters.
try {
  execFileSync('gh', ['release', 'view', tag, '--repo', REPO], { stdio: 'ignore' });
  console.log(`[publish] ${tag} exists — deleting it first`);
  gh('release', 'delete', tag, '--repo', REPO, '--yes');
} catch { /* no such release, which is the normal case */ }

gh(
  'release', 'create', tag,
  '--repo', REPO,
  '--title', `Simba ${version}`,
  '--notes', manifest.notes,
  join(stage, `Simba_${version}_x64-setup.exe`),
  join(stage, `Simba_${version}_x64-setup.exe.sig`),
  ...(existsSync(join(stage, `Simba_${version}_x64_en-US.msi`))
    ? [join(stage, `Simba_${version}_x64_en-US.msi`)]
    : []),
  manifestPath,
);

console.log(`[publish] ${tag} is live`);
console.log(`[publish] verify: curl -sL https://github.com/${REPO}/releases/latest/download/latest.json`);
