import type { ChatMessageDto, ChatResponse } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { AppError, conflict, forbidden, notFound } from '../../middleware/errors';
import { toWei } from '../common';
import { hasBoughtAccess } from '../purchase/purchase.service';

/** Removed messages are reported to polling clients for this long, so every open page drops them. */
const REMOVED_WINDOW_MS = 5 * 60_000;
const FIRST_PAGE = 50;
const NEXT_PAGE = 100;

const OPEN_STATES = new Set(['STARTING', 'LIVE']);

async function streamFor(ctx: AppContext, streamId: string) {
  const s = await ctx.prisma.liveStream.findUnique({
    where: { id: streamId },
    select: { id: true, status: true, videoId: true, creator: { select: { userId: true } }, video: { select: { archivedAt: true, accessPriceSTRM: true } } },
  });
  if (!s || s.video.archivedAt || s.status === 'CREATED' || s.status === 'FAILED') throw notFound('Stream not found');
  return s;
}

/**
 * Chat since message `after` (oldest first), or the latest messages when `after` is not given. Anyone who can see the
 * stream's page may read; clients poll every few seconds.
 */
export async function readChat(ctx: AppContext, streamId: string, after?: number): Promise<ChatResponse> {
  const s = await streamFor(ctx, streamId);
  const since = new Date(ctx.now().getTime() - REMOVED_WINDOW_MS);
  const [rows, removed] = await Promise.all([
    after === undefined
      ? ctx.prisma.liveChatMessage
          .findMany({ where: { liveStreamId: streamId, removedAt: null }, orderBy: { id: 'desc' }, take: FIRST_PAGE, include: { user: { select: { username: true } } } })
          .then((r) => r.reverse())
      : ctx.prisma.liveChatMessage.findMany({
          where: { liveStreamId: streamId, removedAt: null, id: { gt: after } },
          orderBy: { id: 'asc' },
          take: NEXT_PAGE,
          include: { user: { select: { username: true } } },
        }),
    ctx.prisma.liveChatMessage.findMany({ where: { liveStreamId: streamId, removedAt: { gte: since } }, select: { id: true } }),
  ]);
  const items: ChatMessageDto[] = rows.map((m) => ({
    id: m.id,
    text: m.text,
    createdAt: m.createdAt.toISOString(),
    user: { id: m.userId, username: m.user.username },
    fromCreator: m.userId === s.creator.userId,
  }));
  return { items, removed: removed.map((r) => r.id), open: OPEN_STATES.has(s.status) };
}

/** Posting needs the stream to be on air and the viewer to have access (bought, free stream, the creator, or an admin). */
export async function postChat(ctx: AppContext, user: { id: string; role: string }, streamId: string, text: string): Promise<ChatMessageDto> {
  const s = await streamFor(ctx, streamId);
  if (!OPEN_STATES.has(s.status)) throw conflict('CHAT_CLOSED', 'The chat closed when the stream ended');
  const isCreator = s.creator.userId === user.id;
  const price = s.video.accessPriceSTRM ? toWei(s.video.accessPriceSTRM) : 0n;
  if (!isCreator && user.role !== 'ADMIN' && price > 0n && !(await hasBoughtAccess(ctx.prisma, user.id, s.videoId, ctx.now()))) {
    throw new AppError(402, 'PURCHASE_REQUIRED', 'Get access to the stream to chat');
  }
  const m = await ctx.prisma.liveChatMessage.create({ data: { liveStreamId: streamId, userId: user.id, text }, include: { user: { select: { username: true } } } });
  return { id: m.id, text: m.text, createdAt: m.createdAt.toISOString(), user: { id: user.id, username: m.user.username }, fromCreator: isCreator };
}

/** The stream's creator or an admin removes a message. */
export async function removeChat(ctx: AppContext, user: { id: string; role: string }, streamId: string, messageId: number): Promise<void> {
  const s = await streamFor(ctx, streamId);
  if (s.creator.userId !== user.id && user.role !== 'ADMIN') throw forbidden('Only the creator can remove messages');
  const updated = await ctx.prisma.liveChatMessage.updateMany({ where: { id: messageId, liveStreamId: streamId, removedAt: null }, data: { removedAt: ctx.now() } });
  if (!updated.count) throw notFound('Message not found');
}
