import { decimalToWei, weiToDecimal, type UserDto, type VideoDto } from '@tesor_gp/shared';
import type { Prisma } from '@tesor_gp/database';

/** Prisma Decimal (or decimal string) to wei. Uses toFixed() so exponent notation never appears. */
export function toWei(value: { toFixed(): string } | string): bigint {
  return decimalToWei(typeof value === 'string' ? value : value.toFixed());
}

/** Wei to a value Prisma accepts for Decimal(38,18) columns. */
export function fromWei(wei: bigint): string {
  return weiToDecimal(wei);
}

/** Parses "15m", "7d", "30s", "2h" into milliseconds. */
export function parseDurationMs(input: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(input.trim());
  if (!m) throw new Error(`Invalid duration: ${input}`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] as number;
  return n * factor;
}

export const videoInclude = {
  creator: { select: { id: true, channelName: true, user: { select: { username: true } } } },
} satisfies Prisma.VideoInclude;

export type VideoWithCreator = Prisma.VideoGetPayload<{ include: typeof videoInclude }>;

export function videoToDto(
  v: VideoWithCreator,
  extras: { liked?: boolean; inWatchlist?: boolean; likesCount?: number; accessUntil?: string | null } = {},
): VideoDto {
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    category: v.category,
    tags: v.tags,
    durationSeconds: v.durationSeconds,
    priceWei: toWei(v.priceSTRM).toString(),
    thumbnailUrl: v.thumbnailPath ? `/api/v1/videos/${v.id}/thumbnail` : null,
    viewsCount: v.viewsCount,
    createdAt: v.createdAt.toISOString(),
    creator: { id: v.creator.id, channelName: v.creator.channelName, username: v.creator.user.username },
    isPublished: v.isPublished,
    processingStatus: v.processingStatus,
    transcodeProgress: v.transcodeProgress,
    failureReason: v.failureReason,
    ...extras,
  };
}

export function userToDto(u: {
  id: string;
  email: string;
  username: string;
  role: 'USER' | 'CREATOR' | 'ADMIN';
  walletAddress: string | null;
  createdAt: Date;
  creatorProfile?: { channelName: string } | null;
}): UserDto {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    role: u.role,
    walletAddress: u.walletAddress,
    channelName: u.creatorProfile?.channelName ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/** Opaque cursor helpers (base64url JSON). */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
export function decodeCursor<T>(cursor: string | undefined): T | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    return undefined;
  }
}
