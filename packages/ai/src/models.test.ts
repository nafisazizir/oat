import { describe, expect, it } from 'vitest';
import {
  AI_ROLES,
  DEFAULT_MODELS,
  EMBEDDING_DIMENSIONS,
  isAiRole,
  modelEnvVar,
  resolveModelId,
  resolveModels,
} from './models.ts';

describe('model registry', () => {
  it('maps every role to a provider/model gateway id, Claude for text', () => {
    expect([...AI_ROLES]).toEqual(['enhance', 'chat', 'fast', 'judge', 'embed']);
    for (const role of AI_ROLES) expect(DEFAULT_MODELS[role]).toMatch(/^[a-z]+\/[\w.-]+$/);
    expect(DEFAULT_MODELS.enhance).toMatch(/^anthropic\/claude-/);
    expect(DEFAULT_MODELS.chat).toMatch(/^anthropic\/claude-/);
    expect(DEFAULT_MODELS.fast).toMatch(/^anthropic\/claude-/);
    // The eval judge comes from a different provider than the models it grades.
    expect(DEFAULT_MODELS.judge.split('/')[0]).not.toBe(DEFAULT_MODELS.enhance.split('/')[0]);
  });

  it('shares the embedding width with the db', () => {
    expect(EMBEDDING_DIMENSIONS).toBe(1536);
  });

  it('uses defaults when no override is set or the override is blank', () => {
    expect(resolveModels({})).toEqual(DEFAULT_MODELS);
    expect(resolveModelId('fast', { AI_MODEL_FAST: '  ' })).toBe(DEFAULT_MODELS.fast);
  });

  it('applies AI_MODEL_<ROLE> overrides per role', () => {
    expect(modelEnvVar('enhance')).toBe('AI_MODEL_ENHANCE');
    const env = {
      AI_MODEL_ENHANCE: 'anthropic/claude-opus-5.5',
      AI_MODEL_EMBED: 'voyage/voyage-4',
    };
    expect(resolveModels(env)).toEqual({
      ...DEFAULT_MODELS,
      enhance: 'anthropic/claude-opus-5.5',
      embed: 'voyage/voyage-4',
    });
  });

  it('rejects malformed overrides and unknown roles', () => {
    expect(() => resolveModelId('chat', { AI_MODEL_CHAT: 'claude' })).toThrow(/AI_MODEL_CHAT/);
    expect(() => resolveModelId('nope' as 'chat')).toThrow(/unknown AI role/);
    expect(isAiRole('embed')).toBe(true);
    expect(isAiRole('EMBED')).toBe(false);
  });
});
