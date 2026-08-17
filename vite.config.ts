import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Credentials are read here and substituted at transform time, so they end up
  // inside the bundle and never appear in source or in the interface. Done
  // through define() rather than left to import.meta.env resolution, because
  // this is the one thing that must not silently come back empty.
  const env = loadEnv(mode, import.meta.dirname, 'VITE_')
  const embed = (name: string) => JSON.stringify(env[name] ?? '')

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, './src') },
    },
    // Plain identifiers, not import.meta.env members: Vite owns the latter and
    // its own env plugin wins over define(), which leaves the reference intact
    // and the value empty at runtime.
    define: {
      __SIMBA_CHAT_KEY__: embed('VITE_CHAT_OPENROUTER_KEY'),
      __SIMBA_CODE_KEY__: embed('VITE_CODE_OPENROUTER_KEY'),
      __SIMBA_TAVILY_KEY__: embed('VITE_CODE_TAVILY_KEY'),
    },
    // Tauri expects a fixed port and surfaces Rust errors in the terminal, so
    // the dev server must not silently hop to another one.
    clearScreen: false,
    server: { port: 1420, strictPort: true },
  }
})
