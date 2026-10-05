import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { registerRequest } from '@tesor_gp/shared';
import { useAuth } from '../auth/AuthContext';
import { authApi } from '../api/endpoints';
import { Field } from '../components/Field';
import { mapServerError, type FieldErrors } from '../lib/forms';

export default function Register(): JSX.Element {
  const { user, setSession } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', username: '', password: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (user && !pending) return <Navigate to="/" replace />;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setFormError(null);
    const parsed = registerRequest.safeParse(form);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const i of parsed.error.issues) {
        const key = String(i.path[0]);
        if (!next[key]) next[key] = i.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const res = await authApi.register(parsed.data);
      setSession(res.accessToken, res.user);
      // Keep `pending` set: resetting it here would let the "already signed in" redirect to / win over this navigation.
      navigate('/wallet', { replace: true });
      return;
    } catch (err) {
      const m = mapServerError(err);
      setErrors(m.fields);
      setFormError(m.form ?? null);
    }
    setPending(false);
  };

  return (
    <div className="page narrow">
      <h1>Create your account</h1>
      <form className="form" onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Email" type="email" autoComplete="email" value={form.email} onChange={set('email')} error={errors.email} />
        <Field label="Username" autoComplete="username" value={form.username} onChange={set('username')} error={errors.username} hint="3–30 letters, numbers or underscores" />
        <Field label="Password" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} error={errors.password} hint="At least 8 characters" />
        {formError ? (
          <p className="form-error" role="alert">
            {formError}
          </p>
        ) : null}
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? 'Creating account…' : 'Sign up'}
        </button>
      </form>
      <p className="muted">
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </div>
  );
}
