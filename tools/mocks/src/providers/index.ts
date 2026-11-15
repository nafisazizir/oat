import type { MockProviderFactory } from '../provider.ts';
import { exampleProvider } from './example.ts';
import { llmProvider } from './llm/index.ts';
import { sttProvider } from './stt.ts';

/**
 * Every provider the mocks service mounts, in order. Add new providers here
 * (`gcal` 7.4, `notion` 8.1).
 */
export const defaultProviders: MockProviderFactory[] = [exampleProvider, llmProvider, sttProvider];
