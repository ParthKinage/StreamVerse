import { useState, type FormEvent } from 'react';
import { changePasswordSchema } from './settingsSchema';
import { useAuth } from '../auth/AuthContext';
import { usersApi } from '../api/endpoints';
import { Field } from '../components/Field';
import { useToast } from '../components/Toasts';
import { mapServerError, type FieldErrors } from '../lib/forms';

export default function Settings(): JSX.Element {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [username, setUsername] = useState(user?.username ?? '');
  const [userErrors, setUserErrors] = useState<FieldErrors>({});
  const [savingUser, setSavingUser] = useState(false);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [pwErrors, setPwErrors] = useState<FieldErrors>({});
  const [pwForm, setPwForm] = useState<string | null>(null);
  const [savingPw, setSavingPw] = useState(false);

  const saveUser = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setUserErrors({});
    setSavingUser(true);
    try {
      const res = await usersApi.updateProfile({ username });
      setUser(res.user);
      toast.success('Profile updated');
    } catch (err) {
      const m = mapServerError(err);
      setUserErrors(m.fields.username ? m.fields : { username: m.form ?? 'Could not save' });
    } finally {
      setSavingUser(false);
    }
  };

  const savePw = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setPwForm(null);
    const parsed = changePasswordSchema.safeParse(pw);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const i of parsed.error.issues) if (!next[String(i.path[0])]) next[String(i.path[0])] = i.message;
      setPwErrors(next);
      return;
    }
    setPwErrors({});
    setSavingPw(true);
    try {
      await usersApi.changePassword(pw);
      setPw({ currentPassword: '', newPassword: '' });
      toast.success('Password changed');
    } catch (err) {
      const m = mapServerError(err);
      setPwErrors(m.fields);
      setPwForm(m.form ?? null);
    } finally {
      setSavingPw(false);
    }
  };

  return (
    <div className="page narrow">
      <h1>Settings</h1>
      <section className="card">
        <h2>Profile</h2>
        <p className="muted small">Signed in as {user?.email}</p>
        <form className="form" onSubmit={(e) => void saveUser(e)} noValidate>
          <Field label="Username" value={username} onChange={(e) => setUsername(e.target.value)} error={userErrors.username} />
          <button type="submit" className="btn primary" disabled={savingUser || username === user?.username}>
            {savingUser ? 'Saving…' : 'Save'}
          </button>
        </form>
      </section>
      <section className="card">
        <h2>Change password</h2>
        <form className="form" onSubmit={(e) => void savePw(e)} noValidate>
          <Field label="Current password" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw((p) => ({ ...p, currentPassword: e.target.value }))} error={pwErrors.currentPassword} />
          <Field label="New password" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw((p) => ({ ...p, newPassword: e.target.value }))} error={pwErrors.newPassword} hint="At least 8 characters" />
          {pwForm ? (
            <p className="form-error" role="alert">
              {pwForm}
            </p>
          ) : null}
          <button type="submit" className="btn primary" disabled={savingPw}>
            {savingPw ? 'Saving…' : 'Change password'}
          </button>
        </form>
      </section>
    </div>
  );
}
