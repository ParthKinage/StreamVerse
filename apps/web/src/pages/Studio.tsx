import { Suspense, lazy, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { creatorApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Field } from '../components/Field';
import { useToast } from '../components/Toasts';
import { mapServerError, type FieldErrors } from '../lib/forms';
import { EarningsCard } from '../components/EarningsCard';
import { AnalyticsTab, UploadTab, VideosTab } from './studio/tabs';
import { PageSpinner } from '../components/States';

// The live sender carries a video encoder library; load it only when the creator opens this tab.
const LiveTab = lazy(() => import('./studio/LiveTab').then((m) => ({ default: m.LiveTab })));

type Tab = 'videos' | 'upload' | 'live' | 'analytics' | 'earnings';

function BecomeCreator(): JSX.Element {
  const { setUser } = useAuth();
  const toast = useToast();
  const [channelName, setChannelName] = useState('');
  const [bio, setBio] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState(false);
  return (
    <div className="page narrow">
      <h1>Start your channel</h1>
      <p className="muted">Anyone can publish on StreamVerse. Set your own price per minute and keep 90% of what viewers pay.</p>
      <form
        className="form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (channelName.trim().length < 2) return setErrors({ channelName: 'Channel name must be at least 2 characters' });
          setErrors({});
          setPending(true);
          creatorApi
            .becomeCreator({ channelName: channelName.trim(), ...(bio.trim() ? { bio: bio.trim() } : {}) })
            .then((r) => {
              setUser(r.user);
              toast.success('Your channel is ready');
            })
            .catch((err) => {
              const m = mapServerError(err);
              setErrors(m.fields.channelName ? m.fields : { channelName: m.form ?? errorMessage(err) });
            })
            .finally(() => setPending(false));
        }}
      >
        <Field label="Channel name" value={channelName} onChange={(e) => setChannelName(e.target.value)} error={errors.channelName} />
        <Field label="Bio (optional)" value={bio} onChange={(e) => setBio(e.target.value)} maxLength={500} />
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? 'Creating…' : 'Create channel'}
        </button>
      </form>
    </div>
  );
}

export default function Studio(): JSX.Element {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('videos');
  if (!user?.channelName) return <BecomeCreator />;
  const tabs: Array<[Tab, string]> = [
    ['videos', 'Videos'],
    ['upload', 'Upload'],
    ['live', 'Go live'],
    ['analytics', 'Analytics'],
    ['earnings', 'Earnings'],
  ];
  return (
    <div className="page">
      <h1>Studio · {user.channelName}</h1>
      <div className="tabs" role="tablist" aria-label="Studio sections">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} className={tab === id ? 'tab active' : 'tab'} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'videos' ? <VideosTab onUpload={() => setTab('upload')} /> : null}
        {tab === 'upload' ? <UploadTab onUploaded={() => setTab('videos')} /> : null}
        {tab === 'live' ? (
          <Suspense fallback={<PageSpinner label="Loading" />}>
            <LiveTab />
          </Suspense>
        ) : null}
        {tab === 'analytics' ? <AnalyticsTab /> : null}
        {tab === 'earnings' ? <EarningsCard /> : null}
      </div>
    </div>
  );
}
