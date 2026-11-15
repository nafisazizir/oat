import { describe } from 'vitest';

import { createMemoryBroker } from './broker';
import { brokerContract } from './broker-contract';

describe('memory broker', () => brokerContract(createMemoryBroker));
