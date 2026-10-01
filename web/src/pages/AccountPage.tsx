import { useState, type FormEvent } from 'react';
import { KeyRound, LogOut, Monitor } from 'lucide-react';
import { api, passwordProblems, type Me } from '../api';
import {
  Button,
  Card,
  CardHeader,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  Pill,
  Spinner,
  Time,
  errorText,
  useConfirm,
  useResource,
  useToast,
} from '../components/ui';

function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export function AccountPage({ me, onLoggedOut }: { me: Me; onLoggedOut: () => Promise<void> }) {
  const toast = useToast();
  const confirm = useConfirm();
  const sessions = useResource(api.sessions, []);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const problems = passwordProblems(next);
  const mismatch = repeat.length > 0 && repeat !== next;
  const canSave = current.length > 0 && next.length > 0 && problems.length === 0 && repeat === next;

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setRepeat('');
      toast.success('Password changed. Your other sessions were signed out.');
      void sessions.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (publicId: string, isCurrent: boolean) => {
    if (isCurrent) {
      if (await confirm({ title: 'Sign out?', body: <p>This ends the session you are using now.</p>, confirmLabel: 'Sign out' })) {
        await onLoggedOut();
      }
      return;
    }
    setRevoking(publicId);
    try {
      await api.revokeSession(publicId);
      toast.success('Session signed out.');
      void sessions.reload();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="My account"
        description={
          <>
            Signed in as <span className="font-mono text-slate-200">{me.username}</span> · <Pill tone="blue">{me.role}</Pill>
          </>
        }
        actions={
          <Button icon={<LogOut className="w-3.5 h-3.5" />} onClick={() => void onLoggedOut()}>
            Sign out
          </Button>
        }
      />

      <div className="grid lg:grid-cols-2 gap-5 items-start">
        <Card>
          <CardHeader title="Change password" icon={<KeyRound className="w-4 h-4 text-blue-400" />} />
          <form onSubmit={changePassword} className="p-4 space-y-4">
            {error && <ErrorBanner error={error} />}
            <input type="text" autoComplete="username" value={me.username} readOnly hidden />
            <Field label="Current password">
              <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
            <Field
              label="New password"
              hint="At least 12 characters, mixing three of: lowercase, uppercase, digits, symbols."
              error={next && problems.length ? `Needs ${problems.join(', ')}.` : null}
            >
              <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            </Field>
            <Field label="Repeat new password" error={mismatch ? 'Passwords do not match.' : null}>
              <Input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} invalid={mismatch} />
            </Field>
            <Button type="submit" variant="primary" loading={saving} disabled={!canSave}>
              Change password
            </Button>
          </form>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="Active sessions" icon={<Monitor className="w-4 h-4 text-blue-400" />} />
          {sessions.error ? (
            <div className="p-4">
              <ErrorBanner error={sessions.error} onRetry={() => void sessions.reload()} />
            </div>
          ) : !sessions.data ? (
            <Spinner />
          ) : (
            <ul className="divide-y divide-slate-800/70">
              {sessions.data.map((s) => (
                <li key={s.public_id} className="px-4 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-200 flex items-center gap-2">
                      {describeAgent(s.user_agent)}
                      {s.current && <Pill tone="green">this device</Pill>}
                    </p>
                    <p className="text-[11px] text-slate-500 font-mono">
                      {s.ip ?? 'unknown IP'} · active <Time value={s.last_activity} /> · signed in <Time value={s.created_at} />
                    </p>
                  </div>
                  <Button size="sm" loading={revoking === s.public_id} disabled={revoking !== null} onClick={() => void revoke(s.public_id, s.current)}>
                    Sign out
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="px-4 py-3 border-t border-slate-800 text-[11px] text-slate-500">
            Sessions end after 2 hours of inactivity or 24 hours in total.
          </p>
        </Card>
      </div>
    </div>
  );
}
