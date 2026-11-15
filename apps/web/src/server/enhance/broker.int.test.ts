import { describe } from 'vitest';

import { createRedisBroker } from './broker';
import { brokerContract } from './broker-contract';

// The compose Redis (`pnpm dev:up`); keys are random UUIDs and expire, so runs never collide.
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:63790';

describe('redis broker', () => brokerContract(() => createRedisBroker(REDIS_URL)));
