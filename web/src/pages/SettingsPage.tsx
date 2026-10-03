import { useEffect, useState, type FormEvent } from 'react';
import { Download, LifeBuoy, Send, ShieldCheck, UploadCloud } from 'lucide-react';
import { BOT_TOKEN_RE, api, type BackupSchedule, type BackupSettings } from '../api';
import {
  Button,
  Card,
  CardHeader,
  ErrorBanner,
  Field,
  Input,
  Notice,
  PageHeader,
  Pill,
  Select,
  Spinner,
  Time,
  errorText,
  useResource,
  useToast,
} from '../components/ui';

const SCHEDULES: Array<[BackupSchedule, string]> = [
  ['hourly', 'Every hour'],
  ['6h', 'Every 6 hours'],
  ['daily', 'Every day'],
];
const CHAT_ID_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const PASSPHRASE_MIN = 12;

export function SettingsPage() {
  const settings = useResource(api.backupSettings, []);

  return (
    <div className="space-y-5">
      <PageHeader title="Settings" description="Encrypted backups of the panel itself, sent to Telegram." />
      {settings.error && <ErrorBanner error={settings.error} onRetry={() => void settings.reload()} />}
      {!settings.data && !settings.error && <Spinner />}
      {settings.data && (
        <div className="grid lg:grid-cols-[3fr_2fr] gap-5 items-start">
          <BackupCard current={settings.data} onSaved={() => void settings.reload()} />
          <RecoveryCard />
        </div>
      )}
    </div>
  );
}

