import { describe, expect, it } from 'vitest';

import {
  enhanceSkipped,
  isLivePipeline,
  type PipelineRun,
  pipelineLabel,
} from './auto-stop-state.ts';

const run = (over: Partial<PipelineRun>): PipelineRun => ({
  status: 'running',
  currentStep: null,
  error: null,
  retryable: false,
  steps: [],
  ...over,
});

describe('post-meeting labels (7.5)', () => {
  it('names each state and running step', () => {
    expect(pipelineLabel(run({ status: 'waiting' }))).toBe('waiting for the pipeline…');
    expect(pipelineLabel(run({ status: 'queued' }))).toBe('starting…');
    expect(pipelineLabel(run({ currentStep: 'enhance' }))).toBe('enhancing…');
    expect(pipelineLabel(run({ currentStep: 'index' }))).toBe('indexing…');
    expect(pipelineLabel(run({ currentStep: 'notion' }))).toBe('sending to Notion…');
    expect(pipelineLabel(run({}))).toBe('running…');
    expect(pipelineLabel(run({ status: 'completed' }))).toBe('done');
    expect(pipelineLabel(run({ status: 'failed' }))).toBe('failed');
  });

  it('says why the notes weren’t enhanced only for reasons the user can act on', () => {
    const skipped = (reason: string) =>
      enhanceSkipped(run({ steps: [{ step: 'enhance', outcome: 'skipped', reason }] }));
    expect(skipped('transcript too short')).toMatch(/too short/);
    expect(skipped('auto-enhance off')).toMatch(/auto-enhance is off/);
    expect(skipped('already enhanced')).toBeNull();
    expect(enhanceSkipped(run({ steps: [{ step: 'enhance', outcome: 'ran' }] }))).toBeNull();
  });

  it('live = waiting, queued or running', () => {
    expect(isLivePipeline(null)).toBe(false);
    expect(isLivePipeline(run({ status: 'waiting' }))).toBe(true);
    expect(isLivePipeline(run({ status: 'completed' }))).toBe(false);
  });
});
