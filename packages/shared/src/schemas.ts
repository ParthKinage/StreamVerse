import { z } from 'zod';
import {
  ALLOWED_UPLOAD_MIME,
  CATEGORIES,
  CHAT_MAX_LENGTH,
  LIVE_FILE_NAME_RE,
  LIVE_SEGMENT_MAX_MS,
  LIVE_SEGMENT_MIN_MS,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  MAX_VIDEO_DESCRIPTION,
  MAX_VIDEO_TITLE,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
} from './constants';

/** Non-negative integer amount of wei, as a decimal string. */
export const weiString = z.string().regex(/^\d+$/, 'must be a non-negative integer string (wei)');
export const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address');
export const isoDate = z.string();

// ---------- errors ----------
export const errorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ErrorResponse = z.infer<typeof errorResponse>;

// ---------- auth ----------
export const roleSchema = z.enum(['USER', 'CREATOR', 'ADMIN']);
export type Role = z.infer<typeof roleSchema>;

export const registerRequest = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  username: z
    .string()
    .trim()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/, 'letters, numbers and underscores only'),
  password: z.string().min(8).max(72),
});
export type RegisterRequest = z.infer<typeof registerRequest>;

export const loginRequest = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(72),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const userDto = z.object({
  id: z.string(),
  email: z.string(),
  username: z.string(),
  role: roleSchema,
  walletAddress: z.string().nullable(),
  channelName: z.string().nullable(),
  createdAt: isoDate,
});
export type UserDto = z.infer<typeof userDto>;

export const authResponse = z.object({ accessToken: z.string(), user: userDto });
export type AuthResponse = z.infer<typeof authResponse>;

// ---------- wallet ----------
export const nonceRequest = z.object({ address: evmAddress });
export const nonceResponse = z.object({ nonce: z.string(), message: z.string(), expiresInSec: z.number() });
export const linkWalletRequest = z.object({ address: evmAddress, signature: z.string().regex(/^0x[0-9a-fA-F]+$/) });
export type NonceResponse = z.infer<typeof nonceResponse>;

export const walletSummary = z.object({
  walletAddress: z.string().nullable(),
  escrowWei: weiString,
  pendingWithdrawalWei: weiString,
  withdrawUnlockAt: isoDate.nullable(),
  unsettledChargesWei: weiString,
  availableWei: weiString,
  creatorEarningsWei: weiString,
  /** Coins bought or granted that are not in the balance yet (still being sent, or sent but not yet read back from the chain). */
  arrivingWei: weiString.default('0'),
});
export type WalletSummary = z.infer<typeof walletSummary>;

export const walletTransaction = z.object({
  id: z.string(),
  type: z.enum(['DEPOSIT', 'WITHDRAW_REQUESTED', 'WITHDRAW_CANCELLED', 'WITHDRAW_EXECUTED', 'SETTLEMENT', 'REWARD', 'EARNINGS_CLAIMED']),
  status: z.enum(['PENDING', 'CONFIRMED', 'FAILED']),
  amountWei: weiString,
  txHash: z.string().nullable(),
  explorerUrl: z.string().nullable(),
  label: z.string(),
  createdAt: isoDate,
});
export type WalletTransaction = z.infer<typeof walletTransaction>;

export const paymentsModeSchema = z.enum(['bank', 'chain']);
export type PaymentsMode = z.infer<typeof paymentsModeSchema>;
/** 'managed' = the platform gives every account a blockchain wallet and pays the gas; 'external' = users link MetaMask. */
export const walletModeSchema = z.enum(['external', 'managed']);
export type WalletMode = z.infer<typeof walletModeSchema>;

export const bankAccountDto = z.object({ id: z.string(), name: z.string(), last4: z.string(), kind: z.string() });
export type BankAccountDto = z.infer<typeof bankAccountDto>;

