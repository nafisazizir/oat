import 'server-only';

import type { Actor } from '@oat/services/actor';
import {
  agentsDispatcherFromEnv,
  type PipelineDeps,
  requestPostMeeting,
} from '@oat/services/pipeline';
import { after } from 'next/server';

import { apiDeps } from '../api';
import { getDb } from '../db';
import { createPipelineApi } from './api';

/**
 * The real pipeline deps: the app database and the agents server at `OAT_AGENTS_URL` with `OAT_AGENTS_TOKEN`
 * (D-29; without a token runs wait for the agents' own sweep).
 */
export function pipelineDeps(): PipelineDeps {
  return {
    db: getDb(),
    dispatcher: agentsDispatcherFromEnv(process.env),
    logError: (message, error) => console.error(`[pipeline] ${message}`, error),
  };
}

/** The pipeline routes bound to the real deps (route files re-export these). */
export const pipelineApi = createPipelineApi(apiDeps, pipelineDeps);

/**
 * A meeting ended (desktop sync push): start its post-meeting run after the response is sent, as the user who
 * ended it (authorised again inside: owner/editor of the note). Failures are logged, never surfaced to sync.
 */
export function onMeetingEnded(actor: Actor, meetingId: string): void {
  after(async () => {
    try {
      await requestPostMeeting(pipelineDeps(), actor, meetingId);
    } catch (error) {
      console.error(`[pipeline] could not start the run for meeting ${meetingId}`, error);
    }
  });
}
