import { createOatClient } from '@oat/client';
import { bridgeTransport } from '@oat/client/bridge';

import { bridge } from '../bridge';
import { observeApi } from '../workspace/api-status';

export const apiTransport = observeApi((request) => bridgeTransport(bridge())(request));
export const api = createOatClient(apiTransport);
