import { useMemo, useState } from 'react';
import { Archive, History, Trash2 } from 'lucide-react';
import { api, type Backup, type Instance, type Permission } from '../api';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Pill,
  Select,
  Spinner,
  Time,
  errorText,
  formatBytes,
  useConfirm,
  useResource,
  useToast,
} from '../components/ui';

const KIND_TONE: Record<Backup['kind'], 'blue' | 'amber' | 'slate'> = {
  manual: 'blue',
  'pre-delete': 'amber',
  'pre-restore': 'slate',
};

export function BackupTable({
  backups,
  can,
  hideInstance = false,
  onChanged,
}: {
  backups: Backup[];
  can: (p: Permission) => boolean;
  hideInstance?: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);

  const restore = async (b: Backup) => {
    const ok = await confirm({
      title: `Restore ${b.slug}?`,
      body: (
        <>
          <p>
            The instance's files and database are replaced with this backup from <b>{new Date(b.created_at).toLocaleString()}</b>.
            The bot is briefly offline while this runs.
          </p>
          <p className="text-slate-400">
            A <b>pre-restore</b> safety backup of the current state is taken first, so this can be undone.
          </p>
        </>
      ),
      confirmLabel: 'Restore backup',
      danger: true,
      typeToConfirm: b.slug,
    });
    if (!ok) return;
    setBusy(b.id);
    try {
      const res = await api.restoreBackup(b.id);
      toast.success(`${b.slug} restored. Safety backup: ${res.safety_backup_id}`);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const remove = async (b: Backup) => {
    const ok = await confirm({
      title: 'Delete backup?',
      body: (
        <p>
          <span className="font-mono">{b.filename}</span> ({formatBytes(b.size_bytes)}) is deleted from disk permanently.
        </p>
      ),
      confirmLabel: 'Delete backup',
      danger: true,
    });
    if (!ok) return;
    setBusy(b.id);
    try {
      await api.deleteBackup(b.id);
      toast.success('Backup deleted.');
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  if (backups.length === 0) {
    return (
      <EmptyState icon={<Archive className="w-7 h-7" />} title="No backups yet">
        Backups contain the bot's files, a database dump and a manifest. One is taken automatically before every delete
        and restore.
      </EmptyState>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[11px] text-slate-500 border-b border-slate-800">
            {!hideInstance && <th className="px-3 py-2 font-medium">Instance</th>}
            <th className="px-3 py-2 font-medium">Created</th>
            <th className="px-3 py-2 font-medium">Kind</th>
            <th className="px-3 py-2 font-medium text-right">Size</th>
            <th className="px-3 py-2 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/70">
          {backups.map((b) => (
            <tr key={b.id} className="hover:bg-slate-800/20">
              {!hideInstance && (
                <td className="px-3 py-2.5">
                  {b.instance_id ? (
                    <a href={`#/instances/${b.instance_id}`} className="font-mono text-white hover:text-blue-300">
                      {b.slug}
                    </a>
                  ) : (
                    <span className="font-mono text-slate-400" title="The instance was deleted">
                      {b.slug} <span className="text-[10px] text-slate-500">(deleted)</span>
                    </span>
                  )}
                </td>
              )}
              <td className="px-3 py-2.5 text-slate-300">
                <Time value={b.created_at} />
                <span className="block text-[10px] text-slate-600 font-mono" title={`SHA-256 ${b.sha256}`}>
                  {b.id}
                </span>
              </td>
              <td className="px-3 py-2.5">
                <Pill tone={KIND_TONE[b.kind]}>{b.kind}</Pill>
              </td>
              <td className="px-3 py-2.5 text-right font-mono text-slate-300">{formatBytes(b.size_bytes)}</td>
              <td className="px-3 py-2.5">
                <div className="flex justify-end gap-1.5">
                  {can('backups.restore') && (
                    <>
                      <Button
                        size="sm"
                        icon={<History className="w-3.5 h-3.5" />}
                        disabled={busy !== null || b.instance_id === null}
                        loading={busy === b.id}
                        title={b.instance_id === null ? 'Restoring into a deleted instance is not supported yet' : 'Restore'}
                        onClick={() => void restore(b)}
                      >
                        Restore
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-rose-400 hover:text-rose-300"
                        icon={<Trash2 className="w-3.5 h-3.5" />}
                        disabled={busy !== null}
                        title="Delete backup"
                        onClick={() => void remove(b)}
                      />
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BackupsPage({
  can,
  instances,
  onChanged,
}: {
  can: (p: Permission) => boolean;
  instances: Instance[];
  onChanged: () => void;
}) {
  const res = useResource(api.backups, []);
  const [slug, setSlug] = useState('all');
  const slugs = useMemo(() => [...new Set((res.data ?? []).map((b) => b.slug))].sort(), [res.data]);
  const visible = (res.data ?? []).filter((b) => slug === 'all' || b.slug === slug);
  const total = visible.reduce((sum, b) => sum + b.size_bytes, 0);

  return (
    <div>
      <PageHeader
        title="Backups"
        description={
          <>
            Stored on this server under <span className="font-mono">/opt/fleetbot/backups</span>. The newest manual backups
            per instance are kept; safety backups are never pruned automatically. Copy them off-site for disaster recovery.
          </>
        }
        actions={
          slugs.length > 1 && (
            <Select value={slug} onChange={(e) => setSlug(e.target.value)} className="w-44 text-xs">
              <option value="all">All instances</option>
              {slugs.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          )
        }
      />
      {res.error && (
        <div className="mb-4">
          <ErrorBanner error={res.error} onRetry={() => void res.reload()} />
        </div>
      )}
      {can('backups.create') && instances.length > 0 && (
        <p className="text-[11px] text-slate-500 mb-3">To take a new backup, open an instance and press Backup.</p>
      )}
      <Card className="overflow-hidden">
        {!res.data ? (
          res.loading ? <Spinner /> : null
        ) : (
          <BackupTable
            backups={visible}
            can={can}
            onChanged={() => {
              void res.reload();
              onChanged();
            }}
          />
        )}
      </Card>
      {visible.length > 0 && (
        <p className="text-[11px] text-slate-500 mt-2 font-mono">
          {visible.length} backup{visible.length > 1 ? 's' : ''} · {formatBytes(total)}
        </p>
      )}
    </div>
  );
}
