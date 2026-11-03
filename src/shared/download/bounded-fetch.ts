// Reading an answer from the internet with a size limit: a server cannot make this PC download without end. Node
// built-ins only (it is part of the shared download helpers).
import { fetchRetry } from './http.js';

/** Reads a URL as text, refusing more than `max` bytes. */
export type Fetcher = (url: string, max: number) => Promise<string>;

/** An answer whatever its status: the status, the header values asked for, and the body (at most `max` bytes). */
export interface BoundedResponse {
  readonly status: number;
  readonly header: (name: string) => string | null;
  readonly text: string;
}

/** Reads a request with headers (or any other init) once; a status that is not 200 is an answer, not an error. */
export type RequestFetcher = (url: string, max: number, init?: RequestInit) => Promise<BoundedResponse>;

/** The body of a response, refusing more than `max` bytes. */
async function readBounded(response: Response, url: string, max: number): Promise<string> {
  const host = new URL(url).host;
  const length = Number(response.headers.get('content-length')) || 0;
  if (length > max) throw new Error('The answer from ' + host + ' is too big.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty answer from ' + host + '.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error('The answer from ' + host + ' is too big.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchBounded(url: string, max: number): Promise<string> {
  return readBounded(await fetchRetry(url, {}, 2, 30000), url, max);
}

/** One request with a timeout (10 s by default), no retries: for a check that should answer quickly. */
export async function fetchBoundedResponse(
  url: string,
  max: number,
  init: RequestInit = {},
  timeoutMs = 10000,
): Promise<BoundedResponse> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'windows-development-sandbox', ...(init.headers ?? {}) },
  });
  const text = await readBounded(response, url, max);
  return { status: response.status, header: (name) => response.headers.get(name), text };
}
