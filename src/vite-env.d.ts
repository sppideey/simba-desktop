/// <reference types="vite/client" />

/**
 * Credentials, substituted by vite.config.ts at transform time.
 *
 * Declared as plain globals rather than read from import.meta.env: Vite owns
 * that namespace and its own env plugin overrides define(), which silently
 * leaves the value empty.
 */
declare const __SIMBA_CHAT_KEY__: string;
declare const __SIMBA_CODE_KEY__: string;
declare const __SIMBA_TAVILY_KEY__: string;
