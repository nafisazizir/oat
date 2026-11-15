/**
 * Eval suites and their fixture meetings (SPEC §7, D-13). All fixture content is synthetic and written for Oat.
 * The 3 audio-backed fixtures reuse `fixtures/audio/*.segments.json` as their transcripts.
 */
import { fileURLToPath } from 'node:url';
import { createChatSuite } from '../src/evals/chat-suite.ts';
import { createEnhanceSuite, type EnhanceFixture } from '../src/evals/enhance-suite.ts';
import type { EvalSuite } from '../src/evals/types.ts';
import { CHAT_FIXTURES } from './chat/fixtures.ts';
import { interview } from './fixtures/interview.ts';
import { oneOnOne } from './fixtures/one-on-one.ts';
import { salesDiscovery } from './fixtures/sales-discovery.ts';
import { silenceGap } from './fixtures/silence-gap.ts';
import { standup } from './fixtures/standup.ts';
import { EVAL_TEMPLATES } from './templates.ts';

export const ENHANCE_FIXTURES: readonly EnhanceFixture[] = [
  oneOnOne,
  standup,
  silenceGap,
  salesDiscovery,
  interview,
];

export const BASELINE_PATH = fileURLToPath(new URL('./baseline.json', import.meta.url));

export function createSuites(): Record<string, EvalSuite> {
  return {
    enhance: createEnhanceSuite({ fixtures: ENHANCE_FIXTURES, templates: EVAL_TEMPLATES }),
    chat: createChatSuite(CHAT_FIXTURES),
  };
}
