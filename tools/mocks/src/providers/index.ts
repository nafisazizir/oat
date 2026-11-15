import type { MockProviderFactory } from '../provider.ts';
import { exampleProvider } from './example.ts';
import { gcalProvider } from './gcal/index.ts';
import { llmProvider } from './llm/index.ts';
import { sttProvider } from './stt.ts';

/**
 * Every provider the mocks service mounts, in order. Add new providers here (`notion` 8.1).
 */
export const defaultProviders: MockProviderFactory[] = [
  exampleProvider,
  llmProvider,
  sttProvider,
  () => gcalProvider(),
];
