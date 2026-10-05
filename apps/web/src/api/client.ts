import type { ErrorResponse, UserDto } from '@tesor_gp/shared';

export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

type AuthListener = () => void;

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
let onAuthLost: AuthListener = () => undefined;
let onTokenRefreshed: ((token: string, user: UserDto) => void) | null = null;

export const tokenStore = {
  get: (): string | null => accessToken,
  set: (token: string | null): void => {
    accessToken = token;
  },
};

export function setAuthLostHandler(fn: AuthListener): void {
  onAuthLost = fn;
}
export function setTokenRefreshedHandler(fn: ((token: string, user: UserDto) => void) | null): void {
  onTokenRefreshed = fn;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: Partial<ErrorResponse> | undefined;
  try {
    body = (await res.json()) as Partial<ErrorResponse>;
  } catch {
    body = undefined;
  }
  return new ApiError(res.status, body?.error?.code ?? `HTTP_${res.status}`, body?.error?.message ?? res.statusText ?? 'Request failed', body?.error?.details);
}

/** Exchanges the httpOnly refresh cookie for a new access token. Concurrent callers share one request. */
export function refreshAccessToken(): Promise<string | null> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
        if (!res.ok) return null;
        const data = (await res.json()) as { accessToken: string; user: UserDto };
        accessToken = data.accessToken;
        onTokenRefreshed?.(data.accessToken, data.user);
        return data.accessToken;
      } catch {
        return null;
      } finally {
        setTimeout(() => {
          refreshing = null;
        }, 0);
      }
    })();
  }
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  formData?: FormData;
  query?: Record<string, string | number | undefined | null>;
  signal?: AbortSignal | undefined;
  /** Skip the Authorization header and the refresh-on-401 behaviour (login, register, refresh). */
  anonymous?: boolean;
  keepalive?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function send(path: string, opts: RequestOptions, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token && !opts.anonymous) headers.Authorization = `Bearer ${token}`;
  try {
    return await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? 'GET',
      headers,
      credentials: 'include',
      ...(opts.formData ? { body: opts.formData } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.keepalive ? { keepalive: true } : {}),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
  }
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let res = await send(path, opts, accessToken);
  if (res.status === 401 && !opts.anonymous) {
    const fresh = await refreshAccessToken();
    if (!fresh) {
      accessToken = null;
      onAuthLost();
      throw await parseError(res);
    }
    res = await send(path, opts, fresh);
    if (res.status === 401) {
      accessToken = null;
      onAuthLost();
    }
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Upload with progress and cancellation (fetch cannot report upload progress, XHR can). */
export function uploadWithProgress<T>(path: string, form: FormData, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<T> {
  const attempt = (token: string | null): Promise<{ status: number; body: unknown }> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}${path}`);
      xhr.withCredentials = true;
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let body: unknown;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          body = undefined;
        }
        resolve({ status: xhr.status, body });
      };
      xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', 'Upload failed: cannot reach the server'));
      xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(form);
    });
  return (async () => {
    let r = await attempt(accessToken);
    if (r.status === 401) {
      const fresh = await refreshAccessToken();
      if (!fresh) {
        onAuthLost();
      } else r = await attempt(fresh);
    }
    if (r.status < 200 || r.status >= 300) {
      const err = (r.body as Partial<ErrorResponse> | undefined)?.error;
      throw new ApiError(r.status, err?.code ?? `HTTP_${r.status}`, err?.message ?? 'Upload failed', err?.details);
    }
    return r.body as T;
  })();
}

/** Plain-language message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
