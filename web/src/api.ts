// Calls to the sandbox web server. Every call carries the CSRF header; the login cookie is HttpOnly (the page never
// sees it).
import { CSRF_HEADER, CSRF_VALUE, type WebInfo, type WebSession } from '../../src/shared/web/index';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { [CSRF_HEADER]: CSRF_VALUE, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (data as { error?: unknown } | null)?.error;
    throw new ApiError(response.status, typeof message === 'string' ? message : 'The server said ' + response.status);
  }
  return data as T;
}

export const api = {
  login: (token: string): Promise<unknown> => call('POST', '/api/login', { token }),
  info: (): Promise<WebInfo> => call('GET', '/api/info'),
  sessions: (): Promise<WebSession[]> => call('GET', '/api/sessions'),
};
