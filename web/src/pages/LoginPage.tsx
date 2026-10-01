import { useState, type FormEvent } from 'react';
import { ArrowRight, Bot, ShieldCheck } from 'lucide-react';
import { api, type Me } from '../api';
import { Button, ErrorBanner, Field, Input, Notice, errorText } from '../components/ui';

export function LoginPage({ notice, onLogin }: { notice: string | null; onLogin: (me: Me) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      onLogin(await api.login(username.trim(), password));
    } catch (err) {
      setError(errorText(err));
      setPassword('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-base flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 p-0.5 mx-auto mb-3 shadow-xl shadow-blue-950/50">
            <div className="w-full h-full bg-base rounded-2xl flex items-center justify-center text-blue-400">
              <Bot className="w-7 h-7" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">FleetPanel</h1>
          <p className="text-xs text-slate-400 mt-1">Telegram bot fleet control plane</p>
        </div>

        <div className="bg-panel border border-slate-800 rounded-2xl p-6 shadow-2xl">
          <form onSubmit={submit} className="space-y-4">
            {notice && !error && <Notice tone="warn">{notice}</Notice>}
            {error && <ErrorBanner error={error} />}
            <Field label="Username">
              <Input
                autoFocus
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="font-mono"
                required
                maxLength={64}
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="font-mono"
                required
                maxLength={256}
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              loading={loading}
              disabled={!username.trim() || !password}
              className="w-full py-2.5"
            >
              {loading ? 'Signing in…' : 'Sign in'}
              {!loading && <ArrowRight className="w-4 h-4" />}
            </Button>
          </form>
          <p className="mt-5 pt-4 border-t border-slate-800 text-[11px] text-slate-500 text-center leading-relaxed">
            Forgot your password? On the server run
            <br />
            <code className="text-slate-300 font-mono">sudo fleetpanel reset-password &lt;username&gt;</code>
          </p>
        </div>

        <div className="mt-6 flex items-center justify-center gap-1.5 text-[11px] text-slate-500 font-mono">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-500/80" />
          <span>Argon2id · HttpOnly session · CSRF protected</span>
        </div>
      </div>
    </div>
  );
}