function BackupCard({ current, onSaved }: { current: BackupSettings; onSaved: () => void }) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(current.enabled);
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState(current.chat_id);
  const [threadId, setThreadId] = useState(current.thread_id);
  const [schedule, setSchedule] = useState<BackupSchedule>(current.schedule);
  const [changePassphrase, setChangePassphrase] = useState(!current.has_passphrase);
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setChangePassphrase(!current.has_passphrase), [current.has_passphrase]);

  const tokenError = token && !BOT_TOKEN_RE.test(token.trim()) ? 'Looks like 123456789:AA… — from @BotFather.' : null;
  const chatError = chatId && !CHAT_ID_RE.test(chatId.trim()) ? 'A numeric chat id (e.g. -1001234567890) or @channelname.' : null;
  const threadError = threadId && !/^\d{1,10}$/.test(threadId.trim()) ? 'A numeric topic id, or empty.' : null;
  const passError =
    changePassphrase && passphrase && passphrase.length < PASSPHRASE_MIN ? `At least ${PASSPHRASE_MIN} characters.` : null;
  const repeatError = changePassphrase && repeat && repeat !== passphrase ? 'Passphrases do not match.' : null;
  const needsPassphrase = changePassphrase && (passphrase.length > 0 || !current.has_passphrase);
  const valid =
    !tokenError &&
    !chatError &&
    !threadError &&
    chatId.trim().length > 0 &&
    (current.has_token || token.trim().length > 0) &&
    (!needsPassphrase || (passphrase.length >= PASSPHRASE_MIN && repeat === passphrase));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy('save');
    setError(null);
    try {
      await api.saveBackupSettings({
        enabled,
        chat_id: chatId.trim(),
        thread_id: threadId.trim(),
        schedule,
        ...(token.trim() ? { bot_token: token.trim() } : {}),
        ...(needsPassphrase ? { passphrase } : {}),
      });
      setToken('');
      setPassphrase('');
      setRepeat('');
      toast.success('Backup settings saved.');
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const act = async (kind: 'test' | 'run') => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'test') {
        await api.testBackup();
        toast.success('Test message sent.');
      } else {
        const res = await api.runBackup();
        toast.success(`Sent ${res.file}.`);
      }
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const configured = current.has_token && current.has_passphrase && current.chat_id !== '';

  return (
    <Card>
      <CardHeader
        title="Telegram backup"
        icon={<UploadCloud className="w-4 h-4 text-blue-400" />}
        actions={
          current.enabled ? (
            <Pill tone="green">auto: {SCHEDULES.find(([v]) => v === current.schedule)?.[1].toLowerCase()}</Pill>
          ) : (
            <Pill>auto: off</Pill>
          )
        }
      />
      <form onSubmit={save} className="p-4 space-y-4">
        {error && <ErrorBanner error={error} />}
        {current.last_error && !error && <ErrorBanner error={`Last backup failed: ${current.last_error}`} />}
        {current.last_sent_at && (
          <p className="text-[11px] text-slate-400">
            Last sent <Time value={current.last_sent_at} />
            {current.last_file && <span className="font-mono"> · {current.last_file}</span>}
          </p>
        )}

        <Field
          label="Bot token"
          hint={current.has_token ? `Saved${current.bot_username ? ` (@${current.bot_username})` : ''}. Leave empty to keep it.` : 'A bot of your own from @BotFather; add it to the chat.'}
          error={tokenError}
        >
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={current.has_token ? '••••••••' : '123456789:AA…'}
            className="font-mono"
            invalid={!!tokenError}
            autoComplete="off"
          />
        </Field>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Chat ID" hint="Your numeric Telegram id (send /start to the bot first), or a group/channel id (-100…)." error={chatError}>
            <Input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="-1001234567890" className="font-mono" invalid={!!chatError} />
          </Field>
          <Field label="Topic ID (optional)" hint="For a topic in a forum group." error={threadError}>
            <Input value={threadId} onChange={(e) => setThreadId(e.target.value)} placeholder="12" className="font-mono" invalid={!!threadError} inputMode="numeric" />
          </Field>
        </div>
        <div className="grid sm:grid-cols-2 gap-4 items-end">
          <Field label="Schedule" hint="Sent only when something changed, and at least daily.">
            <Select value={schedule} onChange={(e) => setSchedule(e.target.value as BackupSchedule)}>
              {SCHEDULES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-2 text-xs text-slate-200 pb-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-blue-500" />
            Send backups automatically
          </label>
        </div>

        <div className="rounded-lg border border-slate-800 p-3 space-y-3">
          <p className="flex items-center gap-2 text-xs font-medium text-slate-200">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> Recovery passphrase
            {current.has_passphrase && !changePassphrase && <Pill tone="green">set</Pill>}
          </p>
          {changePassphrase ? (
            <>
              <Notice tone="warn">
                Every backup is encrypted with it. Store it in a password manager: without it no backup can be
                restored{current.has_passphrase ? ', and backups made before the change still need the old one' : ''}.
              </Notice>
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label="Passphrase" error={passError}>
                  <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" invalid={!!passError} />
                </Field>
                <Field label="Repeat" error={repeatError}>
                  <Input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" invalid={!!repeatError} />
                </Field>
              </div>
            </>
          ) : (
            <Button size="sm" onClick={() => setChangePassphrase(true)}>
              Change passphrase
            </Button>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={busy === 'save'} disabled={!valid || busy !== null}>
            Save
          </Button>
          <Button icon={<Send className="w-3.5 h-3.5" />} loading={busy === 'test'} disabled={!configured || busy !== null} onClick={() => void act('test')}>
            Send test message
          </Button>
          <Button icon={<UploadCloud className="w-3.5 h-3.5" />} loading={busy === 'run'} disabled={!configured || busy !== null} onClick={() => void act('run')}>
            Back up now
          </Button>
          {current.has_passphrase && (
            <a
              href={api.backupDownloadUrl}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              <Download className="w-3.5 h-3.5" /> Download
            </a>
          )}
        </div>
      </form>
    </Card>
  );
}

function RecoveryCard() {
  return (
    <Card>
      <CardHeader title="Restore on a new server" icon={<LifeBuoy className="w-4 h-4 text-blue-400" />} />
      <ol className="p-4 space-y-2 text-xs text-slate-300 list-decimal list-inside">
        <li>Install FleetPanel on the new server.</li>
        <li>Copy the latest <span className="font-mono">.fleet</span> file from Telegram to the server.</li>
        <li>
          Run <span className="font-mono text-slate-100">sudo fleetpanel restore &lt;file&gt;.fleet</span> and enter the passphrase.
        </li>
        <li>
          Press <b>Repair</b> on each bot (they are marked in <i>Instances</i>).
        </li>
        <li>
          Bring back each bot's data: <b>Import database</b> in its details, with the bot's own backup.
        </li>
      </ol>
      <p className="px-4 pb-4 text-[11px] text-slate-500">
        The backup holds the panel's database, administrators, bot settings and encryption key, not the bots' own data.
      </p>
    </Card>
  );
}
