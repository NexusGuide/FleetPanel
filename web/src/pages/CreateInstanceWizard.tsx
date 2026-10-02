import { useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Eye, EyeOff, Layers } from 'lucide-react';
import {
  BOT_TOKEN_RE,
  DOMAIN_RE,
  SLUG_RE,
  TELEGRAM_ID_RE,
  api,
  type CreateInstanceInput,
  type Instance,
  type InstanceCheck,
} from '../api';
import { Button, ErrorBanner, Field, Input, Modal, Notice, Spinner, cx, errorText, useResource } from '../components/ui';

type Step = 0 | 1 | 2;
const STEP_LABELS = ['Provider', 'Details', 'Review'];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+/g, '-')
    .slice(0, 29)
    .replace(/-+$/, '');
}

function validate(form: CreateInstanceInput): Partial<Record<keyof CreateInstanceInput, string>> {
  const errors: Partial<Record<keyof CreateInstanceInput, string>> = {};
  if (!SLUG_RE.test(form.slug)) {
    errors.slug = '3–29 characters: lowercase letters, digits and hyphens; starts with a letter, no trailing hyphen.';
  }
  if (!DOMAIN_RE.test(form.domain.trim().toLowerCase())) errors.domain = 'Enter a hostname such as bot.example.com (no http://).';
  if (!BOT_TOKEN_RE.test(form.bot_token.trim())) errors.bot_token = 'Looks like 123456789:AA… — copy it from @BotFather.';
  if (!TELEGRAM_ID_RE.test(form.admin_telegram_id.trim())) errors.admin_telegram_id = 'A numeric Telegram user id (ask @userinfobot).';
  return errors;
}

