import { notFound } from 'next/navigation';

import { MeetingHeaderPlayground } from './playground';

/** Dev-only: the meeting header (B) in every state, with the real components. A 404 in production. */
export default function MeetingHeaderProbe() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <MeetingHeaderPlayground />;
}
