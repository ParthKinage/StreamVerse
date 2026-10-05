export const HEARTBEAT_INTERVAL_SEC = 10;
export const HEARTBEAT_GRACE_SEC = 2;
export const PLAYBACK_TOKEN_TTL_SEC = 30;
export const SESSION_TIMEOUT_SEC = 45;
/** Minimum verified seconds for a session to count as a view. */
export const VIEW_MIN_SECONDS = 30;
/** Seconds of balance below which the player shows a low-balance warning. */
export const LOW_BALANCE_SECONDS = 120;
/** Seconds of balance required to start a session. */
export const START_MIN_BALANCE_SECONDS = 60;
/** Segment budget: media seconds served <= factor * verified + slack. */
export const SEGMENT_BUDGET_FACTOR = 1.5;
export const SEGMENT_BUDGET_SLACK_SEC = 120;

/** A video has one price. Paying it unlocks the video for ACCESS_HOURS_DEFAULT hours (configurable per deployment). */
export const MAX_VIDEO_PRICE_STRM = 500;
export const DEFAULT_VIDEO_PRICE_STRM = '20';
export const ACCESS_HOURS_DEFAULT = 48;
export const MIN_VIDEO_TITLE = 1;
export const MAX_VIDEO_TITLE = 120;
export const MAX_VIDEO_DESCRIPTION = 5000;
export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 30;
export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 50;

export const CATEGORIES = ['General', 'Education', 'Gaming', 'Music', 'Tech', 'Art', 'Sports', 'News'] as const;

export const ALLOWED_UPLOAD_MIME = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-msvideo'] as const;

export const DOMAIN_EVENTS = {
  USER_REGISTERED: 'user.registered',
  WALLET_LINKED: 'wallet.linked',
  VIDEO_UPLOADED: 'video.uploaded',
  VIDEO_PROCESSED: 'video.processed',
  VIDEO_PUBLISHED: 'video.published',
  SESSION_STARTED: 'watch.session.started',
  SESSION_ENDED: 'watch.session.ended',
  SETTLEMENT_CREATED: 'settlement.created',
  SETTLEMENT_SETTLED: 'settlement.settled',
  SETTLEMENT_FAILED: 'settlement.failed',
  ESCROW_UPDATED: 'escrow.updated',
  REWARD_GRANTED: 'reward.granted',
} as const;
export type DomainEventName = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'EMAIL_TAKEN',
  'USERNAME_TAKEN',
  'INVALID_CREDENTIALS',
  'WALLET_NOT_LINKED',
  'WALLET_ALREADY_LINKED',
  'WALLET_IN_USE',
  'WALLET_HAS_BALANCE',
  'INVALID_SIGNATURE',
  'NONCE_EXPIRED',
  'INSUFFICIENT_BALANCE',
  'VIDEO_NOT_AVAILABLE',
  'SESSION_NOT_ACTIVE',
  'SEQUENCE_CONFLICT',
  'PLAYBACK_TOKEN_INVALID',
  'SEGMENT_BUDGET_EXCEEDED',
  'UPLOAD_INVALID',
  'UPLOAD_TOO_LARGE',
  'NOT_CREATOR',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'BANK_DECLINED',
  'INVALID_AMOUNT',
  'NOT_AVAILABLE_IN_THIS_MODE',
  'UNKNOWN_BANK_ACCOUNT',
  'PURCHASE_REQUIRED',
  'ACCESS_EXPIRED',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Dummy bank accounts offered in the prototype's simulated bank. Nothing here is a real account. */
export const DEMO_BANK_ACCOUNTS = [
  { id: 'demo-savings', name: 'Demo Bank Savings', last4: '4242', kind: 'Savings' },
  { id: 'demo-current', name: 'Demo Bank Current', last4: '1111', kind: 'Current' },
  { id: 'demo-declined', name: 'Demo Bank (always declines)', last4: '0002', kind: 'Test: payment declined' },
] as const;
/** The account that always refuses payments, so the error path can be demonstrated. */
export const DEMO_DECLINED_ACCOUNT_ID = 'demo-declined';
