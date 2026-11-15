/**
 * `@oat/ai/chat/testing` (tests and evals only): the chat model served by the **mock LLM's own code**
 * (`@oat/mocks` `llmProvider`, incl. its scripted tool loop) in-process — no port, no container — through the
 * same OpenAI-compatible provider path production uses against the mocks service.
 */
import { llmProvider } from '@oat/mocks';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createAi } from '../provider.ts';

const BASE = 'http://oat-mock-llm.invalid/v1';

/** A `chat`-role model backed by an in-process mock LLM (deterministic, supports tool calls). */
export function createMockChatModel(): LanguageModelV4 {
  const { app } = llmProvider();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return app.request(url.pathname + url.search, init);
  };
  return createAi({ env: { AI_BASE_URL: BASE }, fetch }).getModel('chat');
}
