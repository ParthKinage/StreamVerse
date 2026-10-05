import type {
  AuthResponse,
  ConfigResponse,
  CreatorAnalytics,
  CreatorEarnings,
  CreatorProfileDto,
  EndSessionResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  HistoryItem,
  NonceResponse,
  RecommendationsResponse,
  StartSessionResponse,
  UserDto,
  VideoDto,
  WalletSummary,
  WalletTransaction,
  AdminSettlementDto,
  ReceivedPaymentsResponse,
  PurchaseResponse,
  UpdateVideoRequest,
} from '@tesor_gp/shared';
import { api, uploadWithProgress } from './client';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  postgres: string;
  redis: string;
  chain: string;
  ai: string;
  details?: Record<string, unknown>;
}

export const authApi = {
  register: (b: { email: string; username: string; password: string }) => api<AuthResponse>('/auth/register', { method: 'POST', body: b, anonymous: true }),
  login: (b: { email: string; password: string }) => api<AuthResponse>('/auth/login', { method: 'POST', body: b, anonymous: true }),
  logout: () => api<void>('/auth/logout', { method: 'POST', anonymous: true }),
  me: () => api<{ user: UserDto }>('/auth/me'),
};

export const usersApi = {
  updateProfile: (b: { username?: string }) => api<{ user: UserDto }>('/users/me', { method: 'PATCH', body: b }),
  changePassword: (b: { currentPassword: string; newPassword: string }) => api<void>('/users/me/password', { method: 'POST', body: b }),
};

export const configApi = { get: () => api<ConfigResponse>('/config', { anonymous: true }) };

export const walletApi = {
  nonce: (address: string) => api<NonceResponse>('/wallet/nonce', { method: 'POST', body: { address } }),
  link: (address: string, signature: string) => api<{ user: UserDto }>('/wallet/link', { method: 'POST', body: { address, signature } }),
  unlink: () => api<{ user: UserDto }>('/wallet/link', { method: 'DELETE' }),
  summary: () => api<WalletSummary>('/wallet/summary'),
  transactions: (cursor?: string) => api<Page<WalletTransaction>>('/wallet/transactions', { query: { cursor } }),
};

export const purchaseApi = {
  buy: (videoId: string) => api<PurchaseResponse>(`/videos/${encodeURIComponent(videoId)}/purchase`, { method: 'POST', body: {} }),
};

export const bankApi = {
  topUp: (accountId: string, amountWei: string) => api<{ summary: WalletSummary }>('/bank/topup', { method: 'POST', body: { accountId, amountWei } }),
  withdraw: (accountId: string, amountWei: string) => api<{ summary: WalletSummary }>('/bank/withdraw', { method: 'POST', body: { accountId, amountWei } }),
  cashOut: (accountId: string) => api<{ amountWei: string; summary: WalletSummary }>('/bank/cashout', { method: 'POST', body: { accountId } }),
  received: (cursor?: string) => api<ReceivedPaymentsResponse>('/creator/received', { query: { cursor } }),
};

export interface VideoListParams {
  q?: string;
  category?: string;
  creatorId?: string;
  sort?: 'newest' | 'popular' | 'trending';
  cursor?: string;
  limit?: number;
}
export const catalogApi = {
  list: (p: VideoListParams = {}) => api<Page<VideoDto>>('/videos', { query: { ...p } }),
  get: (id: string) => api<VideoDto>(`/videos/${encodeURIComponent(id)}`),
  categories: () => api<{ categories: Array<{ name: string; count: number }> }>('/categories', { anonymous: true }),
  creator: (id: string) => api<CreatorProfileDto>(`/creators/${encodeURIComponent(id)}`),
  recommendations: (videoId?: string, limit = 12) => api<RecommendationsResponse>('/recommendations', { query: { videoId, limit } }),
};

export const socialApi = {
  like: (id: string) => api<{ liked: boolean; likesCount: number }>(`/videos/${encodeURIComponent(id)}/like`, { method: 'POST' }),
  watchlist: (id: string) => api<{ inWatchlist: boolean }>(`/videos/${encodeURIComponent(id)}/watchlist`, { method: 'POST' }),
  watchlistPage: (cursor?: string) => api<Page<VideoDto>>('/me/watchlist', { query: { cursor } }),
};

export const watchApi = {
  start: (videoId: string, signal?: AbortSignal) => api<StartSessionResponse>('/watch/sessions', { method: 'POST', body: { videoId }, signal }),
  heartbeat: (sessionId: string, body: HeartbeatRequest, signal?: AbortSignal) =>
    api<HeartbeatResponse>(`/watch/sessions/${encodeURIComponent(sessionId)}/heartbeat`, { method: 'POST', body, signal }),
  end: (sessionId: string, endToken?: string) =>
    api<EndSessionResponse>(`/watch/sessions/${encodeURIComponent(sessionId)}/end`, { method: 'POST', body: { endToken }, keepalive: true }),
  history: (cursor?: string) => api<Page<HistoryItem>>('/me/history', { query: { cursor } }),
  continueWatching: () => api<{ items: HistoryItem[] }>('/me/continue-watching'),
};

export const creatorApi = {
  becomeCreator: (b: { channelName: string; bio?: string }) => api<{ user: UserDto }>('/creator/profile', { method: 'POST', body: b }),
  videos: (cursor?: string) => api<Page<VideoDto>>('/creator/videos', { query: { cursor } }),
  upload: (form: FormData, onProgress: (f: number) => void, signal: AbortSignal) => uploadWithProgress<VideoDto>('/creator/videos', form, onProgress, signal),
  update: (id: string, b: UpdateVideoRequest) => api<VideoDto>(`/creator/videos/${encodeURIComponent(id)}`, { method: 'PATCH', body: b }),
  publish: (id: string) => api<VideoDto>(`/creator/videos/${encodeURIComponent(id)}/publish`, { method: 'POST' }),
  unpublish: (id: string) => api<VideoDto>(`/creator/videos/${encodeURIComponent(id)}/unpublish`, { method: 'POST' }),
  retry: (id: string) => api<VideoDto>(`/creator/videos/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  remove: (id: string) => api<void>(`/creator/videos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  analytics: () => api<CreatorAnalytics>('/creator/analytics'),
  earnings: () => api<CreatorEarnings>('/creator/earnings'),
};

export const adminApi = {
  users: (q?: string, cursor?: string) => api<Page<UserDto>>('/admin/users', { query: { q, cursor } }),
  videos: (q?: string, cursor?: string) => api<Page<VideoDto>>('/admin/videos', { query: { q, cursor } }),
  unpublish: (id: string) => api<VideoDto>(`/admin/videos/${encodeURIComponent(id)}/unpublish`, { method: 'POST' }),
  settlements: (status?: string, cursor?: string) => api<Page<AdminSettlementDto>>('/admin/settlements', { query: { status, cursor } }),
  retrySettlement: (id: string) => api<{ queued: boolean }>(`/admin/settlements/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  health: () => api<HealthReport>('/admin/health'),
};