export function CreateInstanceWizard({ onClose, onCreated }: { onClose: () => void; onCreated: (inst: Instance) => void }) {
  const providers = useResource(api.providers, []);
  const [step, setStep] = useState<Step>(0);
  const [form, setForm] = useState<CreateInstanceInput>({ slug: '', provider: '', domain: '', bot_token: '', admin_telegram_id: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<keyof CreateInstanceInput, boolean>>>({});
  const [showToken, setShowToken] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  // Duplicates reported by the server, kept until the user edits that field.
  const [conflicts, setConflicts] = useState<InstanceCheck['conflicts']>({});
  const [botUsername, setBotUsername] = useState<string | null>(null);

  const errors = useMemo(() => validate(form), [form]);
  const detailsValid = !errors.slug && !errors.domain && !errors.bot_token && !errors.admin_telegram_id;
  const providerName = providers.data?.find((p) => p.id === form.provider)?.name ?? form.provider;

  const set = (key: keyof CreateInstanceInput, value: string) => {
    setForm((f) => {
      const next = { ...f, [key]: value };
      // Suggest a slug from the domain's first label until the user edits it.
      if (key === 'domain' && !slugTouched) next.slug = slugify(value.split('.')[0] ?? '');
      return next;
    });
    setSubmitError(null);
    setCheckError(null);
    setConflicts((c) => {
      const next = { ...c };
      delete next[key as keyof typeof c];
      if (key === 'domain' && !slugTouched) delete next.slug;
      return next;
    });
  };

  const fieldError = (key: keyof CreateInstanceInput) =>
    (touched[key] ? errors[key] : undefined) ?? conflicts[key as keyof typeof conflicts];

  const normalized = (): CreateInstanceInput => ({
    ...form,
    domain: form.domain.trim().toLowerCase(),
    bot_token: form.bot_token.trim(),
    admin_telegram_id: form.admin_telegram_id.trim(),
  });

  const review = async () => {
    setTouched({ slug: true, domain: true, bot_token: true, admin_telegram_id: true });
    if (!detailsValid) return;
    setChecking(true);
    setCheckError(null);
    try {
      const res = await api.checkInstance(normalized());
      setConflicts(res.conflicts);
      setBotUsername(res.bot_username);
      if (Object.keys(res.conflicts).length === 0) setStep(2);
    } catch (err) {
      setCheckError(errorText(err));
    } finally {
      setChecking(false);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const inst = await api.createInstance(normalized());
      onCreated(inst);
    } catch (err) {
      setSubmitError(errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const footer = (
    <>
      {step > 0 && (
        <Button icon={<ChevronLeft className="w-3.5 h-3.5" />} disabled={submitting} onClick={() => setStep((s) => (s - 1) as Step)}>
          Back
        </Button>
      )}
      {step === 0 && (
        <Button variant="primary" disabled={!form.provider} onClick={() => setStep(1)}>
          Continue <ChevronRight className="w-3.5 h-3.5" />
        </Button>
      )}
      {step === 1 && (
        <Button variant="primary" loading={checking} onClick={() => void review()}>
          Review <ChevronRight className="w-3.5 h-3.5" />
        </Button>
      )}
      {step === 2 && (
        <Button variant="primary" loading={submitting} onClick={() => void submit()}>
          Create instance
        </Button>
      )}
    </>
  );

  return (
    <Modal title="New bot instance" onClose={onClose} footer={footer} wide busy={submitting}>
      <ol className="flex items-center gap-2 mb-5">
        {STEP_LABELS.map((label, i) => (
          <li key={label} className="flex items-center gap-2 text-[11px]">
            <span
              className={cx(
                'w-5 h-5 rounded-full flex items-center justify-center font-mono border',
                i < step && 'bg-blue-600 border-blue-500 text-white',
                i === step && 'border-blue-500 text-blue-300',
                i > step && 'border-slate-700 text-slate-500',
              )}
            >
              {i < step ? <Check className="w-3 h-3" /> : i + 1}
            </span>
            <span className={i === step ? 'text-white font-medium' : 'text-slate-500'}>{label}</span>
            {i < STEP_LABELS.length - 1 && <span className="w-6 h-px bg-slate-700" />}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="space-y-3">
          <p className="text-xs text-slate-400">Which bot software should this instance run?</p>
          {providers.error && <ErrorBanner error={providers.error} onRetry={() => void providers.reload()} />}
          {!providers.data && !providers.error && <Spinner />}
          <div className="grid sm:grid-cols-2 gap-3">
            {providers.data?.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => set('provider', p.id)}
                className={cx(
                  'text-left p-3.5 rounded-lg border transition-colors',
                  form.provider === p.id ? 'border-blue-500 bg-blue-600/10' : 'border-slate-800 bg-slate-950 hover:border-slate-700',
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-white">
                  <Layers className="w-4 h-4 text-blue-400" /> {p.name}
                </span>
                <span className="block text-[11px] text-slate-500 font-mono mt-1 break-all">{p.repo_url.replace(/^https:\/\//, '')}</span>
                <span className="block text-[11px] text-slate-500 font-mono mt-0.5">
                  {p.version} · {p.commit.slice(0, 12)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <Field label="Domain" hint="Its DNS A/AAAA record must already point to this server." error={fieldError('domain')}>
            <Input
              autoFocus
              value={form.domain}
              onChange={(e) => set('domain', e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, domain: true }))}
              placeholder="shop.example.com"
              className="font-mono"
              invalid={!!fieldError('domain')}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Instance name (slug)" hint="Used for the Linux user, database and folder names. Cannot be changed later." error={fieldError('slug')}>
            <Input
              value={form.slug}
              onChange={(e) => {
                setSlugTouched(true);
                set('slug', e.target.value.toLowerCase());
              }}
              onBlur={() => setTouched((t) => ({ ...t, slug: true }))}
              placeholder="shop-bot"
              className="font-mono"
              invalid={!!fieldError('slug')}
              maxLength={29}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Bot token" hint="From @BotFather. Stored encrypted; it is checked with Telegram before anything is installed." error={fieldError('bot_token')}>
            <div className="relative">
              <Input
                type={showToken ? 'text' : 'password'}
                value={form.bot_token}
                onChange={(e) => set('bot_token', e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, bot_token: true }))}
                placeholder="123456789:AA…"
                className="font-mono pr-9"
                invalid={!!fieldError('bot_token')}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-200"
                title={showToken ? 'Hide' : 'Show'}
              >
                {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </Field>
          <Field label="Admin Telegram user ID" hint="The numeric id of the account that administers this bot." error={fieldError('admin_telegram_id')}>
            <Input
              value={form.admin_telegram_id}
              onChange={(e) => set('admin_telegram_id', e.target.value.replace(/\s/g, ''))}
              onBlur={() => setTouched((t) => ({ ...t, admin_telegram_id: true }))}
              placeholder="123456789"
              inputMode="numeric"
              className="font-mono"
              invalid={!!fieldError('admin_telegram_id')}
              autoComplete="off"
            />
          </Field>
          {checkError && <ErrorBanner error={checkError} />}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <dl className="rounded-lg bg-slate-950 border border-slate-800 divide-y divide-slate-800 text-xs">
            {[
              ['Provider', providerName],
              ['Domain', form.domain.trim().toLowerCase()],
              ['Slug', form.slug],
              ['Telegram bot', botUsername ? `@${botUsername}` : '—'],
              ['Bot token', `${form.bot_token.trim().split(':')[0]}:••••••`],
              ['Admin Telegram ID', form.admin_telegram_id.trim()],
              ['Database', `fp_${form.slug.replace(/-/g, '_')}`],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 px-3 py-2">
                <dt className="text-slate-500">{k}</dt>
                <dd className="font-mono text-slate-200 break-all text-right">{v}</dd>
              </div>
            ))}
          </dl>
          <Notice tone="warn">
            Before you continue, make sure <b className="font-mono">{form.domain.trim().toLowerCase()}</b> resolves to this
            server and port 80 is open. Let's Encrypt and Telegram both need to reach it over the internet, otherwise
            the install stops with an error (you can fix DNS and press Reprovision).
          </Notice>
          {submitError && <ErrorBanner error={submitError} />}
        </div>
      )}
    </Modal>
  );
}
