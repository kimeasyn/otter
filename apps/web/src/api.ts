import { create } from 'zustand';
const fragment = new URLSearchParams(window.location.hash.slice(1));
const initial = fragment.get('token') || sessionStorage.getItem('otter-token') || '';
if (fragment.has('token')) {
  sessionStorage.setItem('otter-token', initial);
  history.replaceState(null, '', window.location.pathname);
}
export const useAuth = create<{token: string; setToken: (value: string) => void}>((set) => ({
  token: initial,
  setToken: (token) => {sessionStorage.setItem('otter-token', token); set({token});},
}));
export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {Authorization: `Bearer ${useAuth.getState().token}`, 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({error: `HTTP ${response.status}`}));
    throw new Error(error.error ?? `HTTP ${response.status}`);
  }
  return response.json();
}
