const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const OBSERVABILITY_COOKIE = 'myota_admin_access';
let refreshPending: Promise<boolean> | null = null;

function tokenExpiresAt(token: string): number | null {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(
      window.atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')),
    );
    return Number.isFinite(claims.exp) ? Number(claims.exp) : null;
  } catch {
    return null;
  }
}

function syncObservabilityCookie(token: string): void {
  if (typeof document === 'undefined') return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  if (!token) {
    document.cookie = `${OBSERVABILITY_COOKIE}=; Path=/observability; Max-Age=0; SameSite=Strict${secure}`;
    return;
  }
  const expiresAt = tokenExpiresAt(token);
  const maxAge =
    expiresAt === null
      ? 600
      : Math.max(1, expiresAt - Math.floor(Date.now() / 1000));
  document.cookie = `${OBSERVABILITY_COOKIE}=${encodeURIComponent(token)}; Path=/observability; Max-Age=${maxAge}; SameSite=Strict${secure}`;
}

export function accessTokenExpiresIn(): number | null {
  const token = localStorage.getItem('myota_admin_access') || '';
  const expiresAt = tokenExpiresAt(token);
  return expiresAt === null ? null : expiresAt - Math.floor(Date.now() / 1000);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function accessToken(): string {
  const token = localStorage.getItem('myota_admin_access') || '';
  syncObservabilityCookie(token);
  return token;
}

export function clearSession(): void {
  localStorage.removeItem('myota_admin_access');
  localStorage.removeItem('myota_admin_refresh');
  syncObservabilityCookie('');
}

export function saveSession(data: {
  accessToken: string;
  refreshToken?: string;
}): void {
  localStorage.setItem('myota_admin_access', data.accessToken);
  syncObservabilityCookie(data.accessToken);
  if (data.refreshToken)
    localStorage.setItem('myota_admin_refresh', data.refreshToken);
}

export function refreshSession(): Promise<boolean> {
  if (refreshPending) return refreshPending;
  const pending = performSessionRefresh();
  refreshPending = pending;
  void pending.finally(() => {
    if (refreshPending === pending) refreshPending = null;
  });
  return pending;
}

async function performSessionRefresh(): Promise<boolean> {
  const refreshToken = localStorage.getItem('myota_admin_refresh');
  if (!refreshToken) return false;
  try {
    const response = await fetch(`${API_BASE}/v1/identity/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) return false;
    saveSession(await response.json());
    return true;
  } catch {
    return false;
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  // FormData must keep the browser-generated multipart boundary. Treating it
  // as JSON forces large files through an in-memory string conversion.
  if (
    options.body &&
    !(options.body instanceof FormData) &&
    !headers.has('Content-Type')
  ) {
    headers.set('Content-Type', 'application/json');
  }
  const token = accessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const method = (options.method || 'GET').toUpperCase();
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    ...(method === 'GET' ? { cache: 'no-store' as RequestCache } : {}),
  });
  if (
    [401, 403].includes(response.status) &&
    retry &&
    token &&
    (await refreshSession())
  )
    return apiRequest<T>(path, options, false);
  if (token && typeof window !== 'undefined') {
    if (response.status === 403 && path !== '/v1/identity/me')
      window.dispatchEvent(new Event('myota:authorization-denied'));
    if (response.status === 401)
      window.dispatchEvent(new Event('myota:session-invalid'));
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      body.detail || body.message || body.error || response.statusText,
      response.status,
    );
  return body as T;
}
