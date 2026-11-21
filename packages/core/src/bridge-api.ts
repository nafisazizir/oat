import { z } from 'zod';

export const apiRequestSchema = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1).max(2048),
  query: z
    .record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))
    .optional(),
  body: z.json().optional(),
});
export type BridgeApiRequest = z.infer<typeof apiRequestSchema>;

const streamId = z.string().min(1);
export const apiInvokeChannels = {
  'api:request': {
    request: apiRequestSchema,
    response: z.strictObject({ status: z.number().int(), body: z.json() }),
  },
  'api:stream-open': {
    request: apiRequestSchema,
    response: z.strictObject({
      streamId,
      status: z.number().int(),
      headers: z.record(z.string(), z.string()),
    }),
  },
  'api:stream-cancel': {
    request: z.strictObject({ streamId }),
    response: z.undefined(),
  },
} as const;

export const apiSubscribeChannels = {
  'api:stream-chunk': z.strictObject({ streamId, chunk: z.string() }),
  'api:stream-end': z.strictObject({
    streamId,
    error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
  }),
} as const;
