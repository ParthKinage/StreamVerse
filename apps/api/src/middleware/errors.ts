import type { ErrorCode } from '@tesor_gp/shared';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: ErrorCode, message: string, details?: unknown): AppError => new AppError(400, code, message, details);
export const unauthenticated = (message = 'Authentication required'): AppError => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'Forbidden', code: ErrorCode = 'FORBIDDEN'): AppError => new AppError(403, code, message);
export const notFound = (message = 'Not found'): AppError => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code: ErrorCode, message: string, details?: unknown): AppError => new AppError(409, code, message, details);
