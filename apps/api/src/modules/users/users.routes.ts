import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { registerRequest } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { requireAuth, userId } from '../../middleware/auth';
import { AppError, conflict } from '../../middleware/errors';
import { validate } from '../../middleware/validate';
import { isUniqueViolation, userToDto } from '../common';

const updateProfile = z.object({ username: registerRequest.shape.username });
const changePassword = z.object({ currentPassword: z.string().min(1).max(72), newPassword: registerRequest.shape.password });

export function usersRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);

  router.patch('/users/me', auth, validate('body', updateProfile), async (req, res) => {
    try {
      const user = await ctx.prisma.user.update({
        where: { id: userId(req) },
        data: { username: req.body.username },
        include: { creatorProfile: { select: { channelName: true } } },
      });
      res.json({ user: userToDto(user) });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('USERNAME_TAKEN', 'This username is taken');
      throw err;
    }
  });

  router.post('/users/me/password', auth, validate('body', changePassword), async (req, res) => {
    const user = await ctx.prisma.user.findUnique({ where: { id: userId(req) } });
    if (!user || !(await bcrypt.compare(req.body.currentPassword, user.passwordHash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
    }
    const passwordHash = await bcrypt.hash(req.body.newPassword, ctx.env.BCRYPT_ROUNDS);
    await ctx.prisma.$transaction([
      ctx.prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      // Sign out every other device.
      ctx.prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: ctx.now() } }),
    ]);
    res.status(204).end();
  });

  return router;
}
