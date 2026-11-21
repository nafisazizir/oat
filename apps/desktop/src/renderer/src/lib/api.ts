import { createOatClient } from '@oat/client';
import { bridgeTransport } from '@oat/client/bridge';

import { bridge } from '../bridge';

export const apiTransport = bridgeTransport(bridge());
export const api = createOatClient(apiTransport);
