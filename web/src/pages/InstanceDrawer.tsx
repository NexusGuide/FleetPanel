import { useEffect, useState, type ReactNode } from 'react';
import { Archive, Copy, DatabaseBackup, ExternalLink, Loader2, X } from 'lucide-react';
import { api, instanceWebUrl, type Instance, type Permission } from '../api';
import { Button, ErrorBanner, Notice, Spinner, StatusBadge, Time, formatDate, useResource, useToast } from '../components/ui';
import { InstanceActionButtons } from './InstancesPage';
import { useInstanceActions } from './instanceActions';
import { BackupTable } from './BackupsPage';
import { ImportDatabaseModal } from './ImportDatabaseModal';

function Row({ label, children, copy }: { label: string; children: ReactNode; copy?: string }) {
  const toast = useToast();
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-slate-800/60 last:border-0">
      <dt className="text-[11px] text-slate-500 shrink-0 pt-px">{label}</dt>
      <dd className="text-xs text-slate-200 font-mono text-right break-all flex items-center gap-1.5">
        {children}
        {copy && (
          <button
            type="button"
            title="Copy"
            className="text-slate-500 hover:text-slate-200"
            onClick={() => {
              navigator.clipboard?.writeText(copy).then(
                () => toast.success('Copied.'),
                () => toast.error('Clipboard is not available.'),
              );
            }}
          >
            <Copy className="w-3 h-3" />
          </button>
        )}
      </dd>
    </div>
  );
}

export function InstanceDrawer({
  instanceId,
  instance,
  can,
  onClose,
  onChanged,
  onRemoved,
}: {
  instanceId: number;
  instance: Instance | null;
  can: (p: Permission) => boolean;
  onClose: () => void;
  onChanged: (inst: Instance) => void;
  onRemoved: (id: number) => void;
}) {
  const backups = useResource(
    () => (can('backups.read') ? api.instanceBackups(instanceId) : Promise.resolve([])),
    [instanceId],
  );
  const actions = useInstanceActions({
    onChanged,
    onRemoved,
    onBackup: () => void backups.reload(),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The shared list can lag behind (e.g. right after creation), so also fetch this one directly.
  const fetched = useResource(() => api.instance(instanceId), [instanceId]);
  const providers = useResource(api.providers, []);
  const inst = instance ?? fetched.data;
  const [importing, setImporting] = useState(false);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <aside className="relative w-full max-w-xl h-full bg-base border-l border-slate-800 shadow-2xl flex flex-col">
        <div className="h-14 px-4 border-b border-slate-800 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-white font-mono truncate">{inst?.slug ?? `Instance #${instanceId}`}</span>
            {inst && <StatusBadge status={inst.status} />}
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-800" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {!inst ? (
            fetched.error ? (
              <ErrorBanner error={fetched.error} />
            ) : (
              <Spinner />
            )
          ) : (
            <>
              <InstanceActionButtons inst={inst} can={can} actions={actions} />

              {inst.status === 'provisioning' && (
                <div className="p-3 rounded-md bg-blue-950/30 border border-blue-900/60 text-xs text-blue-200">
                  <p className="flex items-center gap-2 font-medium">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Installing… usually 1–5 minutes.
                  </p>
                </div>
              )}

              {inst.status === 'error' && (
                <div className="space-y-2">
                  <ErrorBanner error={inst.last_error ?? 'The last operation failed without a message.'} />
                  {can('instances.create') && (
                    <p className="text-[11px] text-slate-400">
                      Fix the cause above, then press <b>Reprovision</b>. The database and settings are kept.
                    </p>
                  )}
                </div>
              )}

              {inst.status === 'stopped' && (
                <Notice tone="warn">This bot is stopped: its site is disabled and Telegram cannot deliver updates.</Notice>
              )}

              <section>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Details</h3>
                <dl className="rounded-lg bg-panel border border-slate-800/80 px-3">
                  <Row label="Provider">{inst.provider}</Row>
                  <Row label="Source commit" copy={inst.source_commit ?? undefined}>
                    {inst.source_commit ? inst.source_commit.slice(0, 12) : '—'}
                  </Row>
                  <Row label="Domain" copy={inst.domain}>
                    {inst.domain}
                  </Row>
                  <Row label="Web panel" copy={instanceWebUrl(inst, providers.data)}>
                    <a
                      href={instanceWebUrl(inst, providers.data)}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="hover:text-blue-300 inline-flex items-center gap-1"
                    >
                      /{providers.data?.find((p) => p.id === inst.provider)?.web_path ?? ''} <ExternalLink className="w-3 h-3" />
                    </a>
                  </Row>
                  <Row label="Telegram bot">
                    {inst.bot_username ? (
                      <a href={`https://t.me/${inst.bot_username}`} target="_blank" rel="noreferrer noopener" className="hover:text-blue-300 inline-flex items-center gap-1">
                        @{inst.bot_username} <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : (
                      '—'
                    )}
                  </Row>
                  <Row label="Admin Telegram ID" copy={inst.admin_telegram_id}>
                    {inst.admin_telegram_id}
                  </Row>
                  <Row label="Database" copy={inst.db_name}>
                    {inst.db_name}
                  </Row>
                  <Row label="Database user">{inst.db_user}</Row>
                  <Row label="Linux user">fp-{inst.slug}</Row>
                  {inst.app_port !== null && (
                    <Row label="Service">
                      fleetpanel-bot-{inst.slug} · 127.0.0.1:{inst.app_port}
                    </Row>
                  )}
                  <Row label="Files">/opt/fleetpanel/instances/{inst.slug}</Row>
                  <Row label="Created">{formatDate(inst.created_at)}</Row>
                  <Row label="Last change">
                    <Time value={inst.updated_at} />
                  </Row>
                </dl>
              </section>

              {can('backups.read') && (
                <section>
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                      <Archive className="w-3.5 h-3.5" /> Backups
                    </h3>
                    {can('backups.restore') && (inst.status === 'running' || inst.status === 'stopped') && (
                      <Button size="sm" icon={<DatabaseBackup className="w-3 h-3" />} onClick={() => setImporting(true)}>
                        Import database
                      </Button>
                    )}
                  </div>
                  <div className="rounded-lg bg-panel border border-slate-800/80 overflow-hidden">
                    {backups.error ? (
                      <div className="p-3">
                        <ErrorBanner error={backups.error} onRetry={() => void backups.reload()} />
                      </div>
                    ) : !backups.data ? (
                      <Spinner />
                    ) : (
                      <BackupTable
                        backups={backups.data}
                        can={can}
                        hideInstance
                        onChanged={() => {
                          void backups.reload();
                          api.instance(inst.id).then(onChanged, () => undefined);
                        }}
                      />
                    )}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </aside>
      {importing && inst && (
        <ImportDatabaseModal
          inst={inst}
          onClose={() => setImporting(false)}
          onDone={() => {
            void backups.reload();
            api.instance(inst.id).then(onChanged, () => undefined);
          }}
        />
      )}
    </div>
  );
}
