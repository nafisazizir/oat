/**
 * Tests only: `node archive-crash-child.ts <path>` archives a deterministic voice-like signal forever (faster
 * than real time, yielding to the event loop) so the parent can SIGKILL it mid-recording and run recovery.
 * Prints `ready` once the first audio page is on its way.
 */
import { OpusArchiveWriter } from '../opus-archive.ts';
import { toFrames, voiceLike } from './signals.ts';

const path = process.argv[2];
if (!path) throw new Error('usage: archive-crash-child.ts <path>');

const RATE = 16_000;
const signal = voiceLike(RATE * 600, RATE, 3); // 10 minutes, more than any test waits for
const writer = await OpusArchiveWriter.open({ path, originUs: 0, pageMs: 200, fsyncMs: 1000 });
let announced = false;
for (const [i, frame] of toFrames(signal).entries()) {
  await writer.write(frame);
  if (!announced && writer.stats.pages > 3) {
    announced = true;
    process.stdout.write('ready\n');
  }
  if (i % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
}
