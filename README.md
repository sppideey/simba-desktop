# Simba Desktop

Chat and code in one window. **Chat** is Simba AI; **Code** is Simba Agent —
the terminal coding agent, driven from a real interface instead of a TUI.

Windows 10/11, 64-bit. Built with Tauri 2, React and shadcn/ui.

## Install

Download `Simba_x.y.z_x64-setup.exe` from
[Releases](https://github.com/sppideey/simba-desktop/releases/latest) and run it.

Windows will show *"Windows protected your PC"* because the build is unsigned —
**More info → Run anyway**. The app updates itself after that.

**Code mode needs [Node.js](https://nodejs.org) 22 or newer.** Chat mode does not.

## What it does

**Chat** — streaming answers, maths rendered with KaTeX, syntax-highlighted
code, charts, four-quadrant function graphs, and Word export. Attach images,
PDFs and text files, or dictate with the microphone.

**Code** — point it at a folder and it reads, edits and runs your project.
Every file operation is sandboxed to that folder; anything outside it asks
first. It detects how your project tests itself and is made to actually run
that before claiming a change works.

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
VITE_CODE_TAVILY_KEY=tvly-...
```

`scripts/gen-keys.mjs` turns that into `src/lib/keys.generated.ts` before every
dev run and build. Chat and Code keep **separate** credentials and neither mode
can read the other's.

```bash
pnpm app:build      # installers in target/release/bundle
```

## Layout

| Path | |
| --- | --- |
| `src/` | React app — `lib/chat` is ported from the Simba AI web app |
| `sidecar/` | Headless agent host. `rpc-ui.js` is a third implementation of the agent's UI interface, emitting JSON instead of ANSI |
| `src-tauri/` | Native shell; owns the sidecar process |
| `scripts/` | Key generation and sidecar staging |

The agent itself is unmodified. `agent.js` already chose its UI at runtime, so
Code mode needed one new file rather than a rewrite, and the CLI still works
exactly as before.

Made by Om Dixit.