export const configResponse = z.object({
  /** 'bank' = simulated bank wallet (default prototype mode), 'chain' = STRM tokens on a blockchain. */
  paymentsMode: paymentsModeSchema,
  /** Only meaningful when paymentsMode is 'chain'. */
  walletMode: walletModeSchema.default('external'),
  /** Symbol of the money used to buy coins (built-in wallets), for example "₹". */
  fiatSymbol: z.string().default(''),
  /** Smallest creator payout the platform will send (built-in wallets). */
  minPayoutWei: weiString.default('0'),
  currencyCode: z.string(),
  currencySymbol: z.string(),
  bankAccounts: z.array(bankAccountDto),
  minTopUpWei: weiString,
  maxTopUpWei: weiString,
  chainId: z.number(),
  chainName: z.string(),
  rpcUrl: z.string(),
  explorerUrl: z.string(),
  streamCoinAddress: z.string().nullable(),
  paymentRouterAddress: z.string().nullable(),
  heartbeatIntervalSec: z.number(),
  welcomeBonusWei: weiString,
  withdrawDelaySec: z.number(),
  feeBps: z.number(),
  /** Highest rate per minute a creator may set. */
  maxRatePerMinuteWei: weiString,
  /** How long a purchase keeps a video unlocked. */
  accessHours: z.number(),
  maxUploadMb: z.number(),
  /** 'direct' = the browser uploads straight to object storage (POST /creator/uploads); 'multipart' = POST /creator/videos. */
  uploadMode: z.enum(['multipart', 'direct']).default('multipart'),
  categories: z.array(z.string()),
});
export type ConfigResponse = z.infer<typeof configResponse>;

// ---------- demo bank (PAYMENTS_MODE=bank) ----------
export const bankMoneyRequest = z.object({ accountId: z.string().min(1), amountWei: weiString });
export type BankMoneyRequest = z.infer<typeof bankMoneyRequest>;
export const bankCashOutRequest = z.object({ accountId: z.string().min(1) });

export const receivedPayment = z.object({
  id: z.string(),
  amountWei: weiString,
  videoTitle: z.string(),
  viewerName: z.string(),
  receivedAt: isoDate,
});
export type ReceivedPayment = z.infer<typeof receivedPayment>;
export const receivedPaymentsResponse = z.object({ items: z.array(receivedPayment), nextCursor: z.string().nullable() });
export type ReceivedPaymentsResponse = z.infer<typeof receivedPaymentsResponse>;

// ---------- catalog ----------
export const categorySchema = z.enum(CATEGORIES);

export const creatorSummary = z.object({ id: z.string(), channelName: z.string(), username: z.string() });

export const videoDto = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  durationSeconds: z.number(),
  /** What the creator charges per minute watched (billed per second of video actually sent). */
  ratePerMinuteWei: weiString,
  /** What watching the whole video once costs at that rate (rate x length). */
  priceWei: weiString,
  /** Set for live streams and their recordings: one price for permanent access; the rate per minute does not apply. */
  accessPriceWei: weiString.nullable().optional(),
  /** The signed-in viewer may watch it: they bought access, it is free, or it is theirs. */
  hasAccess: z.boolean().optional(),
  /** Seconds of this video the signed-in viewer has already paid for (free to watch again). */
  paidSeconds: z.number().optional(),
  /** Kept for older clients; always null since per-second billing replaced the timed unlock. */
  accessUntil: isoDate.nullable().optional(),
  thumbnailUrl: z.string().nullable(),
  viewsCount: z.number(),
  createdAt: isoDate,
  creator: creatorSummary,
  isPublished: z.boolean(),
  processingStatus: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']),
  transcodeProgress: z.number(),
  failureReason: z.string().nullable(),
  liked: z.boolean().optional(),
  inWatchlist: z.boolean().optional(),
  likesCount: z.number().optional(),
  /** Set while the video is a live stream (or was one). */
  live: z
    .object({
      streamId: z.string(),
      status: z.enum(['CREATED', 'STARTING', 'LIVE', 'ENDING', 'ENDED', 'FAILED']),
      startedAt: isoDate.nullable(),
      viewers: z.number().optional(),
    })
    .nullable()
    .optional(),
});
export type VideoDto = z.infer<typeof videoDto>;

export const videoListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(40).optional(),
  creatorId: z.string().optional(),
  sort: z.enum(['newest', 'popular', 'trending']).default('newest'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});
export type VideoListQuery = z.infer<typeof videoListQuery>;

export const videoListResponse = z.object({ items: z.array(videoDto), nextCursor: z.string().nullable() });
export type VideoListResponse = z.infer<typeof videoListResponse>;

export const creatorProfileDto = z.object({
  id: z.string(),
  username: z.string(),
  channelName: z.string(),
  bio: z.string().nullable(),
  videoCount: z.number(),
  totalViews: z.number(),
  createdAt: isoDate,
});
export type CreatorProfileDto = z.infer<typeof creatorProfileDto>;

// ---------- creator ----------
export const createCreatorProfileRequest = z.object({
  channelName: z.string().trim().min(2).max(60),
  bio: z.string().trim().max(500).optional(),
});

