import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { authApi } from '../api/endpoints';
import { Field } from '../components/Field';
import { emailOk, mapServerError, type FieldErrors } from '../lib/forms';

export default function Login(): JSX.Element {
  const { user, setSession, sessionLost, acknowledgeSessionLost } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (user && !pending) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const next: FieldErrors = {};
    if (!emailOk(email)) next.email = 'Enter a valid email address';
    if (!password) next.password = 'Enter your password';
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) return;
    setPending(true);
    try {
      const res = await authApi.login({ email, password });
      setSession(res.accessToken, res.user);
      acknowledgeSessionLost();
      navigate(from, { replace: true });
    } catch (err) {
      const m = mapServerError(err);
      setErrors(m.fields);
      setFormError(m.form ?? null);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="page narrow">
      <h1>Log in</h1>
      {sessionLost ? (
        <p className="notice" role="status">
          Your session expired. Please log in again to continue.
        </p>
      ) : null}
      <form className="form" onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} />
        {formError ? (
          <p className="form-error" role="alert">
            {formError}
          </p>
        ) : null}
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <p className="muted">
        New here? <Link to="/register">Create an account</Link>
      </p>
    </div>
  );
}
