import type { GameState, ReplayAnalysis, User } from './types';

const API = '';

export async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as T;
}

export function register(name: string, password: string) {
  return request<User>('/api/register', { method: 'POST', body: JSON.stringify({ name, password }) });
}

export function login(name: string, password: string) {
  return request<User>('/api/login', { method: 'POST', body: JSON.stringify({ name, password }) });
}

export function listRooms() {
  return request<{ rooms: { id: string; name: string; phase: string; round: number }[] }>('/api/rooms');
}

export function createRoom(name: string, token: string) {
  return request<{ room: GameState }>('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) }, token);
}

export function getRoom(id: string, token?: string) {
  return request<{ room: GameState }>(`/api/rooms/${id}`, {}, token);
}

export function postIntent(id: string, intent: unknown, token: string) {
  return request<{ room: GameState; events: unknown[] }>(`/api/rooms/${id}/intent`, {
    method: 'POST',
    body: JSON.stringify({ intent })
  }, token);
}

export function getReplay(id: string, token?: string) {
  return request<{ analysis: ReplayAnalysis; room: GameState }>(`/api/rooms/${id}/replay`, {}, token);
}
