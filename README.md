# Simba Desktop

Chat and code in one window. **Chat** is Simba AI; **Code** is Simba Agent —
the terminal coding agent, driven from a real interface instead of a TUI.

Windows 10/11, 64-bit. Built with Tauri 2, React and shadcn/ui.

## Install

Download `Simba_x.y.z_x64-setup.exe` from
[Releases](https://github.com/sppideey/simba-desktop/releases/latest) and run it.

Windows will show *"Windows protected your PC"* because the build is unsigned —
**More info → Run anyway**. The app updates itself after that.

Nothing else to install. The installer carries its own Node runtime and its own
copy of the agent, so Code mode works on a machine that has never had Node,
npm or the `simba` CLI on it.

> **Upgrading from 2.1.0 or earlier:** install 2.2.0 by hand, once. The updater
> signing key was replaced in 2.2.0 and older builds only trust the old one, so
> they will refuse the update rather than apply it. From 2.2.0 onward
> auto-update works normally again.

## What it does

**Chat** — streaming answers, maths rendered with KaTeX, syntax-highlighted
code, charts, four-quadrant function graphs, and Word export. Attach images,
PDFs and text files, or dictate with the microphone.

**Code** — point it at a folder and it reads, edits and runs your project.
Every file operation is sandboxed to that folder; anything outside it asks
first. It detects how your project tests itself and is made to actually run
that before claiming a change works.

It has nineteen tools, including symbol-level ones — find a definition, outline
a file, rename across a project, read a type — and nine skills it loads by
itself when the job calls for them. It can scaffold a Next.js + shadcn/ui app
or a plain HTML one from bundled templates.

There is no web search and no deploy. Both were removed from the engine in
1.19.0, so neither the model nor the interface can reach them.

Sessions live in `~/.simba/sessions`, shared with the `simba` CLI — start a
conversation in one and pick it up in the other.

## Developing

```bash
pnpm install
pnpm app
```

Needs Rust and the MSVC build tools for the native shell.

Credentials come from a gitignored `.env.local`:

```
VITE_CHAT_OPENROUTER_KEY=sk-or-v1-...
VITE_CODE_OPENROUTER_KEY=sk-or-v1-...
```

`scripts/gen-keys.mjs` turns that into `src/lib/keys.generated.ts` before every
dev run and build. Chat and Code keep **separate** credentials and neither mode
can read the other's.

> These are substituted at build time, which means they are present in plain
> text inside `dist/` and inside any installer built from it. Treat every
> published build as publishing its keys.

```bash
pnpm app:build      # path to the installers is printed at the end
```

`app:build` runs `bundle-sidecar.mjs` and then `bundle-node.mjs`, **in that
order and not the other way round**: the first wipes the staging directory
before filling it, so running it second leaves a bundle with no Node in it.

### Releasing

Building does not publish. The updater reads one file on GitHub, and until that
file changes, no installed copy knows a new version exists.

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.simba/simba-updater-v2.key)" pnpm app:build
```

Then create a GitHub release tagged `v<version>` holding the installer, its
`.sig`, and a `latest.json` naming the version and carrying that signature.
Past releases are staged under `D:\simba-build\release-stage-<version>`.

The signing key is `~/.simba/simba-updater-v2.key` and **has no password**. That
is deliberate. The original key had one, it was forgotten, and because the
matching public key is compiled into every installed copy, that permanently cut
2.1.0 and earlier off from auto-update. A key file you must keep safe is a
smaller risk than a password you must keep remembering. Keep a backup of it: if
it is lost, every install is stranded again.

## Layout

| Path | |
| --- | --- |
| `src/` | React app — `lib/chat` is ported from the Simba AI web app |
| `sidecar/` | Headless agent host. `rpc-ui.js` implements the agent's UI interface, emitting JSON instead of ANSI |
| `src-tauri/` | Native shell; owns the sidecar process |
| `scripts/` | Key generation, sidecar and Node staging |

## How Code mode works

The agent is not reimplemented here. `sidecar/server.js` builds the same `Agent`
the CLI builds and swaps in `RpcUI`, which speaks JSON where the terminal UI
speaks ANSI. `src/lib/agent/client.ts` is the other end of that protocol.

The engine picks its own UI from whether stdout is a TTY. The sidecar is spawned
with piped stdio, so it never constructs the full-screen one — which matters,
because that one writes escape sequences to stdout, and stdout is the protocol.

`bundle-sidecar.mjs` copies the agent's published files into the installer at
build time, so Code mode ships with the engine rather than fetching it. The
version it copies is whatever is in `../TERMINAL-AGENT/simba-agent` when you
build.

Imports go through the names the agent's `exports` map publishes — `agent`,
`provider`, `history`, `context`, `shell` — not through file paths. The 1.19.0
rewrite moved every module this app imported, and the map exists so the next
reshuffle costs nothing.

Made by Om Dixit.
