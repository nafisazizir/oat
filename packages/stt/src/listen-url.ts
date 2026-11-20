export interface ListenParams {
  sampleRate: number;
  model: string;
  language?: string;
  keyterms?: readonly string[];
  interimResults: boolean;
  smartFormat: boolean;
  endpointingMs: number | false;
  mipOptOut: boolean;
}

/** Shared browser/Node wire format; no runtime or credential dependencies. */
export function buildListenUrl(
  listenUrl: string,
  params: ListenParams,
  extra: Readonly<Record<string, string | number | boolean>> = {},
): string {
  const url = new URL(listenUrl);
  const q = url.searchParams;
  q.set('model', params.model);
  q.set('encoding', 'linear16');
  q.set('sample_rate', String(params.sampleRate));
  q.set('channels', '1');
  q.set('interim_results', String(params.interimResults));
  q.set('smart_format', String(params.smartFormat));
  q.set('endpointing', String(params.endpointingMs));
  if (params.mipOptOut) q.set('mip_opt_out', 'true');
  if (params.language) q.set('language', params.language);
  for (const term of params.keyterms ?? []) q.append('keyterm', term);
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  return url.toString();
}
