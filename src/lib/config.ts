/**
 * config.ts — credentials, models and constants.
 *
 * Chat and Code carry SEPARATE credentials and neither reads the other's.
 * Both are injected by Vite from .env.local at build time, so they are
 * embedded in the binary and never appear anywhere in the interface.
 */

import { CHAT_KEY_RAW, CODE_KEY_RAW, TAVILY_KEY_RAW } from './keys.generated';

/* ---------------------------------------------------------------- chat */

/** Chat credentials. An array: a rate-limited entry falls through to the next. */
export const CHAT_KEYS: string[] = CHAT_KEY_RAW
  .split(',')
  .map((k: string) => k.trim())
  .filter(Boolean);

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const TEXT_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

/**
 * Tried in order. Free endpoints draw on an upstream pool shared with every
 * other OpenRouter user, so the 31B returns bursts of 429 through no fault of
 * ours; the lighter Gemma is a different pool and picks up the slack.
 */
export const VISION_MODELS = [
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
];

export const MAX_TOKENS = 2048;

/** Downscale before upload: fewer tokens, faster replies. */
export const IMAGE_MAX_EDGE = 1024;

/* ---------------------------------------------------------------- code */

/** Code credentials. Handed to the agent process through its environment
    at spawn time only, so they cannot leak into a transcript. */
export const CODE_KEY: string = CODE_KEY_RAW;
export const TAVILY_KEY: string = TAVILY_KEY_RAW;

export type ModelInfo = { id: string; label: string; star?: boolean; context: number };

/**
 * Models offered in Code mode.
 *
 * Laguna and Gemma were dropped: both sit on heavily shared free pools and
 * were routinely slower than the wait was worth. What is left is ordered
 * fastest-first, so the default is the one that answers soonest.
 */
export const MODELS: ModelInfo[] = [
  { id: 'nvidia/nemotron-3.5-lightning:free', context: 1_000_000, star: true, label: 'fastest — 1M context, best default' },
  { id: 'cohere/north-mini-code:free', context: 256_000, star: true, label: 'built for code and UI work' },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', context: 262_144, label: 'stronger, still quick to answer' },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', context: 256_000, label: 'small and reasoning-tuned' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', context: 1_000_000, label: 'deepest reasoning — slow first token' },
];

export const DEFAULT_MODEL = MODELS[0].id;

/* -------------------------------------------------------------- shared */

export const SUBLINES: Record<string, string[]> = {
  morning: ['What should we build today?', 'Where should we start?', 'Ready when you are.'],
  afternoon: ['What are we working on?', 'What should we do today?', 'Pick up where we left off?'],
  evening: ['What should we build tonight?', "What's on your mind?", 'Still going — what next?'],
  night: ['Burning the midnight oil?', 'What should we do today?', 'Late one. What are we building?'],
};

export function timeBand(): keyof typeof SUBLINES {
  const h = new Date().getHours();
  if (h < 5) return 'night';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 22) return 'evening';
  return 'night';
}

export function greetingFor(band: string): string {
  return band === 'night' ? 'Good evening' : `Good ${band}`;
}

export const CHAT_SUGGESTIONS = [
  'Explain the quadratic formula',
  'Write a useInterval hook',
  'Summarise photosynthesis for a test',
];

export const CODE_SUGGESTIONS = [
  'What does this project do?',
  'Find and fix any bugs in the tests',
  'Add a test for the glob matcher',
];
