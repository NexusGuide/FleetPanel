import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { AlertTriangle, CheckCircle2, Loader2, X, XCircle } from 'lucide-react';
import type { InstanceStatus } from '../api';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Formatting

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function toDate(value: string | number): Date {
  return typeof value === 'number' ? new Date(value) : new Date(value);
}

export function formatDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const d = toDate(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function timeAgo(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'never';
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return '—';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return d.toLocaleDateString();
}

export function Time({ value }: { value: string | number | null | undefined }) {
  return <span title={formatDate(value)}>{timeAgo(value)}</span>;
}

// ---------------------------------------------------------------------------
// Primitives

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-blue-600 hover:bg-blue-500 text-white border-blue-500/60',
  secondary: 'bg-slate-900 hover:bg-slate-800 text-slate-200 border-slate-700/80',
  danger: 'bg-rose-600/90 hover:bg-rose-500 text-white border-rose-500/60',
  ghost: 'bg-transparent hover:bg-slate-800/70 text-slate-300 border-transparent',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap',
        size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-3 py-1.5 text-xs',
        VARIANTS[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('rounded-lg bg-panel border border-slate-800/80', className)}>{children}</div>;
}

export function CardHeader({ title, icon, actions }: { title: ReactNode; icon?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="px-4 py-3 border-b border-slate-800/80 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-xs font-semibold text-white min-w-0">
        {icon}
        <span className="truncate">{title}</span>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 pb-4 mb-5 border-b border-slate-800">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-white tracking-tight">{title}</h1>
        {description && <p className="text-xs text-slate-400 mt-1">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-400">
      <Loader2 className="w-4 h-4 animate-spin" />
      {label ?? 'Loading…'}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6 gap-2">
      {icon && <div className="text-slate-600 mb-1">{icon}</div>}
      <p className="text-sm font-medium text-slate-200">{title}</p>
      {children && <div className="text-xs text-slate-400 max-w-md">{children}</div>}
    </div>
  );
}

export function ErrorBanner({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-2.5 p-3 rounded-md bg-rose-950/40 border border-rose-900/70 text-rose-200 text-xs">
      <XCircle className="w-4 h-4 shrink-0 text-rose-400 mt-px" />
      <span className="flex-1 whitespace-pre-line break-words">{error}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="underline underline-offset-2 hover:text-white shrink-0">
          Retry
        </button>
      )}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn'; children: ReactNode }) {
  return (
    <div
      className={cx(
        'flex items-start gap-2.5 p-3 rounded-md border text-xs',
        tone === 'warn'
          ? 'bg-amber-950/30 border-amber-900/60 text-amber-200'
          : 'bg-blue-950/30 border-blue-900/60 text-blue-200',
      )}
    >
      <AlertTriangle className={cx('w-4 h-4 shrink-0 mt-px', tone === 'warn' ? 'text-amber-400' : 'text-blue-400')} />
      <div className="flex-1 leading-relaxed">{children}</div>
    </div>
  );
}

const STATUS_STYLE: Record<InstanceStatus, string> = {
  running: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  stopped: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
  provisioning: 'bg-blue-500/10 text-blue-300 border-blue-500/30',
  deleting: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  error: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
};

const DOT_STYLE: Record<InstanceStatus, string> = {
  running: 'bg-emerald-400',
  stopped: 'bg-slate-400',
  provisioning: 'bg-blue-400 animate-pulse',
  deleting: 'bg-amber-400 animate-pulse',
  error: 'bg-rose-400',
};

export function StatusBadge({ status }: { status: InstanceStatus }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-medium capitalize font-mono',
        STATUS_STYLE[status],
      )}
    >
      <span className={cx('w-1.5 h-1.5 rounded-full', DOT_STYLE[status])} />
      {status}
    </span>
  );
}