export const tagsSchema = z
  .array(z.string().trim().toLowerCase().min(1).max(MAX_TAG_LENGTH))
  .max(MAX_TAGS)
  .transform((tags) => Array.from(new Set(tags)));

export const updateVideoRequest = z
  .object({
    title: z.string().trim().min(1).max(MAX_VIDEO_TITLE),
    description: z.string().trim().max(MAX_VIDEO_DESCRIPTION),
    category: z.string().trim().min(1).max(40),
    tags: tagsSchema,
    ratePerMinuteWei: weiString,
  })
  .partial();
export type UpdateVideoRequest = z.infer<typeof updateVideoRequest>;

/** Step 1 of a direct upload: ask for a signed URL to PUT the file to. */
export const createUploadRequest = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.enum(ALLOWED_UPLOAD_MIME),
  sizeBytes: z.number().int().positive(),
});
export type CreateUploadRequest = z.infer<typeof createUploadRequest>;

export const createUploadResponse = z.object({
  /** Opaque, signed; hand it back to POST /creator/uploads/complete. */
  uploadToken: z.string(),
  uploadUrl: z.string().url(),
  method: z.literal('PUT'),
  /** Send exactly these headers with the PUT (the content type is part of the signature). */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string(),
});
export type CreateUploadResponse = z.infer<typeof createUploadResponse>;

export const uploadVideoFields = z.object({
  title: z.string().trim().min(1).max(MAX_VIDEO_TITLE),
  description: z.string().trim().max(MAX_VIDEO_DESCRIPTION).default(''),
  category: z.string().trim().min(1).max(40).default('General'),
  tags: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) : []))
    .pipe(tagsSchema),
  ratePerMinuteWei: weiString.optional(),
});

/** Step 2 of a direct upload: the file is in storage; create the video from it. */
export const completeUploadRequest = uploadVideoFields.extend({ uploadToken: z.string().min(16).max(4000) });
export type CompleteUploadRequest = z.infer<typeof completeUploadRequest>;

export const creatorAnalytics = z.object({
  totalViews: z.number(),
  totalWatchSeconds: z.number(),
  totalEarningsWei: weiString,
  videos: z.array(
    z.object({
      videoId: z.string(),
      title: z.string(),
      views: z.number(),
      watchSeconds: z.number(),
      earningsWei: weiString,
    }),
  ),
  daily: z.array(z.object({ date: z.string(), views: z.number(), watchSeconds: z.number(), earningsWei: weiString })),
});
export type CreatorAnalytics = z.infer<typeof creatorAnalytics>;

export const creatorEarnings = z.object({
  claimableWei: weiString,
  lifetimeEarnedWei: weiString,
  pendingSettlementWei: weiString,
  /** Already paid out to the creator's wallet. */
  paidOutWei: weiString.default('0'),
  /** True while a payout the creator asked for is being written to the blockchain. */
  payoutPending: z.boolean().default(false),
});
export type CreatorEarnings = z.infer<typeof creatorEarnings>;

// ---------- purchases ----------
export const purchaseResponse = z.object({
  videoId: z.string(),
  priceWei: weiString,
  /** null: access never runs out. */
  accessUntil: isoDate.nullable(),
  /** true when the viewer already had access, so nothing was charged. */
  alreadyUnlocked: z.boolean(),
  availableWei: weiString,
});
export type PurchaseResponse = z.infer<typeof purchaseResponse>;

// ---------- watch ----------
export const startSessionRequest = z.object({ videoId: z.string().min(1) });

export const startSessionResponse = z.object({
  sessionId: z.string(),
  /** Lets the player end the session from navigator.sendBeacon, which cannot send an Authorization header. */
  endToken: z.string(),
  manifestUrl: z.string(),
  heartbeatIntervalSec: z.number(),
  resumePositionSec: z.number(),
  availableWei: weiString,
  /** True when nothing is charged (free video or the creator's own). */
  free: z.boolean(),
  /** The rate this session is billed at. */
  ratePerMinuteWei: weiString,
  /** Seconds of the video already paid for before this session (free to watch again). */
  paidSeconds: z.number(),
  /** Kept for older clients; always null. */
  accessUntil: isoDate.nullable(),
});
export type StartSessionResponse = z.infer<typeof startSessionResponse>;

