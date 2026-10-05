import { ApiError } from '../api/client';

export type FieldErrors = Record<string, string>;

/** Maps API errors to form fields where possible; the rest becomes a form-level message. */
export function mapServerError(err: unknown): { fields: FieldErrors; form?: string } {
  if (!(err instanceof ApiError)) return { fields: {}, form: err instanceof Error ? err.message : 'Something went wrong' };
  switch (err.code) {
    case 'EMAIL_TAKEN':
      return { fields: { email: err.message } };
    case 'USERNAME_TAKEN':
      return { fields: { username: err.message } };
    case 'VALIDATION_ERROR': {
      const issues = Array.isArray(err.details) ? (err.details as Array<{ path?: string; message: string }>) : [];
      const fields: FieldErrors = {};
      for (const i of issues) {
        const key = String(i.path ?? '').split('.')[0] ?? '';
        if (key && !fields[key]) fields[key] = i.message;
      }
      return Object.keys(fields).length ? { fields } : { fields: {}, form: err.message };
    }
    default:
      return { fields: {}, form: err.message };
  }
}

export const emailOk = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