export function Pill({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'blue' | 'green' | 'red' | 'amber' }) {
  const tones = {
    slate: 'bg-slate-800/80 text-slate-300 border-slate-700/80',
    blue: 'bg-blue-950/70 text-blue-300 border-blue-800/60',
    green: 'bg-emerald-950/60 text-emerald-300 border-emerald-800/60',
    red: 'bg-rose-950/60 text-rose-300 border-rose-800/60',
    amber: 'bg-amber-950/60 text-amber-300 border-amber-800/60',
  };
  return (
    <span className={cx('inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-mono uppercase tracking-wide', tones[tone])}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Forms

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-300 mb-1">{label}</span>
      {children}
      {error ? (
        <span className="block text-[11px] text-rose-400 mt-1">{error}</span>
      ) : (
        hint && <span className="block text-[11px] text-slate-500 mt-1">{hint}</span>
      )}
    </label>
  );
}

const INPUT =
  'w-full bg-slate-950 border border-slate-800 rounded-md px-3 py-2 text-sm text-white placeholder-slate-600 ' +
  'focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-60';

export function Input({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...rest} className={cx(INPUT, invalid && 'border-rose-700 focus:border-rose-500', className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(INPUT, 'py-1.5', className)}>
      {children}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Overlays

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
  busy = false,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** While true, Escape and backdrop clicks do not close the dialog. */
  busy?: boolean;
}) {
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[2px] flex items-start sm:items-center justify-center p-4 overflow-y-auto"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busyRef.current) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          'w-full bg-panel border border-slate-800 rounded-lg shadow-2xl flex flex-col max-h-[calc(100vh-2rem)]',
          wide ? 'max-w-2xl' : 'max-w-md',
        )}
      >
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-3 shrink-0">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-40"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-slate-800 flex justify-end gap-2 shrink-0">{footer}</div>}
      </div>
    </div>
  );
}

interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** When set, the user must type this exact text to enable the confirm button. */
  typeToConfirm?: string;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn>(async () => false);

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState('');

  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        setTyped('');
        setPending({ ...options, resolve });
      }),
    [],
  );

  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const blocked = pending?.typeToConfirm !== undefined && typed !== pending.typeToConfirm;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <Modal
          title={pending.title}
          onClose={() => close(false)}
          footer={
            <>
              <Button onClick={() => close(false)}>Cancel</Button>
              <Button variant={pending.danger ? 'danger' : 'primary'} disabled={blocked} onClick={() => close(true)}>
                {pending.confirmLabel}
              </Button>
            </>
          }
        >
          <div className="text-xs text-slate-300 space-y-3 leading-relaxed">
            {pending.body}
            {pending.typeToConfirm !== undefined && (
              <Field label={`Type "${pending.typeToConfirm}" to confirm`}>
                <Input
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !blocked) close(true);
                  }}
                  className="font-mono"
                />
              </Field>
            )}
          </div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Toasts

interface Toast {
  id: number;
  tone: 'success' | 'error';
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi>({ success: () => undefined, error: () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (tone: Toast['tone'], message: string) => {
      const id = nextId.current++;
      setToasts((all) => [...all.slice(-3), { id, tone, message }]);
      // Errors stay longer: they usually carry the reason an operation failed.
      window.setTimeout(() => dismiss(id), tone === 'error' ? 9000 : 4000);
    },
    [dismiss],
  );

  const [apiValue] = useState<ToastApi>(() => ({
    success: (m) => push('success', m),
    error: (m) => push('error', m),
  }));

  return (
    <ToastContext.Provider value={apiValue}>
      {children}
      <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[60] flex flex-col gap-2 sm:w-96 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={cx(
              'pointer-events-auto flex items-start gap-2.5 p-3 rounded-md border shadow-xl text-xs bg-panel',
              t.tone === 'error' ? 'border-rose-800/80 text-rose-200' : 'border-emerald-800/70 text-emerald-200',
            )}
          >
            {t.tone === 'error' ? (
              <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-px" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-px" />
            )}
            <span className="flex-1 whitespace-pre-line break-words">{t.message}</span>
            <button type="button" onClick={() => dismiss(t.id)} className="text-slate-500 hover:text-white" aria-label="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Data loading

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Loads data once and optionally re-polls. Polling pauses while the tab is hidden,
 * and a failed refresh keeps the last good data instead of blanking the page.
 */
export function useResource<T>(load: () => Promise<T>, deps: unknown[], pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    try {
      const value = await loadRef.current();
      setData(value);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!pollMs) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs, reload]);

  return { data, error, loading, reload, setData };
}