export const heartbeatRequest = z.object({
  sequence: z.number().int().nonnegative(),
  playbackTime: z.number().nonnegative().max(60 * 60 * 24),
  state: z.enum(['playing', 'paused', 'buffering']),
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequest>;

export const heartbeatAction = z.enum(['continue', 'low_balance', 'stop']);
export type HeartbeatAction = z.infer<typeof heartbeatAction>;

export const heartbeatResponse = z.object({
  sequence: z.number(),
  verifiedSeconds: z.number(),
  chargedWei: weiString,
  availableWei: weiString,
  secondsRemaining: z.number().nullable(),
  action: heartbeatAction,
  /** Why the player was told to stop, when it was not a normal end. */
  reason: z.enum(['ACCESS_EXPIRED', 'INSUFFICIENT_BALANCE']).optional(),
  /** Seconds of this video the viewer has paid for so far, across all sessions. */
  paidSeconds: z.number().optional(),
  accessUntil: isoDate.nullable().optional(),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponse>;

export const endSessionRequest = z.object({ endToken: z.string().optional() }).optional();

export const endSessionResponse = z.object({
  sessionId: z.string(),
  verifiedSeconds: z.number(),
  chargedWei: weiString,
  settlementId: z.string().nullable(),
});
export type EndSessionResponse = z.infer<typeof endSessionResponse>;

export const historyItem = z.object({
  sessionId: z.string(),
  video: videoDto,
  watchedSeconds: z.number(),
  /** What this session cost (the pieces of video paid for during it). */
  paidWei: weiString,
  lastPositionSec: z.number(),
  watchedAt: isoDate,
});
export type HistoryItem = z.infer<typeof historyItem>;
export const historyResponse = z.object({ items: z.array(historyItem), nextCursor: z.string().nullable() });

export const cursorQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});

// ---------- recommendations / AI ----------
export const recommendationsQuery = z.object({
  videoId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(30).default(12),
});

export const recommendationsResponse = z.object({
  items: z.array(videoDto),
  source: z.enum(['ai', 'fallback']),
});
export type RecommendationsResponse = z.infer<typeof recommendationsResponse>;

export const aiHistoryEntry = z.object({
  category: z.string(),
  tags: z.array(z.string()),
  creatorId: z.string(),
  watchedSeconds: z.number().nonnegative(),
});
export const aiCandidate = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  creatorId: z.string(),
  views: z.number().nonnegative(),
  createdAt: isoDate,
});
export const aiRecommendRequest = z.object({
  limit: z.number().int().min(1).max(50),
  seedVideo: aiCandidate.optional(),
  history: z.array(aiHistoryEntry).max(500),
  candidates: z.array(aiCandidate).max(1000),
  watchedVideoIds: z.array(z.string()).optional(),
});
export type AiRecommendRequest = z.infer<typeof aiRecommendRequest>;
export type AiCandidate = z.infer<typeof aiCandidate>;
export const aiRecommendResponse = z.object({
  items: z.array(z.object({ id: z.string(), score: z.number() })),
});
export type AiRecommendResponse = z.infer<typeof aiRecommendResponse>;

// ---------- admin ----------
export const adminSettlementDto = z.object({
  id: z.string(),
  /** Null for settlements that pay for a video purchase. */
  sessionId: z.string().nullable(),
  userId: z.string(),
  amountWei: weiString,
  status: z.enum(['PENDING', 'SETTLED', 'FAILED']),
  attempts: z.number(),
  lastError: z.string().nullable(),
  txHash: z.string().nullable(),
  createdAt: isoDate,
});
export type AdminSettlementDto = z.infer<typeof adminSettlementDto>;

/** What the platform has earned and what it is spending to run the built-in wallets. */
export const adminRevenue = z.object({
  paymentsMode: paymentsModeSchema,
  walletMode: walletModeSchema,
  feeBps: z.number(),
  /** Total paid by viewers for videos (settled). */
  grossSalesWei: weiString,
  /** The platform's commission on those sales. */
  platformFeesWei: weiString,
  /** What creators earned from those sales. */
  creatorEarningsWei: weiString,
  /** Commission sitting in the contract, ready for the admin to withdraw. Null when the chain cannot be read. */
  platformFeesOnChainWei: weiString.nullable(),
  /** Coins sold to viewers. */
  coinsSoldWei: weiString,
  /** Coins given away as bonuses. */
  bonusesWei: weiString,
  /** Credits (purchases and bonuses) waiting to be written to the blockchain. */
  pendingCredits: z.number(),
  pendingSettlements: z.number(),
  relayerAddress: z.string().nullable(),
  /** Gas money left in the platform wallet, in wei of the chain's native coin. */
  relayerGasWei: weiString.nullable(),
  /** Coins left in the platform wallet to sell or give away. */
  relayerCoinsWei: weiString.nullable(),
  /** True when the platform wallet is nearly out of gas and needs topping up. */
  lowGas: z.boolean(),
  walletCount: z.number(),
});
export type AdminRevenue = z.infer<typeof adminRevenue>;

