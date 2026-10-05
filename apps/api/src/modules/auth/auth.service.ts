import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { AuthResponse, LoginRequest, RegisterRequest } from '@tesor_gp/shared';
import { DOMAIN_EVENTS } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { signAccessToken } from '../../middleware/auth';
import { AppError, conflict, unauthenticated } from '../../middleware/errors';
import { isUniqueViolation, parseDurationMs, userToDto } from '../common';

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 4);

export interface IssuedSession extends AuthResponse {
  refreshToken: string;
  refreshExpiresAt: Date;
}

const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

async function issue(ctx: AppContext, user: Parameters<typeof userToDto>[0]): Promise<IssuedSession> {
  const refreshToken = crypto.randomBytes(32).toString('base64url');
  const refreshExpiresAt = new Date(ctx.now().getTime() + parseDurationMs(ctx.env.JWT_REFRESH_TTL));
  await ctx.prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: hashToken(refreshToken), expiresAt: refreshExpiresAt },
  });
  return {
    accessToken: signAccessToken(ctx, { id: user.id, role: user.role }),
    user: userToDto(user),
    refreshToken,
    refreshExpiresAt,
  };
}

export async function register(ctx: AppContext, input: RegisterRequest): Promise<IssuedSession> {
  const passwordHash = await bcrypt.hash(input.password, ctx.env.BCRYPT_ROUNDS);
  try {
    const user = await ctx.prisma.user.create({
      data: { email: input.email, username: input.username, passwordHash },
      include: { creatorProfile: { select: { channelName: true } } },
    });
    ctx.events.emit(DOMAIN_EVENTS.USER_REGISTERED, { userId: user.id });
    return await issue(ctx, user);
  } catch (err) {
    if (isUniqueViolation(err)) {
      const emailTaken = await ctx.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
      throw emailTaken
        ? conflict('EMAIL_TAKEN', 'An account with this email already exists')
        : conflict('USERNAME_TAKEN', 'This username is taken');
    }
    throw err;
  }
}

export async function login(ctx: AppContext, input: LoginRequest): Promise<IssuedSession> {
  const user = await ctx.prisma.user.findUnique({
    where: { email: input.email },
    include: { creatorProfile: { select: { channelName: true } } },
  });
  const ok = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
  return issue(ctx, user);
}

/** Rotates the refresh token. A revoked token being replayed revokes every session of that user. */
export async function refresh(ctx: AppContext, token: string | undefined): Promise<IssuedSession> {
  if (!token) throw unauthenticated('No refresh token');
  const row = await ctx.prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row) throw unauthenticated('Invalid refresh token');
  if (row.revokedAt) {
    await ctx.prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: ctx.now() } });
    throw unauthenticated('Refresh token reuse detected; please sign in again');
  }
  if (row.expiresAt <= ctx.now()) throw unauthenticated('Refresh token expired');

  // Atomic rotation: only one concurrent request can revoke this row.
  const revoked = await ctx.prisma.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: ctx.now() } });
  if (revoked.count !== 1) throw unauthenticated('Refresh token already used');

  const user = await ctx.prisma.user.findUnique({
    where: { id: row.userId },
    include: { creatorProfile: { select: { channelName: true } } },
  });
  if (!user) throw unauthenticated('User no longer exists');
  return issue(ctx, user);
}

export async function logout(ctx: AppContext, token: string | undefined): Promise<void> {
  if (!token) return;
  await ctx.prisma.refreshToken.updateMany({ where: { tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: ctx.now() } });
}

export async function me(ctx: AppContext, userId: string): Promise<AuthResponse['user']> {
  const user = await ctx.prisma.user.findUnique({
    where: { id: userId },
    include: { creatorProfile: { select: { channelName: true } } },
  });
  if (!user) throw unauthenticated('User no longer exists');
  return userToDto(user);
}
