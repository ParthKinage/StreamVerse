import { z } from 'zod';
import { registerRequest } from '@tesor_gp/shared';

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: registerRequest.shape.password,
});