// ---------- live streaming ----------
export const liveStatusSchema = z.enum(['CREATED', 'STARTING', 'LIVE', 'ENDING', 'ENDED', 'FAILED']);
export type LiveStatus = z.infer<typeof liveStatusSchema>;

export const createLiveRequest = z.object({
  title: z.string().trim().min(1).max(MAX_VIDEO_TITLE),
  description: z.string().trim().max(MAX_VIDEO_DESCRIPTION).default(''),
  category: z.string().trim().min(1).max(40).default('General'),
  tags: tagsSchema.default([]),
  /** One price for permanent access to the stream and its recording (default 50; 0 = free). */
  priceWei: weiString.optional(),
  /** Keep the recording as a normal video afterwards. */
  saveAsVod: z.boolean().default(true),
});
export type CreateLiveRequest = z.input<typeof createLiveRequest>;

/** Sent when the browser starts (or restarts) sending: what it encodes, so viewers' players can pick the stream. */
export const startLiveRequest = z.object({
  codecs: z.string().regex(/^[A-Za-z0-9.,]{3,100}$/),
  width: z.number().int().min(16).max(3840),
  height: z.number().int().min(16).max(2160),
  bandwidth: z.number().int().min(10_000).max(20_000_000),
});
export type StartLiveRequest = z.infer<typeof startLiveRequest>;

export const liveUploadUrlsRequest = z.object({ names: z.array(z.string().regex(LIVE_FILE_NAME_RE)).min(1).max(30) });
export const liveUploadUrlsResponse = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      method: z.literal('PUT'),
      headers: z.record(z.string(), z.string()),
      /** True when the URL is the API itself (local storage): send it with the login header. */
      viaApi: z.boolean(),
    }),
  ),
  expiresAt: isoDate,
});
export type LiveUploadUrlsResponse = z.infer<typeof liveUploadUrlsResponse>;

export const commitLiveSegmentRequest = z.object({
  index: z.number().int().min(0).max(999_999),
  initSeq: z.number().int().min(0),
  durationMs: z.number().int().min(LIVE_SEGMENT_MIN_MS).max(LIVE_SEGMENT_MAX_MS),
});
export type CommitLiveSegmentRequest = z.infer<typeof commitLiveSegmentRequest>;

export const liveStreamDto = z.object({
  id: z.string(),
  videoId: z.string(),
  status: liveStatusSchema,
  title: z.string(),
  /** What viewers pay once to watch this stream and its recording. */
  priceWei: weiString,
  /** Viewers who have bought access so far. */
  buyers: z.number(),
  saveAsVod: z.boolean(),
  createdAt: isoDate,
  startedAt: isoDate.nullable(),
  endedAt: isoDate.nullable(),
  endReason: z.string().nullable(),
  /** Viewers watching now. */
  viewers: z.number(),
  peakViewers: z.number(),
  /** Seconds of the stream sent so far. */
  durationSeconds: z.number(),
  /** The creator's share of what viewers have paid for this stream so far (access bought). */
  earnedWei: weiString,
  /** Where the sender carries on: the run number of its init piece and the next piece index. */
  initSeq: z.number(),
  nextIndex: z.number(),
});
export type LiveStreamDto = z.infer<typeof liveStreamDto>;

export const chatMessageDto = z.object({
  id: z.number(),
  text: z.string(),
  createdAt: isoDate,
  user: z.object({ id: z.string(), username: z.string() }),
  /** Written by the stream's creator. */
  fromCreator: z.boolean(),
});
export type ChatMessageDto = z.infer<typeof chatMessageDto>;

export const chatQuery = z.object({ after: z.coerce.number().int().min(0).optional() });
export const chatResponse = z.object({
  items: z.array(chatMessageDto),
  /** Messages removed by the creator or an admin recently; clients drop them from what they show. */
  removed: z.array(z.number()),
  /** Whether new messages are accepted (the stream is on air). */
  open: z.boolean(),
});
export type ChatResponse = z.infer<typeof chatResponse>;
export const postChatRequest = z.object({ text: z.string().trim().min(1).max(CHAT_MAX_LENGTH) });
