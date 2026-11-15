/**
 * Step bookkeeping on `pipeline_run` (8.3): what the meeting header shows. Lives outside `agent/lib` because the
 * workflow file may only reach Node-only modules (the database) from inside its `"use step"` bodies.
 */
import { markPipelineStep, type PipelineRunRef, recordPipelineStep } from '@oat/services/pipeline';

import { stepContext } from './context.ts';
import { type Busy, isBusy, type StepName, type StepRecord } from './types.ts';

/**
 * Marks the step on the run, runs it, records a final answer (a busy one leaves the step marked). A step that
 * had to wait (`busySince`: its first busy answer) records how long as `detail.waitedMs`.
 */
export async function tracked<T extends StepRecord | Busy>(
  ref: PipelineRunRef,
  step: StepName,
  work: () => Promise<T>,
  busySince?: number,
): Promise<T> {
  const { db } = stepContext();
  await markPipelineStep(db, ref, step);
  const result = await work();
  if (isBusy(result)) return result;
  const record: StepRecord =
    busySince === undefined
      ? result
      : {
          ...result,
          detail: { ...result.detail, waitedMs: Math.max(0, Date.parse(result.at) - busySince) },
        };
  await recordPipelineStep(db, ref, record);
  return record as T;
}
