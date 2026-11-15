import type { MockProviderFactory } from '../provider.ts';
import { exampleProvider } from './example.ts';

/**
 * Every provider the mocks service mounts, in order. Add new providers here
 * (`llm` 4.1, `stt` 2.2, `gcal` 7.4, `notion` 8.1).
 */
export const defaultProviders: MockProviderFactory[] = [exampleProvider];
